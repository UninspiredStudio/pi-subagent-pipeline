/**
 * Run directory: layout, persistence, retention and resume state.
 * fs only (no platform imports) so the retention algorithm is directly testable.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { NodeState, Step } from "./plan.ts";

export interface RunRound {
  round: number;
  profile: string;
  startedAt: number;
}

export interface RunState {
  runId: string;
  profile: string;
  profilePath?: string;
  steps: Step[];
  nodes: Record<string, NodeState>;
  rounds: RunRound[];
  createdAt: number;
  updatedAt: number;
  finished: boolean;
}

export interface RunSummary {
  runId: string;
  profile: string;
  createdAt: number;
  updatedAt: number;
  ok: number;
  total: number;
  finished: boolean;
}

export function runsRoot(agentDir: string): string {
  return join(agentDir, "pipeline", "runs");
}

export function newRunId(now: number, salt = Math.floor(Math.random() * 1e6)): string {
  return `run-${now.toString(36)}-${salt.toString(36)}`;
}

export function runDir(root: string, runId: string): string {
  return join(root, runId);
}

function ensure(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

export function writeRun(root: string, state: RunState): void {
  const dir = runDir(root, state.runId);
  ensure(dir);
  state.updatedAt = Date.now();
  writeFileSync(join(dir, "run.json"), `${JSON.stringify(state, null, 2)}\n`, "utf-8");
}

export function readRun(root: string, runId: string): RunState | undefined {
  const path = join(runDir(root, runId), "run.json");
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as any;
    if (!parsed || typeof parsed !== "object") return undefined;
    if (typeof parsed.runId !== "string" || !parsed.runId) return undefined;
    if (!parsed.nodes || typeof parsed.nodes !== "object" || Array.isArray(parsed.nodes)) return undefined;
    if (!Array.isArray(parsed.steps) || !Array.isArray(parsed.rounds)) return undefined;
    return parsed as RunState;
  } catch {
    return undefined;
  }
}

export function appendEvent(root: string, runId: string, event: Record<string, unknown>): void {
  const dir = runDir(root, runId);
  ensure(dir);
  appendFileSync(join(dir, "events.jsonl"), `${JSON.stringify({ at: Date.now(), ...event })}\n`, "utf-8");
}

export function writeNodeOutput(root: string, runId: string, nodeId: string, text: string): string {
  const dir = runDir(root, runId);
  ensure(dir);
  const path = join(dir, `node-${nodeId}.output.md`);
  writeFileSync(path, text, "utf-8");
  return path;
}

export function readNodeOutput(root: string, runId: string, nodeId: string): string | undefined {
  const path = join(runDir(root, runId), `node-${nodeId}.output.md`);
  return existsSync(path) ? readFileSync(path, "utf-8") : undefined;
}

export function summarise(state: RunState): RunSummary {
  const nodes = Object.values(state?.nodes ?? {});
  return {
    runId: state?.runId ?? "",
    profile: state?.profile ?? "",
    createdAt: state?.createdAt ?? 0,
    updatedAt: state?.updatedAt ?? 0,
    ok: nodes.filter((node) => node?.status === "ok").length,
    total: nodes.length,
    finished: Boolean(state?.finished),
  };
}

export function listRuns(root: string): RunSummary[] {
  if (!existsSync(root)) return [];
  const summaries: RunSummary[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      const state = readRun(root, entry.name);
      if (state) summaries.push(summarise(state));
    } catch {
      // one corrupt run directory must not hide every other run
    }
  }
  return summaries.sort((a, b) => b.updatedAt - a.updatedAt);
}

export interface PruneInput {
  runId: string;
  finished: boolean;
  updatedAt: number;
}

/**
 * Retention (rev 6): age-prune finished runs, count-prune finished runs, and only as a
 * last resort drop unfinished runs -- always reported, because that discards resumable work.
 */
export function planPrune(
  entries: PruneInput[],
  opts: { keep: number; maxAgeDays: number; now: number; pinUnfinished: boolean },
): { drop: string[]; pinned: string[] } {
  const cutoff = opts.now - opts.maxAgeDays * 24 * 60 * 60 * 1000;
  const drop = new Set<string>();
  const pinned: string[] = [];

  const finished = entries.filter((entry) => entry.finished).sort((a, b) => a.updatedAt - b.updatedAt);
  const unfinished = entries.filter((entry) => !entry.finished).sort((a, b) => a.updatedAt - b.updatedAt);
  if (opts.pinUnfinished) pinned.push(...unfinished.map((entry) => entry.runId));

  // When unfinished runs are not pinned, they age out like finished ones.
  for (const entry of opts.pinUnfinished ? finished : entries) {
    if (entry.updatedAt < cutoff) drop.add(entry.runId);
  }

  const remaining = entries.length - drop.size;
  if (remaining > opts.keep) {
    let over = remaining - opts.keep;
    for (const entry of finished) {
      if (over <= 0) break;
      if (drop.has(entry.runId)) continue;
      drop.add(entry.runId);
      over -= 1;
    }
    for (const entry of unfinished) {
      if (over <= 0) break;
      if (drop.has(entry.runId)) continue;
      drop.add(entry.runId);
      over -= 1;
    }
  }

  return { drop: [...drop], pinned };
}

export function pruneRuns(
  root: string,
  opts: { keep: number; maxAgeDays: number; pinUnfinished: boolean; now?: number },
): { dropped: string[]; pinned: string[] } {
  const entries: PruneInput[] = listRuns(root).map((summary) => ({
    runId: summary.runId,
    finished: summary.finished,
    updatedAt: summary.updatedAt,
  }));
  const { drop, pinned } = planPrune(entries, { ...opts, now: opts.now ?? Date.now() });
  for (const runId of drop) {
    try {
      rmSync(runDir(root, runId), { recursive: true, force: true });
    } catch {
      // a locked or already-removed directory is not worth failing a session start over
    }
  }
  return { dropped: drop, pinned };
}

export function runDirSize(root: string): { bytes: number; runs: number } {
  if (!existsSync(root)) return { bytes: 0, runs: 0 };
  let bytes = 0;
  let runs = 0;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    runs += 1;
    const dir = join(root, entry.name);
    for (const file of readdirSync(dir)) {
      try {
        bytes += statSync(join(dir, file)).size;
      } catch {
        // ignore
      }
    }
  }
  return { bytes, runs };
}

export function formatRunList(summaries: RunSummary[]): string[] {
  if (!summaries.length) return ["No runs recorded."];
  return summaries.map((summary) => {
    const when = new Date(summary.updatedAt).toISOString().replace("T", " ").slice(0, 19);
    const state = summary.finished ? "finished" : "RESUMABLE";
    return `${summary.runId}  ${summary.ok}/${summary.total} ok  ${summary.profile}  ${state}  ${when}`;
  });
}
