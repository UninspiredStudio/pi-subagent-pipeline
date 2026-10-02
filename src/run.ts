/**
 * Pipeline executor: child sessions, streaming, artifact capture, verification,
 * escalation, budget enforcement and per-node persistence.
 */
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { relative, resolve, sep } from "node:path";
import {
  blockedReason,
  budgetExceeded,
  clampConcurrency,
  EMPTY_USAGE,
  emptyNode,
  escalationsUsed,
  orderLevels,
  parseSentinel,
  planLevel,
  promoteReaders,
  shouldEscalate,
  sumUsage,
  totalUsage,
  truncate,
  undeclaredChanges,
  validateSteps,
  verificationOk,
  type NodeState,
  type NodeUsage,
  type Promotion,
  type Step,
} from "./plan.ts";
import { resolveModelRef, type ResolvedProfile, type ResolvedRole } from "./profiles.ts";
import {
  appendEvent,
  newRunId,
  readNodeOutput,
  readRun,
  runDir,
  runsRoot,
  writeNodeOutput,
  writeRun,
  type RunState,
} from "./runs.ts";
import { PipelineParams } from "./schema.ts";

export interface PipelineDeps {
  cwd: string;
  agentDir: string;
  /** ModelRegistry: getAvailable/getAll/find/hasConfiguredAuth. */
  registry: any;
  exec: (command: string, args: string[], options?: { cwd?: string; timeout?: number; signal?: AbortSignal }) => Promise<{
    stdout: string;
    stderr: string;
    code: number;
    killed: boolean;
  }>;
  projectTrusted: boolean;
  /** Called whenever node state changes, so the TUI can re-render. */
  onChange?: () => void;
  /** Parent turn signal; cancelling it cancels the run. */
  signal?: AbortSignal;
}

export interface ActiveRun {
  runId: string;
  profile: string;
  nodes: Record<string, NodeState>;
  promotions: Promotion[];
  startedAt: number;
  listeners: Set<() => void>;
  state: RunState;
}

let active: ActiveRun | undefined;
const sessions = new Map<string, any>();
const stopping = new Set<string>();

/**
 * Parent/child marker keyed on the session manager instance we created for the child.
 * An env var would be process-wide and leak into siblings, so identity is used instead.
 */
const SESSION_KIND = new WeakMap<WeakKey, "parent" | "child">();

export function markChildSession(sessionManager: WeakKey): void {
  SESSION_KIND.set(sessionManager, "child");
}

export function markParentSession(sessionManager: WeakKey): void {
  SESSION_KIND.set(sessionManager, "parent");
}

export function sessionKind(sessionManager: WeakKey | undefined): "parent" | "child" {
  if (!sessionManager) return "parent";
  return SESSION_KIND.get(sessionManager) ?? "parent";
}

export function getActive(): ActiveRun | undefined {
  return active;
}

export function isRunning(): boolean {
  return active !== undefined;
}

export function stopNode(nodeId: string, whole = false): string {
  if (!active) return "no active run";
  if (whole) {
    for (const id of Object.keys(active.nodes)) stopping.add(id);
  } else {
    if (!active.nodes[nodeId]) return `unknown node '${nodeId}'`;
    stopping.add(nodeId);
  }
  for (const [id, session] of sessions) {
    if (whole || id === nodeId) void session.abort?.();
  }
  return whole ? `stopping run ${active.runId}` : `stopping node '${nodeId}'`;
}

function emit(run: ActiveRun | undefined): void {
  if (!run) return;
  for (const listener of run.listeners) {
    try {
      listener();
    } catch {
      // a broken render callback must not break a run
    }
  }
}

function toNodeUsage(messages: any[]): NodeUsage {
  const usage: NodeUsage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: 0,
    costDetail: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  for (const message of messages ?? []) {
    const raw = message?.usage;
    if (!raw) continue;
    usage.input += raw.input ?? 0;
    usage.output += raw.output ?? 0;
    usage.cacheRead += raw.cacheRead ?? 0;
    usage.cacheWrite += raw.cacheWrite ?? 0;
    usage.totalTokens += raw.totalTokens ?? (raw.input ?? 0) + (raw.output ?? 0);
    const bucket = raw.cost ?? {};
    usage.costDetail.input += bucket.input ?? 0;
    usage.costDetail.output += bucket.output ?? 0;
    usage.costDetail.cacheRead += bucket.cacheRead ?? 0;
    usage.costDetail.cacheWrite += bucket.cacheWrite ?? 0;
    usage.cost +=
      bucket.total ?? (bucket.input ?? 0) + (bucket.output ?? 0) + (bucket.cacheRead ?? 0) + (bucket.cacheWrite ?? 0);
  }
  return usage;
}

function stepPrompt(step: Step): string {
  const lines = [`Objective: ${step.objective}`, `Deliverable: ${step.deliverable}`];
  if (step.scope) lines.push(`Scope (do not go beyond this): ${step.scope}`);
  if (step.context?.length) lines.push(`Context to read first: ${step.context.join(", ")}`);
  lines.push(
    "",
    "Work only inside the workspace. Do not modify anything outside your scope.",
    "When you are finished, end your reply with exactly this final line:",
    "PIPELINE_STATUS: ok",
    "If you cannot complete the objective safely or the task is beyond you, end with:",
    "PIPELINE_STATUS: blocked - <one sentence saying why>",
  );
  return lines.join("\n");
}

function escalationPrompt(node: NodeState, step: Step, reason: string, target: string): string {
  const history = node.attempts.map((attempt) => `${attempt.source} -> ${attempt.target}: ${attempt.reason}`).join("; ");
  return [
    `A previous attempt at this step stopped because: ${reason}.`,
    `It has been handed off to: ${target}.`,
    history ? `Previous handoffs: ${history}.` : "",
    "Continue from that attempt. You have the same instructions and the same tool access.",
    "",
    stepPrompt(step),
  ]
    .filter(Boolean)
    .join("\n");
}

export interface RunOptions {
  resume?: string;
  concurrency?: number;
  roleAccess: Record<string, "read" | "write">;
  /** Set when a child spawns its own sub-plan: nodes attach to the existing run tree. */
  parentId?: string;
  /** Nesting depth of the nodes this call creates (root run is 0). */
  depth?: number;
}

export interface RunResult {
  ok: boolean;
  runId: string;
  error?: string;
  nodes: Record<string, NodeState>;
  usage: NodeUsage;
  promotions: Promotion[];
  warnings: string[];
}

function realModel(deps: PipelineDeps, model: { provider: string; id: string } | undefined): any {
  if (!model) return undefined;
  return deps.registry.getAll().find((candidate: any) => candidate.provider === model.provider && candidate.id === model.id);
}

export async function runPipeline(
  deps: PipelineDeps,
  resolved: ResolvedProfile,
  steps: Step[],
  options: RunOptions,
): Promise<RunResult> {
  const validation = validateSteps(steps, options.roleAccess, {
    maxNodes: resolved.limits.maxNodes,
    existingNodes: options.parentId && active ? Object.keys(active.nodes).length : 0,
  });
  const warnings = [...validation.warnings, ...resolved.warnings];
  if (validation.errors.length) {
    return {
      ok: false,
      runId: "",
      error: `plan rejected:\n- ${validation.errors.join("\n- ")}`,
      nodes: {},
      usage: totalUsage({}),
      promotions: [],
      warnings,
    };
  }
  const depth = options.depth ?? 0;
  if (depth > resolved.limits.maxDepth) {
    return {
      ok: false,
      runId: "",
      error: `maxDepth ${resolved.limits.maxDepth} reached; this child may not spawn further`,
      nodes: {},
      usage: totalUsage({}),
      promotions: [],
      warnings,
    };
  }

  const nesting = Boolean(options.parentId) && active !== undefined;
  if (isRunning() && !nesting) {
    return {
      ok: false,
      runId: "",
      error: `a run (${active?.runId}) is already active; inspect it with pipeline_status({action:"tree"}) or stop it first`,
      nodes: {},
      usage: totalUsage({}),
      promotions: [],
      warnings,
    };
  }

  const profileName = resolved.profile.name ?? resolved.source.name;
  const root = runsRoot(deps.agentDir);
  const resumed = options.resume ? readRun(root, options.resume) : undefined;
  if (options.resume && !resumed) {
    return { ok: false, runId: options.resume, error: `no run '${options.resume}' in ${root}`, nodes: {}, usage: totalUsage({}), promotions: [], warnings };
  }

  const { edges, promotions } = promoteReaders(steps, options.roleAccess);
  const ordered = orderLevels(steps, edges);
  if (ordered.error) {
    return { ok: false, runId: "", error: ordered.error, nodes: {}, usage: totalUsage({}), promotions, warnings };
  }
  for (const promotion of promotions) {
    warnings.push(`step '${promotion.reader}' ordered after writer '${promotion.writer}' (${promotion.basis})`);
  }

  if (nesting) {
    const clash = steps.find((step) => active!.nodes[step.id] !== undefined);
    if (clash) {
      return {
        ok: false,
        runId: active!.runId,
        error: `nested step id '${clash.id}' already exists in this run; step ids are unique across the whole tree`,
        nodes: {},
        usage: totalUsage({}),
        promotions,
        warnings,
      };
    }
  }

  const runId = nesting ? active!.runId : resumed?.runId ?? newRunId(Date.now());
  const round = nesting
    ? Math.max(1, ...Object.values(active!.nodes).map((node) => node.round))
    : (resumed?.rounds.length ?? 0) + 1;
  const nodes: Record<string, NodeState> = nesting ? active!.nodes : { ...(resumed?.nodes ?? {}) };

  for (const step of steps) {
    const role = resolved.roles[step.role];
    const existing = nodes[step.id];
    if (existing?.status === "ok") continue; // resume preserves completed work
    const stepModel = step.model
      ? resolveModelRef(step.model, deps.registry.getAll().map(toModelLike))
      : undefined;
    const escalationTarget = role.escalate?.to;
    nodes[step.id] = emptyNode(step.id, {
      parentId: options.parentId ?? existing?.parentId,
      role: step.role,
      task: step.objective,
      profile: profileName,
      access: options.roleAccess[step.role],
      model: stepModel?.model ? `${stepModel.model.provider}/${stepModel.model.id}` : role.model ? `${role.model.provider}/${role.model.id}` : "inherit",
      thinking: step.thinking ?? role.thinking,
      round,
      artifacts: { changedFiles: [] },
      escalateTarget: escalationTarget,
      outputPath: existing?.outputPath,
      attempts: existing?.attempts ?? [],
      usage: existing?.usage ?? { ...EMPTY_USAGE, costDetail: { ...EMPTY_USAGE.costDetail } },
    });
  }

  const state: RunState = nesting
    ? active!.state
    : {
        runId,
        profile: profileName,
        profilePath: resolved.source.path,
        steps,
        nodes,
        rounds: [...(resumed?.rounds ?? []), { round, profile: profileName, startedAt: Date.now() }],
        createdAt: resumed?.createdAt ?? Date.now(),
        updatedAt: Date.now(),
        finished: false,
      };
  if (nesting) {
    for (const step of steps) {
      if (!state.steps.some((existing) => existing.id === step.id)) state.steps.push(step);
    }
  }

  const run: ActiveRun = nesting
    ? active!
    : { runId, profile: profileName, nodes, promotions, startedAt: Date.now(), listeners: new Set(), state };
  if (!nesting) active = run;
  // A stop is scoped to the run in flight. Nodes that were already `ok` (or skipped) when the
  // stop was issued never reach executeNode, so their ids would otherwise linger and falsely
  // stop a same-named node in the next run.
  if (!nesting) stopping.clear();

  const abort = new AbortController();
  const cancelOnParent = () => abort.abort();
  deps.signal?.addEventListener("abort", cancelOnParent, { once: true });

  const persist = () => {
    for (const node of Object.values(nodes)) {
      node.children = Object.values(nodes).filter((candidate) => candidate.parentId === node.id).map((candidate) => candidate.id);
    }
    state.nodes = nodes;
    writeRun(root, state);
    emit(run);
    deps.onChange?.();
  };
  persist();

  const limits = resolved.limits;
  const maxConcurrent = clampConcurrency(options.concurrency, limits.maxConcurrent);

  try {
    for (const level of ordered.levels) {
      if (abort.signal.aborted) break;
      const budget = totalUsage(nodes);
      if (budgetExceeded(budget, limits)) {
        for (const node of Object.values(nodes)) {
          if (node.status === "queued" || node.status === "running") {
            node.status = "skipped";
            node.skippedReason = "run budget exhausted";
          }
        }
        warnings.push("budget exhausted; remaining steps were skipped");
        break;
      }

      const plan = planLevel(level, steps, nodes, options.roleAccess, maxConcurrent, edges);
      for (const skip of plan.skipped) {
        nodes[skip.id].status = "skipped";
        nodes[skip.id].skippedReason = skip.reason;
      }
      if (!plan.runnable.length) {
        if (plan.skipped.length) persist();
        continue;
      }

      for (const batch of plan.batches) {
        if (abort.signal.aborted) break;
        await Promise.all(
          batch.map((id) =>
            executeNode(deps, root, state, run, resolved, steps.find((step) => step.id === id)!, abort, persist, depth),
          ),
        );
        persist();
      }
    }
  } finally {
    deps.signal?.removeEventListener("abort", cancelOnParent);
    if (abort.signal.aborted) {
      for (const node of Object.values(nodes)) {
        if (node.status === "running" || node.status === "queued") {
          node.status = "cancelled";
          node.endedAt = Date.now();
        }
      }
    }
    if (!nesting) {
      state.finished = Object.values(nodes).every((node) => !["queued", "running"].includes(node.status));
      persist();
      active = undefined;
    } else {
      persist();
    }
  }

  const usage = totalUsage(nodes);
  const scopeIds = new Set(steps.map((step) => step.id));
  const failed = Object.values(nodes).filter(
    (node) => scopeIds.has(node.id) && ["failed", "blocked", "stopped", "cancelled", "skipped"].includes(node.status),
  );
  return {
    ok: failed.length === 0,
    runId,
    error: failed.length ? `${failed.length} step(s) did not succeed: ${failed.map((n) => `${n.id}(${n.status})`).join(", ")}` : undefined,
    nodes,
    usage,
    promotions,
    warnings,
  };
}

function toModelLike(model: any) {
  return { provider: model.provider, id: model.id, name: model.name, reasoning: model.reasoning, contextWindow: model.contextWindow, cost: model.cost };
}

async function executeNode(
  deps: PipelineDeps,
  root: string,
  state: RunState,
  run: ActiveRun,
  resolved: ResolvedProfile,
  step: Step,
  abort: AbortController,
  persist: () => void,
  depth: number,
): Promise<void> {
  const node = run.nodes[step.id];
  const role = resolved.roles[step.role];
  // A run-wide stop marks every id; do not spend tokens starting a child that is already stopped.
  if (stopping.has(step.id)) {
    stopping.delete(step.id);
    node.status = "stopped";
    node.endedAt = Date.now();
    persist();
    return;
  }
  appendEvent(root, run.runId, { type: "node_start", node: step.id, role: step.role, round: node.round });

  const stepModel = step.model ? resolveModelRef(step.model, deps.registry.getAll().map(toModelLike)) : undefined;
  const model = realModel(deps, stepModel?.model ?? role.model);
  const thinking = step.thinking ?? role.thinking;
  const sessionDir = runDir(root, run.runId);

  const loader = new DefaultResourceLoader({
    cwd: deps.cwd,
    agentDir: deps.agentDir,
    // The role prompt is appended rather than replacing the system prompt so children keep
    // Pi's built-in tool guidance. Documented in README as a deliberate deviation.
    appendSystemPrompt: [role.prompt, stepPrompt(step)],
    noSkills: !role.context.skills,
    noContextFiles: !role.context.projectFiles,
    // A child gets the pipeline tool only while the depth cap allows (rev 5 / A6 parity).
    extensionFactories: [childExtensionFactory(deps, resolved, depth, step.id, role)],
    resolveProjectTrust: async () => deps.projectTrusted,
  } as any);
  await loader.reload({ resolveProjectTrust: async () => deps.projectTrusted });

  let session: any;
  let timer: NodeJS.Timeout | undefined;
  let detachAbort: (() => void) | undefined;
  try {
    const sessionManager = SessionManager.create(deps.cwd, sessionDir);
    markChildSession(sessionManager);
    const created = await createAgentSession({
      cwd: deps.cwd,
      agentDir: deps.agentDir,
      model,
      thinkingLevel: thinking as any,
      tools: role.tools,
      resourceLoader: loader,
      sessionManager,
      sessionStartEvent: { type: "session_start", reason: "startup" } as any,
    });
    session = created.session;
    sessions.set(step.id, session);
    // Ambient extension tools (web search, LSP, MCP servers) only register once extensions are bound.
    await session.bindExtensions({ mode: "print" });
    node.sessionFile = sessionManager.getSessionFile();
    // Cancelling the parent turn, or a stop, aborts this child immediately.
    const onAbort = () => {
      stopping.add(step.id);
      void session?.abort?.();
    };
    if (abort.signal.aborted) onAbort();
    else abort.signal.addEventListener("abort", onAbort, { once: true });
    detachAbort = () => abort.signal.removeEventListener("abort", onAbort);
    node.status = "running";
    node.startedAt = Date.now();
    node.model = model ? `${model.provider}/${model.id}` : node.model;
    persist();

    session.subscribe((event: any) => {
      if (event?.type === "tool_execution_start" && (event.toolName === "write" || event.toolName === "edit")) {
        const path = event.args?.path ?? event.args?.file_path;
        if (typeof path === "string") {
          const resolvedPath = resolve(deps.cwd, path);
          const rel = relative(deps.cwd, resolvedPath);
          const inside = !rel || (rel !== ".." && !rel.startsWith(`..${sep}`));
          if (inside) {
            const recorded = rel ? rel.split(sep).join("/") : ".";
            if (!node.artifacts.changedFiles.includes(recorded)) {
              node.artifacts.changedFiles.push(recorded);
              persist();
            }
          } else {
            // Kept out of changedFiles so a `**` touches glob can never swallow an escape.
            const outside = node.artifacts.outsideFiles ?? (node.artifacts.outsideFiles = []);
            if (!outside.includes(resolvedPath)) {
              outside.push(resolvedPath);
              persist();
            }
          }
        }
      }
    });

    const timeoutMs = resolved.limits.perStepTimeoutMs;
    timer = setTimeout(() => {
      stopping.add(step.id);
      node.error = `timed out after ${timeoutMs}ms`;
      void session.abort?.();
    }, timeoutMs);

    const prior = node.usage;
    await session.prompt(stepPrompt(step));
    if (stopping.has(step.id)) {
      node.status = "stopped";
      node.endedAt = Date.now();
      return;
    }

    let text = (session.getLastAssistantText?.() as string | undefined) ?? "";
    node.usage = sumUsage([prior, toNodeUsage(session.messages ?? [])]);
    const sentinel = parseSentinel(text);
    if (sentinel === undefined) {
      node.sentinelMissing = true;
      node.status = text.trim() ? "ok" : "failed";
      if (!text.trim()) node.error = "child produced no output";
    } else if (sentinel === "ok") {
      node.status = "ok";
    } else {
      node.status = "blocked";
      node.error = blockedReason(text);
    }

    if (role.verify) {
      const expect = role.verify.expectExit ?? 0;
      const result = await deps.exec(role.verify.command, [], { cwd: deps.cwd, timeout: role.verify.timeoutMs ?? 120_000 });
      const ok = verificationOk(result.code, expect);
      node.verification = { kind: "command", command: role.verify.command, exitCode: result.code, ok };
      if (!ok) node.status = "blocked";
      text += `\n\n--- verify: ${role.verify.command} (exit ${result.code}) ---\n${result.stdout}${result.stderr}`;
    }

    const undeclared = [...undeclaredChanges(node.artifacts.changedFiles, step.touches), ...(node.artifacts.outsideFiles ?? [])];
    if (undeclared.length) node.artifacts.touchesMismatch = undeclared.join(", ");

    if (node.status === "blocked" || node.status === "failed") {
      const decision = shouldEscalate(node, {
        attemptsAllowed: role.escalate?.attempts ?? 1,
        escalationsUsed: escalationsUsed(run.nodes),
        maxEscalations: resolved.limits.maxEscalations,
      });
      if (decision.escalate && role.escalate) {
        const target = role.escalate.to;
        const targetRole = resolved.roles[target];
        const targetRef = targetRole?.model ? `${targetRole.model.provider}/${targetRole.model.id}` : target;
        const targetModel = realModel(deps, targetRole?.model ?? resolveModelRef(target, deps.registry.getAll().map(toModelLike)).model);
        if (targetModel) {
          node.attempts.push({
            source: node.model,
            target: targetRef,
            reason: decision.reason,
            depth: node.attempts.length + 1,
            crossFamily: targetModel.provider !== (role.model?.provider ?? ""),
            checks: ["target validated at activation", "not self", "within maxThinking", "within maxEscalations"],
          });
          node.status = "escalated";
          persist();
          appendEvent(root, run.runId, { type: "escalation", node: step.id, target: targetRef, reason: decision.reason });
          if (typeof session.setModel === "function") await session.setModel(targetModel);
          if (role.escalate.thinking && typeof session.setThinkingLevel === "function") session.setThinkingLevel(role.escalate.thinking);
          text = "";
          await session.prompt(escalationPrompt(node, step, decision.reason, targetRef));
          if (stopping.has(step.id) || abort.signal.aborted) {
            node.status = abort.signal.aborted ? "cancelled" : "stopped";
            node.endedAt = Date.now();
            return;
          }
          text = (session.getLastAssistantText?.() as string | undefined) ?? "";
          node.usage = sumUsage([prior, toNodeUsage(session.messages ?? [])]);
          const retry = parseSentinel(text);
          if (retry === "ok") node.status = "ok";
          else if (retry === "blocked") node.status = "failed";
          else if (text.trim()) node.status = "ok";
          else node.status = "failed";
          node.model = `${targetModel.provider}/${targetModel.id}`;
          node.thinking = role.escalate.thinking ?? node.thinking;
        }
      }
    }

    node.outputPath = writeNodeOutput(root, run.runId, step.id, text);
    node.endedAt = Date.now();
    appendEvent(root, run.runId, { type: "node_end", node: step.id, status: node.status, tokens: node.usage.totalTokens });
  } catch (error) {
    node.status = "failed";
    node.error = (error as Error).message;
    node.endedAt = Date.now();
    appendEvent(root, run.runId, { type: "node_error", node: step.id, error: node.error });
  } finally {
    if (timer) clearTimeout(timer);
    detachAbort?.();
    sessions.delete(step.id);
    stopping.delete(step.id);
    try {
      const runner = session?.extensionRunner;
      if (runner?.emit) await runner.emit({ type: "session_shutdown", reason: "quit" });
    } catch {
      // best-effort shutdown; dispose below is authoritative
    }
    try {
      session?.dispose?.();
    } catch {
      // ignore
    }
    state.nodes = run.nodes;
    persist();
  }
}

/**
 * Inline extension registered into a child session so it can spawn its own sub-plan.
 * Not registered at all once the depth limit is reached, rather than returning an error.
 */
function childExtensionFactory(
  deps: PipelineDeps,
  resolved: ResolvedProfile,
  depth: number,
  parentId: string,
  parentRole: ResolvedRole,
) {
  return (childPi: any) => {
    if (depth >= resolved.limits.maxDepth) return;
    childPi.registerTool({
      name: "pipeline",
      label: "pipeline (sub-plan)",
      description:
        "Run a sub-plan of independent steps with the active profile's roles. Same step schema as the parent pipeline tool. Prefer a single step unless the sub-task genuinely splits in two.",
      parameters: PipelineParams,
      executionMode: "sequential",
      execute: async (_id: string, params: any, signal: AbortSignal | undefined, _onUpdate: any, ctx: any) => {
        const roleAccess: Record<string, "read" | "write"> = {};
        for (const [name, role] of Object.entries(resolved.roles)) roleAccess[name] = role.access;
        const steps = (params.steps ?? []) as Step[];
        if (parentRole.canSpawn) {
          const disallowed = steps.map((step) => step.role).filter((role) => !parentRole.canSpawn!.includes(role));
          if (disallowed.length) {
            return {
              content: [{ type: "text", text: `role '${parentRole.name}' may only spawn: ${parentRole.canSpawn.join(", ")}. Rejected: ${disallowed.join(", ")}` }],
              isError: true,
              details: undefined,
            };
          }
        }
        const nestedDeps: PipelineDeps = {
          cwd: ctx.cwd,
          agentDir: getAgentDir(),
          registry: ctx.modelRegistry,
          exec: (command: string, args: string[], options?: any) => childPi.exec(command, args, options),
          projectTrusted: ctx.isProjectTrusted(),
          signal,
        };
        const result = await runPipeline(nestedDeps, resolved, steps, {
          roleAccess,
          parentId,
          depth: depth + 1,
          concurrency: params.concurrency,
        });
        const scoped = Object.values(result.nodes).filter((node) => steps.some((step) => step.id === node.id));
        const scopedUsage = totalUsage(Object.fromEntries(scoped.map((node) => [node.id, node])));
        const lines = scoped.map((node) => `${node.id} [${node.role}] ${node.status}${node.error ? ` - ${node.error}` : ""}`);
        const body = scoped
          .map((node) => {
            const output = readNodeOutput(runsRoot(deps.agentDir), result.runId, node.id);
            return output ? `\n--- ${node.id} (${node.role}) ---\n${truncate(output, 4000)}` : "";
          })
          .join("");
        return {
          content: [{ type: "text", text: `${result.ok ? "sub-plan completed" : "sub-plan incomplete"}\n${lines.join("\n")}${body}` }],
          isError: !result.ok,
          details: { runId: result.runId, nodes: lines },
          usage: {
            input: scopedUsage.input,
            output: scopedUsage.output,
            cacheRead: scopedUsage.cacheRead,
            cacheWrite: scopedUsage.cacheWrite,
            totalTokens: scopedUsage.totalTokens,
            cost: scopedUsage.costDetail,
          },
        };
      },
    });
  };
}


export { getAgentDir };
