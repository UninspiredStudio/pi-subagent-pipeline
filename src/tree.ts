/**
 * Tree surfaces: inline tool rendering rows, the under-editor widget, and the overlay.
 * All rows are produced width-safe by plan.formatTreeRows and only then colored.
 */
import { matchesKey, type Component } from "@earendil-works/pi-tui";
import { formatTreeRows, totalUsage, type NodeState, type NodeStatus } from "./plan.ts";
import { getActive, stopNode } from "./run.ts";

const STATUS_COLOR: Record<NodeStatus, string> = {
  queued: "dim",
  running: "accent",
  ok: "success",
  blocked: "warning",
  failed: "error",
  escalated: "warning",
  recovered: "accent",
  stopped: "muted",
  cancelled: "muted",
  skipped: "dim",
};

export interface RowTheme {
  /** Theme token name, typed loosely so the platform Theme is assignable without re-exporting its token union. */
  fg: (token: any, text: string) => string;
}

export function colorizeRow(text: string, node: NodeState, theme: RowTheme): string {
  return theme.fg(STATUS_COLOR[node.status] ?? "text", text);
}

/** The plan summary shown for the `pipeline` tool call. */
export function renderPlanPreview(steps: Array<{ id: string; role: string; objective: string }>, width: number, theme: RowTheme): string[] {
  if (!steps?.length) return [theme.fg("muted", "pipeline: no steps")];
  const lines = [theme.fg("accent", `pipeline: ${steps.length} step(s)`) ];
  for (const step of steps) {
    const raw = `  ${step.id} · ${step.role} · ${step.objective ?? ""}`;
    lines.push(theme.fg("muted", raw.length <= width ? raw : `${raw.slice(0, Math.max(0, width - 1))}…`));
  }
  return lines;
}

export function renderResultLines(nodes: Record<string, NodeState>, width: number, theme: RowTheme, maxRows = 24): string[] {
  const active = getActive();
  const rows = formatTreeRows(nodes, { width, maxRows, decorate: (text, node) => colorizeRow(text, node, theme) });
  const usage = totalUsage(nodes);
  const summary = theme.fg("muted", `run ${active?.runId ?? "-"} · profile ${active?.profile ?? "-"} · ${usage.totalTokens} tok · $${usage.cost.toFixed(4)}`);
  return [...rows, summary];
}

/** One-line status for ctx.ui.setWidget. */
export class PipelineWidget implements Component {
  private cached?: { width: number; lines: string[] };
  constructor(private readonly theme: RowTheme) {}

  render(width: number): string[] {
    if (this.cached && this.cached.width === width) return this.cached.lines;
    const active = getActive();
    let line: string;
    if (!active) {
      line = this.theme.fg("dim", "no pipeline run");
    } else {
      const nodes = Object.values(active.nodes);
      const running = nodes.filter((node) => node.status === "running").length;
      const done = nodes.filter((node) => node.status === "ok").length;
      const usage = totalUsage(active.nodes);
      const head = this.theme.fg("accent", "▸ pipeline");
      const body = this.theme.fg("muted", `profile: ${active.profile} · ${running} running · ${done}/${nodes.length} ok · ${usage.totalTokens} tok`);
      line = `${head} ${body}`;
    }
    const lines = [line.length <= width ? line : line.slice(0, Math.max(0, width - 1))];
    this.cached = { width, lines };
    return lines;
  }

  invalidate(): void {
    this.cached = undefined;
  }
}

/**
 * Full-screen tree overlay. Enter shows the node's detail (status, verification, artifacts and the
 * tail of its output); x stops a node; Esc closes. Steering a live child is deliberately not offered.
 */
export class TreeOverlay implements Component {
  private cached?: { width: number; lines: string[] };
  private selected = 0;
  private detailFor?: string;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly tui: any,
    private readonly theme: RowTheme,
    private readonly done: (result: string) => void,
  ) {
    const active = getActive();
    if (active) {
      const listener = () => this.invalidateAndRender();
      active.listeners.add(listener);
      this.unsubscribe = () => active.listeners.delete(listener);
    } else {
      this.unsubscribe = () => {};
    }
  }

  private invalidateAndRender(): void {
    this.invalidate();
    this.tui?.requestRender?.();
  }

  private nodeIds(): string[] {
    const active = getActive();
    if (!active) return [];
    return Object.values(active.nodes).map((node) => node.id);
  }

  render(width: number): string[] {
    if (this.cached && this.cached.width === width) return this.cached.lines;
    const active = getActive();
    const lines: string[] = [];
    const title = this.detailFor ? ` pipeline · ${this.detailFor} ` : " pipeline ";
    lines.push(this.theme.fg("accent", title));

    if (!active) {
      lines.push(this.theme.fg("muted", "No active run. Start one with the pipeline tool."));
    } else if (this.detailFor) {
      const node = active.nodes[this.detailFor];
      if (!node) lines.push(this.theme.fg("error", "Unknown node."));
      else {
        const effort = node.thinking ? `:${node.thinking}` : "";
        lines.push(this.theme.fg("text", `${node.role} · ${node.model}${effort} · ${node.status}`));
        if (node.error) lines.push(this.theme.fg("error", `error: ${node.error}`));
        if (node.verification) {
          lines.push(this.theme.fg(node.verification.ok ? "success" : "warning", `verify: ${node.verification.command} (exit ${node.verification.exitCode})`));
        }
        if (node.artifacts.changedFiles.length) lines.push(this.theme.fg("muted", `changed: ${node.artifacts.changedFiles.join(", ")}`));
        for (const attempt of node.attempts) {
          lines.push(this.theme.fg("warning", `escalated ${attempt.source} → ${attempt.target}: ${attempt.reason}`));
        }
        lines.push(this.theme.fg("muted", node.outputPath ? `output: ${node.outputPath}` : "no output yet"));
        if (node.sessionFile) lines.push(this.theme.fg("muted", `transcript: ${node.sessionFile}`));
      }
    } else {
      const rows = formatTreeRows(active.nodes, {
        width,
        maxRows: Math.max(4, this.tui?.terminal?.rows ? this.tui.terminal.rows - 6 : 20),
        decorate: (text, node) => colorizeRow(text, node, this.theme),
      });
      rows.forEach((row, index) => lines.push(index === this.selected ? this.theme.fg("accent", `${row}`) : row));
      const usage = totalUsage(active.nodes);
      lines.push(this.theme.fg("muted", `↑↓ select · enter detail · x stop · esc close · ${usage.totalTokens} tok · $${usage.cost.toFixed(4)}`));
    }

    this.cached = { width, lines };
    return lines;
  }

  handleInput(data: string): void {
    const ids = this.nodeIds();
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      if (this.detailFor) {
        this.detailFor = undefined;
        this.invalidateAndRender();
        return;
      }
      this.done("closed");
      return;
    }
    if (this.detailFor) return;
    if (matchesKey(data, "up") || matchesKey(data, "k")) {
      this.selected = Math.max(0, this.selected - 1);
      this.invalidateAndRender();
      return;
    }
    if (matchesKey(data, "down") || matchesKey(data, "j")) {
      this.selected = Math.min(Math.max(0, ids.length - 1), this.selected + 1);
      this.invalidateAndRender();
      return;
    }
    if (matchesKey(data, "enter") || matchesKey(data, "return")) {
      this.detailFor = ids[this.selected];
      this.invalidateAndRender();
      return;
    }
    if (data === "x" || data === "X") {
      const id = ids[this.selected];
      if (id) {
        stopNode(id);
        this.invalidateAndRender();
      }
    }
  }

  invalidate(): void {
    this.cached = undefined;
  }

  dispose(): void {
    this.unsubscribe();
  }
}
