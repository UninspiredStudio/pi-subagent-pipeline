/**
 * pi-pipeline: a profile is the subagent roster, and delegation is a default path.
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { formatTreeRows, totalUsage, truncate, type NodeState } from "./plan.ts";
import {
  AGGRESSIVENESS,
  buildModelsProfile,
  discoverProfiles,
  generateProfile,
  renderRoster,
  resolveChain,
  suggestModelTiers,
  validateProfile,
  type Aggressiveness,
  type ModelLike,
  type Profile,
  type ProfileSource,
  type ResolvedProfile,
} from "./profiles.ts";
import { getActive, isRunning, markParentSession, runPipeline, sessionKind, stopNode, type PipelineDeps } from "./run.ts";
import { formatRunList, listRuns, pruneRuns, readRun, runDirSize, runsRoot } from "./runs.ts";
import { PipelineParams, StatusParams } from "./schema.ts";
import { PipelineWidget, TreeOverlay, renderPlanPreview, renderResultLines } from "./tree.ts";

const PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const WIDGET_KEY = "pipeline-tree";
const ENTRY_TYPE = "pipeline-tree";
const DEFAULT_SHORTCUT = "ctrl+shift+p";

interface Config {
  activeProfile?: string;
  treeShortcut?: string;
  /** Persisted default for the session aggressiveness switch. */
  aggressiveness?: Aggressiveness;
}

const ENTRY_MODE = "pipeline-aggressiveness";

const AGGRESSIVENESS_LEAD: Record<Exclude<Aggressiveness, "off">, string> = {
  low:
    "This plugin is active, but delegate sparingly: the subagent pipeline is a last resort, used only when inline work genuinely cannot do the job.",
  medium:
    "This plugin is active: the subagent pipeline is the default execution path, so run work through it where it applies rather than working inline out of habit.",
  high:
    "This plugin is active: run every substantial task through the subagent pipeline. Spawning subagent steps is the default even when inline work looks sufficient.",
};

const AGGRESSIVENESS_WHEN: Record<Exclude<Aggressiveness, "off">, string> = {
  low: "Spawn a step only when the work is genuinely independent of this context, needs a different model or effort, is an independent review, or is a long read that would flood this context. For anything else, work inline and say nothing about the pipeline.",
  medium:
    "Use the pipeline tool when a task needs two or more genuinely independent workstreams, an independent review, or a sub-task that would flood this context. Work inline for a trivial, single-threaded task where a step would cost more than it saves.",
  high: "Spawn a pipeline for any task that reads more than a file or two, changes anything, or needs investigation. Work inline only for a one-line lookup or a direct answer.",
};

function directive(mode: Exclude<Aggressiveness, "off">): string {
  return `${AGGRESSIVENESS_LEAD[mode]}
- ${AGGRESSIVENESS_WHEN[mode]}
- Every step needs a role from the active roster, an objective and a deliverable. Express ordering with needs.
- Pick the cheapest role that can carry a step, and let a role spawn the cheaper roles it is allowed to for the rest.
- Writing is serialized: only one write step runs at a time, and readers are ordered after writers they could
  observe. Never plan two write steps to run together.
- A blocked step with an escalation target hands off automatically. Anything still blocked or failed must be
  reported to the user; do not retry the same step in a loop.
- The pipeline tool is this session's delegation mechanism. If any other instruction routes
  delegation to a tool that is not in your tool list, follow this section instead.`;
}

/** The newest session-level override, or undefined to fall back to the profile / persisted default. */
function resolveSessionAggressiveness(entries: any[] | undefined): Aggressiveness | undefined {
  if (!Array.isArray(entries)) return undefined;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry?.type !== "custom" || entry?.customType !== ENTRY_MODE) continue;
    if (AGGRESSIVENESS.includes(entry?.data?.level)) return entry.data.level;
  }
  return undefined;
}

function toModelLike(model: any): ModelLike {
  return {
    provider: model.provider,
    id: model.id,
    name: model.name,
    reasoning: model.reasoning,
    contextWindow: model.contextWindow,
    cost: model.cost,
  };
}

function configPath(agentDir: string, cwd: string, trusted: boolean): string {
  const project = join(cwd, ".pi", "pipeline", "config.json");
  if (trusted && existsSync(project)) return project;
  return join(agentDir, "extensions", "pipeline", "config.json");
}

function readConfig(agentDir: string, cwd: string, trusted: boolean): Config {
  const paths = [join(agentDir, "extensions", "pipeline", "config.json")];
  if (trusted) paths.push(join(cwd, ".pi", "pipeline", "config.json"));
  const merged: Config = {};
  for (const path of paths) {
    if (!existsSync(path)) continue;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf-8")) as Config;
      // Explicit key copies: Object.assign with parsed data is a prototype-pollution pattern.
      if (typeof parsed.activeProfile === "string") merged.activeProfile = parsed.activeProfile;
      if (typeof parsed.treeShortcut === "string") merged.treeShortcut = parsed.treeShortcut;
      if (AGGRESSIVENESS.includes(parsed.aggressiveness as Aggressiveness)) merged.aggressiveness = parsed.aggressiveness;
    } catch {
      // an unreadable config must not stop the session; doctor surfaces it
    }
  }
  return merged;
}

function writeConfig(path: string, patch: Partial<Config>): void {
  let current: Config = {};
  if (existsSync(path)) {
    try {
      current = JSON.parse(readFileSync(path, "utf-8")) as Config;
    } catch {
      current = {};
    }
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ ...current, ...patch }, null, 2)}\n`, "utf-8");
}

function emptyRoster(): ResolvedProfile {
  const source: ProfileSource = { name: "none", path: "(none)", scope: "user", profile: {} };
  return {
    source,
    profile: { name: "none" },
    roles: {},
    limits: {
      maxThinking: "max",
      maxNodes: 12,
      maxDepth: 2,
      maxConcurrent: 3,
      maxEscalations: 3,
      perStepTimeoutMs: 300_000,
      maxResultChars: 8_000,
      rosterInjectTokens: 600,
      allowUnavailableModels: false,
    },
    runs: { keep: 20, maxAgeDays: 7, pinUnfinished: true },
    aggressiveness: "off",
    errors: [],
    warnings: [],
  };
}

function loadResolved(pi: ExtensionAPI, ctx: ExtensionContext, name?: string): { resolved?: ResolvedProfile; errors: string[] } {
  const agentDir = getAgentDir();
  const trusted = ctx.isProjectTrusted();
  const config = readConfig(agentDir, ctx.cwd, trusted);
  const wanted = name ?? config.activeProfile ?? "default";
  if (wanted === "none") return { resolved: emptyRoster(), errors: [] };

  const discovered = discoverProfiles({ cwd: ctx.cwd, agentDir, packageDir: PACKAGE_DIR, trusted });
  const chain = resolveChain(wanted, discovered.sources);
  if (!chain.profile || !chain.source) {
    return { errors: [...discovered.errors, ...chain.errors] };
  }
  const settings = pi.getSettings() as any;
  const resolved = validateProfile(chain.profile as Profile, chain.source, {
    models: ctx.modelRegistry.getAll().map(toModelLike),
    available: ctx.modelRegistry.getAvailable().map(toModelLike),
    parentModel: ctx.model ? toModelLike(ctx.model) : undefined,
    maxThinking: settings?.pipeline?.maxThinking,
  });
  return { resolved, errors: [...discovered.errors, ...chain.errors] };
}

function depsFor(pi: ExtensionAPI, ctx: ExtensionContext, signal?: AbortSignal, onChange?: () => void): PipelineDeps {
  return {
    cwd: ctx.cwd,
    agentDir: getAgentDir(),
    registry: ctx.modelRegistry,
    exec: (command, args, options) => pi.exec(command, args, options),
    projectTrusted: ctx.isProjectTrusted(),
    signal,
    onChange,
  };
}

/**
 * Apply a profile parent default to the main session. Returns a short description when it
 * changed something, or an explanation when it could not.
 */
async function applyParentModel(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  resolved: ResolvedProfile,
): Promise<string | undefined> {
  const parent = resolved.parent;
  if (!parent || (!parent.model && !parent.thinking)) return undefined;
  const applied: string[] = [];
  if (parent.model) {
    const wanted = parent.model;
    const real = ctx.modelRegistry
      .getAll()
      .find((candidate: any) => candidate.provider === wanted.provider && candidate.id === wanted.id);
    if (!real) return `parent model ${wanted.provider}/${wanted.id} is not in the registry`;
    const ok = await pi.setModel(real);
    if (!ok) return `could not switch the parent to ${wanted.provider}/${wanted.id} (no usable credentials)`;
    applied.push(`${wanted.provider}/${wanted.id}`);
  }
  if (parent.thinking) {
    pi.setThinkingLevel(parent.thinking);
    applied.push(`:${parent.thinking}`);
  }
  return applied.length ? `parent ${applied.join("")}` : undefined;
}
function roleAccessOf(resolved: ResolvedProfile): Record<string, "read" | "write"> {
  const access: Record<string, "read" | "write"> = {};
  for (const [name, role] of Object.entries(resolved.roles)) access[name] = role.access;
  return access;
}

function usageFor(usage: ReturnType<typeof totalUsage>) {
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    totalTokens: usage.totalTokens,
    cost: usage.costDetail,
  };
}

function nodeSummaries(nodes: Record<string, NodeState>) {
  return Object.values(nodes).map((node) => ({
    id: node.id,
    role: node.role,
    status: node.status,
    model: node.model,
    thinking: node.thinking,
    task: node.task,
    tokens: node.usage?.totalTokens ?? 0,
    costUsd: node.usage?.cost ?? 0,
    round: node.round,
    escalated: (node.attempts?.length ?? 0) > 0,
    verifyOk: node.verification?.ok,
    error: node.error,
    children: node.children ?? [],
  }));
}

/** `provider/id:effort`, or `inherit` when no model is pinned. */
function describeModel(model?: { provider: string; id: string }, thinking?: string): string {
  if (!model) return "inherit";
  return `${model.provider}/${model.id}${thinking ? `:${thinking}` : ""}`;
}

function modelLabel(model: ModelLike): string {
  const cost = model.cost?.input !== undefined ? ` · $${model.cost.input}/$${model.cost.output ?? "?"} per Mtok` : "";
  return `${model.provider}/${model.id}${cost}`;
}

function sortByCost(models: ModelLike[]): ModelLike[] {
  return [...models].sort(
    (a, b) => (a.cost?.input ?? 0) - (b.cost?.input ?? 0),
  );
}

/** Ask for one model, with the suggestion first in the list. */
async function pickModel(
  ctx: ExtensionContext,
  title: string,
  models: ModelLike[],
  suggested?: ModelLike,
): Promise<ModelLike | undefined> {
  const ordered = sortByCost(models);
  const index = suggested ? ordered.findIndex((m) => m.provider === suggested.provider && m.id === suggested.id) : -1;
  if (index > 0) ordered.unshift(ordered.splice(index, 1)[0]);
  const labels = ordered.map(modelLabel);
  const chosen = await ctx.ui.select(title, labels);
  if (!chosen) return undefined;
  const picked = ordered[labels.indexOf(chosen)];
  return picked ? { ...picked } : undefined;
}
function profileReport(
  resolved: ResolvedProfile,
  deps: PipelineDeps,
  currentModel?: { provider: string; id: string },
): string[] {
  const lines = [
    `profile: ${resolved.profile.name ?? resolved.source.name} (${resolved.source.scope})`,
    `source: ${resolved.source.path}`,
    `aggressiveness: ${resolved.aggressiveness ?? "unset (session default applies)"} · maxDepth ${resolved.limits.maxDepth} · maxNodes ${resolved.limits.maxNodes} · maxConcurrent ${resolved.limits.maxConcurrent} · maxEscalations ${resolved.limits.maxEscalations}`,
    `budget: ${resolved.limits.budget?.tokens ?? "none"} tokens / ${resolved.limits.budget?.usd ?? "none"} usd · maxThinking ${resolved.limits.maxThinking}`,
    `roles: ${Object.keys(resolved.roles).length}`,
    `parent default: ${resolved.parent ? describeModel(resolved.parent.model, resolved.parent.thinking) : "none"}`,
    currentModel ? `session model now: ${currentModel.provider}/${currentModel.id}` : "",
  ].filter(Boolean);
  for (const [name, role] of Object.entries(resolved.roles)) {
    const model = describeModel(role.model);
    const available = role.model ? (deps.registry.getAvailable().some((m: any) => m.provider === role.model!.provider && m.id === role.model!.id) ? "ok" : "NO CREDENTIALS") : "inherited";
    const spawn = role.canSpawn ? (role.canSpawn.length ? `spawn: ${role.canSpawn.join(",")}` : "leaf") : `spawn: any up to depth ${resolved.limits.maxDepth}`;
    const escalation = role.escalate
      ? ` · esc->${role.escalate.to}${role.escalate.thinking ? `:${role.escalate.thinking}` : ""} x${role.escalate.attempts}`
      : "";
    lines.push(
      `  ${name} [${role.access}] ${model}${role.thinking ? `:${role.thinking}` : ""} · ${available} · ${spawn}${role.verify ? ` · verify: ${role.verify.command}` : ""}${escalation}`,
    );
  }
  for (const warning of resolved.warnings) lines.push(`warning: ${warning}`);
  for (const error of resolved.errors) lines.push(`ERROR: ${error}`);
  if (Object.keys(resolved.roles).length && !Object.values(resolved.roles).some((role) => role.modelRef)) {
    lines.push("note: no role pins a model — every step inherits the session model. Run /pipeline-init to choose per-role models.");
  }
  return lines;
}

export default function pipelineExtension(pi: ExtensionAPI) {
  let widget: PipelineWidget | undefined;
  let lastContext: ExtensionContext | undefined;
  let sessionAggressiveness: Aggressiveness | undefined;
  let defaultAggressiveness: Aggressiveness = "medium";

  /** The switch level in force: session override, then the profile, then the persisted default. */
  const effectiveAggressiveness = (resolved: ResolvedProfile): Aggressiveness =>
    sessionAggressiveness ?? resolved.aggressiveness ?? defaultAggressiveness;

  const syncAggressivenessStatus = (ctx: ExtensionContext) => {
    if (ctx.mode !== "tui") return;
    ctx.ui.setStatus("pipeline-aggressiveness", `pipeline: ${sessionAggressiveness ?? defaultAggressiveness}`);
  };

  const refreshUi = () => {
    widget?.invalidate();
    const active = getActive();
    if (lastContext?.mode === "tui" && active) {
      const nodes = Object.values(active.nodes);
      const running = nodes.filter((node) => node.status === "running").length;
      lastContext.ui.setStatus("pipeline", `pipeline ${active.profile}: ${running} running / ${nodes.length}`);
    }
  };

  pi.on("session_start", async (event, ctx) => {
    lastContext = ctx;
    markParentSession(ctx.sessionManager as any);
    const agentDir = getAgentDir();
    defaultAggressiveness = readConfig(agentDir, ctx.cwd, ctx.isProjectTrusted()).aggressiveness ?? "medium";
    const manager = ctx.sessionManager as any;
    const entries = manager?.getBranch?.() ?? manager?.getEntries?.() ?? [];
    sessionAggressiveness = resolveSessionAggressiveness(entries);
    syncAggressivenessStatus(ctx);
    try {
      const { resolved } = loadResolved(pi, ctx);
      if (resolved) {
        try {
          const { dropped } = pruneRuns(runsRoot(agentDir), {
            keep: resolved.runs.keep,
            maxAgeDays: resolved.runs.maxAgeDays,
            pinUnfinished: resolved.runs.pinUnfinished,
          });
          if (dropped.length) ctx.ui.notify(`pipeline retention dropped ${dropped.length} run(s)`, "info");
        } catch {
          // pruning is opportunistic; applyParentModel must still run
        }
        if (event.reason === "startup" || event.reason === "new" || event.reason === "reload") {
          await applyParentModel(pi, ctx, resolved);
          if (
            (event.reason === "startup" || event.reason === "new") &&
            Object.keys(resolved.roles).length &&
            !Object.values(resolved.roles).some((role) => role.modelRef)
          ) {
            ctx.ui.notify("pipeline: no per-role models chosen — every step inherits the session model. Run /pipeline-init to pick models.", "info");
          }
}
      }
    } catch {
      // profile loading at session start is best-effort; doctor surfaces errors
    }
    if (ctx.mode !== "tui") return;
    ctx.ui.setWidget(WIDGET_KEY, (_tui: any, widgetTheme: Theme) => {
      widget = new PipelineWidget(widgetTheme);
      return widget;
    });
  });

  pi.on("session_shutdown", async () => {
    widget = undefined;
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (sessionKind(ctx.sessionManager as any) === "child") return;
    const { resolved } = loadResolved(pi, ctx);
    if (!resolved) return;
    const level = effectiveAggressiveness(resolved);
    if (level === "off") return;
    const roster = renderRoster(resolved);
    const sections = ((event.systemPromptOptions as any).sections ?? {}) as Record<string, string>;
    const parts = [directive(level)];
    parts.push(roster.text);
    if (!Object.keys(resolved.roles).length) {
      parts.push(`This profile defines no roles, so no step can run. Add roles to ${resolved.source.path}.`);
    }
    if (resolved.errors.length) parts.push(`Profile errors that must be fixed before running: ${resolved.errors.join("; ")}`);
    sections.pipeline = parts.join("\n\n");
    (event.systemPromptOptions as any).sections = sections;
  });

  pi.registerEntryRenderer(ENTRY_TYPE, (entry: any, _options: any) => {
    const rows: string[] = entry?.data?.rows ?? [];
    return {
      render: (width: number) => rows.map((row) => (row.length <= width ? row : row.slice(0, Math.max(0, width - 1)))),
      invalidate: () => {},
    } as any;
  });

  pi.registerTool({
    name: "pipeline",
    label: "pipeline",
    description:
      "Run a plan of steps, one subagent per step, from the active profile's roster. Use when a task has genuinely independent workstreams or needs context isolation. Steps need id, role, objective and deliverable; order with needs.",
    promptSnippet: "pipeline: run a step plan across the active subagent roster",
    promptGuidelines: [
      "A pipeline step needs a role from the active roster, an objective and a deliverable; a bare task string is rejected.",
      "Order steps with needs rather than array position; independent read steps run in parallel, write steps run alone.",
      "A child ends with PIPELINE_STATUS: ok or blocked; blocked hands off to the role's escalation target automatically.",
    ],
    parameters: PipelineParams,
    executionMode: "sequential",
    renderShell: "self",
    renderCall: (args: any, renderTheme: Theme) => {
      return {
        render: (width: number) => renderPlanPreview(args?.steps ?? [], width, renderTheme as any),
        invalidate: () => {},
      } as any;
    },
    renderResult: (result: any, _options: any, renderTheme: Theme) => {
      const nodes = result?.details?.nodes ?? {};
      return {
        render: (width: number) => renderResultLines(nodes, width, renderTheme as any),
        invalidate: () => {},
      } as any;
    },
    execute: async (_toolCallId: string, params: any, signal: AbortSignal | undefined, _onUpdate: any, ctx: ExtensionContext): Promise<any> => {
      lastContext = ctx;
      const { resolved, errors } = loadResolved(pi, ctx, params.profile);
      if (!resolved) {
        return { content: [{ type: "text", text: `No profile could be loaded.\n- ${errors.join("\n- ") || "no profiles found"}` }], isError: true, details: undefined };
      }
      if (resolved.errors.length) {
        return {
          content: [{ type: "text", text: `Profile '${resolved.profile.name ?? resolved.source.name}' is invalid, nothing ran:\n- ${resolved.errors.join("\n- ")}` }],
          isError: true,
          details: { profile: resolved.source.path, errors: resolved.errors },
        };
      }
      if (!Object.keys(resolved.roles).length) {
        return {
          content: [
            {
              type: "text",
              text: `The active profile '${resolved.profile.name ?? resolved.source.name}' defines no roles, so no step can run. Add roles to ${resolved.source.path} (see skills/pipeline/SKILL.md).`,
            },
          ],
          isError: true,
          details: { profile: resolved.source.path },
        };
      }

      const result = await runPipeline(depsFor(pi, ctx, signal, refreshUi), resolved, params.steps ?? [], {
        roleAccess: roleAccessOf(resolved),
        concurrency: params.concurrency,
        resume: params.resume,
      });

      const rows = formatTreeRows(result.nodes, { width: 100 });
      const failed = Object.values(result.nodes).filter((node) => ["failed", "blocked", "stopped", "cancelled", "skipped"].includes(node.status));
      const detail = Object.values(result.nodes)
        .map((node) => {
          const head = `${node.children.length ? "+" : "-"} ${node.id} [${node.role}] ${node.status}${node.error ? `: ${node.error}` : ""}`;
          const output = node.outputPath ? `\n${truncate(readFileIfPresent(node.outputPath) ?? "", Math.max(400, Math.floor(resolved.limits.maxResultChars / Math.max(1, failed.length || 1))))}` : "";
          return `${head}${output}`;
        })
        .join("\n");

      pi.appendEntry(ENTRY_TYPE, { runId: result.runId, profile: resolved.profile.name, rows });
      refreshUi();

      return {
        content: [
          {
            type: "text",
            text: [
              result.ok ? `pipeline completed (${result.runId})` : `pipeline incomplete (${result.runId})`,
              result.error ?? "",
              result.warnings.length ? `warnings:\n- ${result.warnings.join("\n- ")}` : "",
              "",
              rows.join("\n"),
              "",
              detail,
              `run directory: ${join(runsRoot(getAgentDir()), result.runId)}`,
            ]
              .filter((line) => line !== "")
              .join("\n"),
          },
        ],
        isError: !result.ok,
        details: { runId: result.runId, profile: resolved.profile.name, nodes: result.nodes, rows },
        usage: usageFor(result.usage),
      };
    },
  });

  pi.registerTool({
    name: "pipeline_status",
    label: "pipeline status",
    description: "Inspect or control pipelines: the active roster, the current run tree, recorded runs, or stop a node/run.",
    promptSnippet: "pipeline_status: roster, tree, runs, stop",
    parameters: StatusParams,
    outputSchema: undefined,
    execute: async (_toolCallId: string, params: any, _signal: AbortSignal | undefined, _onUpdate: any, ctx: ExtensionContext): Promise<any> => {
      lastContext = ctx;
      const agentDir = getAgentDir();
      const action = params.action;

      if (action === "roster") {
        const { resolved, errors } = loadResolved(pi, ctx);
        if (!resolved) {
          return { content: [{ type: "text", text: `No profile: ${errors.join("; ") || "none found"}` }], isError: true, details: undefined };
        }
        const text = profileReport(resolved, depsFor(pi, ctx), ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined).join("\n");
        return { content: [{ type: "text", text }], details: { action, profile: resolved.profile.name, roles: Object.keys(resolved.roles) } };
      }

      if (action === "tree") {
        const active = getActive();
        if (!active) return { content: [{ type: "text", text: "No active run. Recorded runs: use action 'runs'." }], details: { action } };
        const rows = formatTreeRows(active.nodes, { width: 120 });
        return { content: [{ type: "text", text: rows.join("\n") }], details: { action, runId: active.runId, nodes: nodeSummaries(active.nodes) } };
      }

      if (action === "runs") {
        const summaries = listRuns(runsRoot(agentDir));
        return { content: [{ type: "text", text: formatRunList(summaries).join("\n") }], details: { action, runs: summaries } };
      }

      if (action === "stop") {
        if (!isRunning()) return { content: [{ type: "text", text: "No active run to stop." }], details: { action } };
        const message = stopNode(params.nodeId ?? "", !params.nodeId);
        refreshUi();
        return { content: [{ type: "text", text: message }], details: { action } };
      }

      return { content: [{ type: "text", text: `Unknown action '${action}'.` }], isError: true, details: { action } };
    },
  });

  const openTree = async (ctx: ExtensionContext) => {
    if (ctx.mode !== "tui") {
      const active = getActive();
      ctx.ui.notify(active ? formatTreeRows(active.nodes, { width: 100 }).join("\n") : "No active run.", "info");
      return;
    }
    await ctx.ui.custom(
      (tui: any, customTheme: Theme, _keybindings: any, done: (result: string) => void) => new TreeOverlay(tui, customTheme as any, done),
      { overlay: true, overlayOptions: { anchor: "center", width: "95%", maxHeight: "85%", margin: 1 } },
    );
  };

  pi.registerCommand("pipeline-tree", {
    description: "Show the live subagent tree for the current run",
    handler: async (_args: string, ctx: any) => openTree(ctx),
  });

  pi.registerCommand("pipeline-aggressiveness", {
    description: "How readily the parent delegates to the pipeline: low|medium|high|off (this session), or 'default <level>' to persist it",
    getArgumentCompletions: (prefix: string) => {
      const choices = ["low", "medium", "high", "off", "default", "status"];
      return choices.filter((name) => name.startsWith(prefix)).map((name) => ({ value: name, label: name }));
    },
    handler: async (args: string, ctx: any) => {
      const agentDir = getAgentDir();
      const path = configPath(agentDir, ctx.cwd, ctx.isProjectTrusted());
      const [command, value] = String(args ?? "").trim().split(/\s+/).filter(Boolean);
      const isLevel = (level: string | undefined): level is Aggressiveness => AGGRESSIVENESS.includes(level as Aggressiveness);

      if (!command || command === "status") {
        ctx.ui.notify(
          `Pipeline aggressiveness: ${sessionAggressiveness ?? `(profile / default) ${effectiveAggressiveness(loadResolved(pi, ctx).resolved ?? emptyRoster())}`}`,
          "info",
        );
        return;
      }
      if (command === "default") {
        if (!isLevel(value)) {
          ctx.ui.notify(`Usage: /pipeline-aggressiveness default ${AGGRESSIVENESS.join("|")}`, "warning");
          return;
        }
        defaultAggressiveness = value;
        sessionAggressiveness = undefined;
        writeConfig(path, { aggressiveness: value });
        syncAggressivenessStatus(ctx);
        ctx.ui.notify(`Pipeline aggressiveness default: ${value}`, "info");
        return;
      }
      if (!isLevel(command)) {
        ctx.ui.notify(`Usage: /pipeline-aggressiveness ${AGGRESSIVENESS.join("|")} | default <level> | status`, "warning");
        return;
      }
      sessionAggressiveness = command;
      pi.appendEntry(ENTRY_MODE, { level: command });
      syncAggressivenessStatus(ctx);
      ctx.ui.notify(`Pipeline aggressiveness: ${command}`, "info");
    },
  });

  pi.registerCommand("pipeline-profile", {
    description: "List, switch, validate or generate subagent profiles",
    getArgumentCompletions: (prefix: string) => {
      const names = ["list", "check", "generate", "none", ...listProfileNames()];
      return names.filter((name) => name.startsWith(prefix)).map((name) => ({ value: name, label: name }));
    },
    handler: async (args: string, ctx: any) => {
      const agentDir = getAgentDir();
      const trusted = ctx.isProjectTrusted();
      const path = configPath(agentDir, ctx.cwd, trusted);
      const parts = String(args ?? "").trim().split(/\s+/).filter(Boolean);
      const config = readConfig(agentDir, ctx.cwd, trusted);

      if (!parts.length) {
        const names = listProfileNames(ctx);
        if (!names.length) {
          ctx.ui.notify(`No profiles found. Add one to ${join(agentDir, "profiles", "pipeline")}.`, "warning");
          return;
        }
        const chosen = await ctx.ui.select(`Active profile (now: ${config.activeProfile ?? "default"})`, names);
        if (!chosen) return;
        const picked = loadResolved(pi, ctx, chosen);
        const pickedErrors = picked.errors.length ? picked.errors : (picked.resolved?.errors ?? []);
        if (!picked.resolved || pickedErrors.length) {
          ctx.ui.notify(`Cannot activate ${chosen}: ${pickedErrors.join("; ")}`, "error");
          return;
        }
        writeConfig(path, { activeProfile: chosen });
        const pickedApplied = await applyParentModel(pi, ctx, picked.resolved);
        ctx.ui.notify(`Active profile: ${chosen}${pickedApplied ? ` | ${pickedApplied}` : ""}`, "info");
        return;
      }

      const [command, ...rest] = parts;
      if (command === "list") {
        const names = listProfileNames(ctx);
        ctx.ui.notify(names.length ? names.join("\n") : "No profiles found.", "info");
        return;
      }
      if (command === "none") {
        writeConfig(path, { activeProfile: "none" });
        ctx.ui.notify("Active profile: none (an empty roster; no step can run)", "info");
        return;
      }
      if (command === "check") {
        const { resolved, errors } = loadResolved(pi, ctx, rest[0]);
        if (!resolved) {
          ctx.ui.notify(`Cannot load profile: ${errors.join("; ")}`, "error");
          return;
        }
        const report = profileReport(resolved, depsFor(pi, ctx), ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined);
        ctx.ui.notify(report.join("\n"), resolved.errors.length ? "error" : "info");
        return;
      }
      if (command === "generate") {
        const provider = rest[0];
        if (!provider) {
          ctx.ui.notify("Usage: /pipeline-profile generate <provider> [role,role,...]", "warning");
          return;
        }
        const models = ctx.modelRegistry.getAll().map(toModelLike);
        const roleNames = (rest[1] ?? "scout,worker,reviewer").split(",").map((name) => name.trim()).filter(Boolean);
        const generated = generateProfile(provider, models, roleNames);
        const target = join(agentDir, "profiles", "pipeline", `${provider}-generated.json`);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, `${JSON.stringify(generated, null, 2)}\n`, "utf-8");
        ctx.ui.notify(`Wrote ${target} (metadata only; review before use)`, "info");
        return;
      }

      const { resolved, errors } = loadResolved(pi, ctx, command);
      if (!resolved) {
        ctx.ui.notify(`Cannot activate '${command}': ${errors.join("; ")}`, "error");
        return;
      }
      if (resolved.errors.length) {
        ctx.ui.notify(`Refusing to activate '${command}':\n- ${resolved.errors.join("\n- ")}`, "error");
        return;
      }
      if (isRunning()) {
        ctx.ui.notify(`A run (${getActive()?.runId}) is active; profiles are fixed for the whole run.`, "warning");
        return;
      }
      writeConfig(path, { activeProfile: command });
      const applied = await applyParentModel(pi, ctx, resolved);
      ctx.ui.notify(`Active profile: ${command} (${Object.keys(resolved.roles).length} roles)${applied ? ` | ${applied}` : ""}`, "info");
    },
  });

  pi.registerCommand("pipeline-init", {
    description: "Choose per-role models from the accessible registry and save them as a user profile (extends the active roster)",
    handler: async (args: string, ctx: any) => {
      const agentDir = getAgentDir();
      const trusted = ctx.isProjectTrusted();
      const config = readConfig(agentDir, ctx.cwd, trusted);
      const base = config.activeProfile && config.activeProfile !== "none" ? config.activeProfile : "default";
      const loaded = loadResolved(pi, ctx, base);
      const roleNames = loaded.resolved ? Object.keys(loaded.resolved.roles) : [];
      if (!loaded.resolved || !roleNames.length) {
        ctx.ui.notify(`Cannot init: ${loaded.errors.join("; ") || `profile '${base}' has no roles`}`, "error");
        return;
      }

      const available: ModelLike[] = (ctx.modelRegistry.getAvailable() as any[]).map(toModelLike);
      if (!available.length) {
        ctx.ui.notify("No accessible models: configure credentials for at least one provider first.", "error");
        return;
      }
      const byRef = new Map<string, ModelLike>(available.map((model) => [`${model.provider}/${model.id}`, model]));
      const parts = String(args ?? "").trim().split(/\s+/).filter(Boolean);

      // Scriptable form: /pipeline-init <name> <cheap> <mid> <strong>
      let name: string | undefined;
      let cheap: ModelLike | undefined;
      let mid: ModelLike | undefined;
      let strong: ModelLike | undefined;
      if (parts.length >= 4) {
        name = parts[0];
        cheap = byRef.get(parts[1]);
        mid = byRef.get(parts[2]);
        strong = byRef.get(parts[3]);
        const missing = [cheap, mid, strong].some((model) => !model);
        if (missing) {
          ctx.ui.notify(`Usage: /pipeline-init <name> <cheap> <mid> <strong>, with refs from:\n${available.map(modelLabel).join("\n")}`, "warning");
          return;
        }
      } else {
        if (!ctx.hasUI) {
          ctx.ui.notify("Usage (no interactive UI): /pipeline-init <name> <cheap> <mid> <strong>", "warning");
          return;
        }
        const suggestion = suggestModelTiers(available);
        cheap = await pickModel(ctx, "Cheap tier — recon (scout): cheapest capable model", available, suggestion.cheap);
        if (!cheap) return;
        mid = await pickModel(ctx, "Mid tier — implementation, prose, research: the everyday model", available, suggestion.mid);
        if (!mid) return;
        strong = await pickModel(ctx, "Strong tier — review, second opinion, planning, escalation", available, suggestion.strong);
        if (!strong) return;
        name = parts[0] ?? mid.provider;
      }

      const existing = listProfileNames(ctx);
      if (existing.includes(name)) {
        ctx.ui.notify(
          `Profile '${name}' already exists. Re-run as /pipeline-init <newName> and pick models, or edit ${join(agentDir, "profiles", "pipeline", `${name}.json`)}.`,
          "warning",
        );
        return;
      }

      const profile = buildModelsProfile(name, base, {
        cheap: `${cheap!.provider}/${cheap!.id}`,
        mid: `${mid!.provider}/${mid!.id}`,
        strong: `${strong!.provider}/${strong!.id}`,
      }, roleNames);
      const target = join(agentDir, "profiles", "pipeline", `${name}.json`);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, `${JSON.stringify(profile, null, 2)}\n`, "utf-8");

      // Validate the file as discovery will see it; a bad one must not become the active profile.
      const check = loadResolved(pi, ctx, name);
      if (!check.resolved || check.resolved.errors.length) {
        unlinkSync(target);
        ctx.ui.notify(`Refusing to activate '${name}':\n- ${(check.resolved?.errors ?? check.errors).join("\n- ")}`, "error");
        return;
      }
      writeConfig(configPath(agentDir, ctx.cwd, trusted), { activeProfile: name });
      const applied = await applyParentModel(pi, ctx, check.resolved);
      const roles = Object.entries(check.resolved.roles)
        .map(([roleName, role]) => `${roleName}: ${describeModel(role.model)}${role.thinking ? `:${role.thinking}` : ""}`)
        .join("\n");
      ctx.ui.notify(`Wrote and activated ${target} (extends '${base}')${applied ? ` | ${applied}` : ""}\n${roles}`, "info");
    },
  });

  pi.registerCommand("pipeline-stop", {
    description: "Stop a pipeline node (or the whole run)",
    handler: async (args: string, ctx: any) => {
      if (!isRunning()) {
        ctx.ui.notify("No active run.", "info");
        return;
      }
      const nodeId = String(args ?? "").trim();
      ctx.ui.notify(stopNode(nodeId, !nodeId), "info");
    },
  });

  pi.registerCommand("pipeline-runs", {
    description: "List recorded pipeline runs",
    handler: async (_args: string, ctx: any) => {
      ctx.ui.notify(formatRunList(listRuns(runsRoot(getAgentDir()))).join("\n"), "info");
    },
  });

  pi.registerCommand("pipeline-resume", {
    description: "Resume a recorded run, re-resolving its steps against the active profile",
    handler: async (args: string, ctx: any) => {
      const runId = String(args ?? "").trim();
      if (!runId) {
        ctx.ui.notify(`Usage: /pipeline-resume <runId>\n${formatRunList(listRuns(runsRoot(getAgentDir()))).join("\n")}`, "warning");
        return;
      }
      const state = readRun(runsRoot(getAgentDir()), runId);
      if (!state) {
        ctx.ui.notify(`No run '${runId}'.`, "error");
        return;
      }
      const { resolved, errors } = loadResolved(pi, ctx);
      if (!resolved) {
        ctx.ui.notify(`Cannot resume: ${errors.join("; ")}`, "error");
        return;
      }
      if (isRunning()) {
        ctx.ui.notify(`A run (${getActive()?.runId}) is already active.`, "warning");
        return;
      }
      const before = Object.values(state.nodes).filter((node) => node.status === "ok").length;
      const result = await runPipeline(depsFor(pi, ctx, ctx.signal, refreshUi), resolved, state.steps, {
        resume: runId,
        roleAccess: roleAccessOf(resolved),
      });
      const after = Object.values(result.nodes).filter((node) => node.status === "ok").length;
      refreshUi();
      ctx.ui.notify(
        `Resumed ${runId}: ${before} kept, ${after - before} newly ok${result.error ? `\n${result.error}` : ""}`,
        result.ok ? "info" : "warning",
      );
    },
  });

  pi.registerCommand("pipeline-doctor", {
    description: "Report the active profile, role resolution, limits and run-directory state",
    handler: async (_args: string, ctx: any) => {
      const agentDir = getAgentDir();
      const deps = depsFor(pi, ctx);
      const { resolved, errors } = loadResolved(pi, ctx);
      const lines: string[] = [];
      if (!resolved) {
        lines.push(`No profile loaded: ${errors.join("; ") || "none found"}`);
      } else {
        lines.push(...profileReport(resolved, deps, ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined));
      }
      const size = runDirSize(runsRoot(agentDir));
      const summaries = listRuns(runsRoot(agentDir));
      lines.push(`runs: ${size.runs} on disk, ${(size.bytes / 1024).toFixed(0)} KiB · ${summaries.filter((s) => !s.finished).length} resumable`);
      const collisions = pi
        .getAllTools()
        .filter((tool) => ["subagent", "subagents_enable"].includes(tool.name))
        .map((tool) => tool.name);
      if (collisions.length) lines.push(`WARNING: another delegation extension is loaded (${collisions.join(", ")}); remove it to avoid duplicate delegation guidance and two run UIs.`);
      ctx.ui.notify(lines.join("\n"), resolved?.errors.length ? "error" : "info");
    },
  });

  pi.registerCommand("pipeline-smoke", {
    description: "Run one real read-only step to verify children work end to end (spends tokens; needs PIPELINE_SMOKE=1)",
    handler: async (_args: string, ctx: any) => {
      if (!process.env.PIPELINE_SMOKE) {
        ctx.ui.notify("Set PIPELINE_SMOKE=1 to run the live smoke test; it spends real tokens.", "warning");
        return;
      }
      const { resolved, errors } = loadResolved(pi, ctx);
      if (!resolved) {
        ctx.ui.notify(`No profile: ${errors.join("; ")}`, "error");
        return;
      }
      const role = Object.values(resolved.roles).find((candidate) => candidate.access === "read") ?? Object.values(resolved.roles)[0];
      if (!role) {
        ctx.ui.notify("The active profile has no roles.", "error");
        return;
      }
      ctx.ui.notify(`Smoke: running one '${role.name}' step...`, "info");
      const result = await runPipeline(depsFor(pi, ctx, ctx.signal, refreshUi), resolved, [
        { id: "smoke", role: role.name, objective: "Reply with your role name and the single word ready.", deliverable: "one short line" },
      ], { roleAccess: roleAccessOf(resolved) });
      const node = Object.values(result.nodes)[0];
      const usage = totalUsage(result.nodes);
      ctx.ui.notify(
        [
          `smoke ${result.ok ? "passed" : "FAILED"}`,
          `node: ${node.id} [${node.role}] ${node.status}${node.error ? ` - ${node.error}` : ""}`,
          `model: ${node.model}${node.thinking ? `:${node.thinking}` : ""}`,
          `sentinel: ${node.sentinelMissing ? "missing" : "parsed"}`,
          `usage: ${usage.totalTokens} tok / $${usage.cost.toFixed(4)}`,
          `output: ${node.outputPath ?? "none"}`,
          `transcript: ${node.sessionFile ?? "none"}`,
          `run dir: ${join(runsRoot(getAgentDir()), result.runId)}`,
        ].join("\n"),
        result.ok ? "info" : "error",
      );
    },
  });

  pi.registerFlag("pipeline-profile", { description: "Start this session on a named subagent profile", type: "string" });

  const flagValue = pi.getFlag("pipeline-profile");
  if (typeof flagValue === "string" && flagValue.trim()) {
    const name = flagValue.trim();
    const agentDir = getAgentDir();
    const discovered = discoverProfiles({ cwd: process.cwd(), agentDir, packageDir: PACKAGE_DIR, trusted: false });
    // Name existence is not enough: a profile with a broken extends chain must not become a
    // persisted global default. Full model validation waits for the registry at session start.
    if (discovered.sources.has(name) && resolveChain(name, discovered.sources).errors.length === 0) {
      const target = join(agentDir, "extensions", "pipeline", "config.json");
      try {
        writeConfig(target, { activeProfile: name });
      } catch {
        // a read-only config directory must not stop startup
      }
    }
  }

  const shortcut = (() => {
    try {
      const settings = pi.getSettings() as any;
      return settings?.pipeline?.treeShortcut ?? DEFAULT_SHORTCUT;
    } catch {
      return DEFAULT_SHORTCUT;
    }
  })();
  pi.registerShortcut(shortcut, {
    description: "Open the pipeline tree",
    handler: async (ctx: ExtensionContext) => openTree(ctx),
  });
}

function listProfileNames(ctx?: ExtensionContext): string[] {
  const agentDir = getAgentDir();
  const cwd = ctx?.cwd ?? process.cwd();
  const trusted = ctx?.isProjectTrusted?.() ?? false;
  const discovered = discoverProfiles({ cwd, agentDir, packageDir: PACKAGE_DIR, trusted });
  return [...discovered.sources.keys()].sort((a, b) => a.localeCompare(b));
}

function readFileIfPresent(path: string): string | undefined {
  try {
    return existsSync(path) ? readFileSync(path, "utf-8") : undefined;
  } catch {
    return undefined;
  }
}
