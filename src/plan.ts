/**
 * Pure planning logic: step validation, ordering, reader/writer promotion, sentinel
 * parsing, budget and escalation decisions, and width-safe tree rows.
 * No platform and no fs imports, so it is directly testable.
 */
import type { ThinkingLevel } from "./profiles.ts";

export interface Step {
  id: string;
  role: string;
  objective: string;
  deliverable: string;
  scope?: string;
  context?: string[];
  needs?: string[];
  model?: string;
  thinking?: ThinkingLevel;
  touches?: string[];
}

/**
 * Synthesize the one-step plan for the `task` shortcut. With no role given, default to the first
 * read role so a bare question becomes a read-only step rather than a write.
 */
export function singleTaskStep(
  task: string,
  role?: string,
  roles?: Array<{ name: string; access: "read" | "write" }>,
): Step {
  const fallback = roles?.find((r) => r.access === "read")?.name ?? roles?.[0]?.name ?? "scout";
  return {
    id: "task",
    role: (role ?? "").trim() || fallback,
    objective: task.trim(),
    deliverable: "The answer or artifact the task asks for.",
  };
}

export const NODE_STATUSES = [
  "queued",
  "running",
  "ok",
  "blocked",
  "failed",
  "escalated",
  "recovered",
  "stopped",
  "cancelled",
  "skipped",
] as const;
export type NodeStatus = (typeof NODE_STATUSES)[number];

export interface NodeUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: number;
  /** Per-bucket cost, so the platform's Usage.cost object can be reported accurately. */
  costDetail: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

export interface Attempt {
  source: string;
  target: string;
  reason: string;
  depth: number;
  crossFamily: boolean;
  checks: string[];
}

export interface NodeState {
  id: string;
  parentId?: string;
  role: string;
  task: string;
  profile: string;
  access: "read" | "write";
  model: string;
  thinking?: ThinkingLevel;
  status: NodeStatus;
  round: number;
  attempts: Attempt[];
  usage: NodeUsage;
  artifacts: { changedFiles: string[]; artifactMismatch?: string; touchesMismatch?: string; /** Writes outside the workspace; never glob-matched against `touches`. */ outsideFiles?: string[] };
  /** Resolved escalation target (role name or provider/id), when the role declares one. */
  escalateTarget?: string;
  verification?: { kind: "command"; command: string; exitCode: number; outputPath?: string; ok: boolean };
  sentinelMissing?: boolean;
  promotedBy?: string[];
  skippedReason?: string;
  error?: string;
  outputPath?: string;
  /** Path of the child's own session file inside the run directory, when it exists. */
  sessionFile?: string;
  startedAt?: number;
  endedAt?: number;
  children: string[];
}

export const EMPTY_USAGE: NodeUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: 0,
  costDetail: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

export function emptyNode(id: string, init: Partial<NodeState> & Pick<NodeState, "role" | "task" | "profile" | "access" | "model">): NodeState {
  return {
    id,
    status: "queued",
    round: 1,
    attempts: [],
    usage: { ...EMPTY_USAGE },
    artifacts: { changedFiles: [] },
    children: [],
    ...init,
  };
}

const STATUS_GLYPH: Record<NodeStatus, string> = {
  queued: "·",
  running: "●",
  ok: "✔",
  blocked: "■",
  failed: "✖",
  escalated: "▲",
  recovered: "⟲",
  stopped: "◼",
  cancelled: "○",
  skipped: "·",
};

/**
 * Parse the child's terminal status line. Only the last non-empty line counts, and a
 * missing sentinel is never an escalation trigger (rev 4, gap 6).
 */
export function parseSentinel(text: string): "ok" | "blocked" | undefined {
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  const last = lines[lines.length - 1] ?? "";
  const match = /^PIPELINE_STATUS:\s*(ok|blocked)\b/i.exec(last);
  if (!match) return undefined;
  return match[1].toLowerCase() as "ok" | "blocked";
}

export function blockedReason(text: string): string {
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  const last = lines[lines.length - 1] ?? "";
  const match = /^PIPELINE_STATUS:\s*blocked\b[-—:]*\s*(.*)$/i.exec(last);
  const reason = (match?.[1] ?? "").replace(/^[\s:\u2014\u2013-]+/, "").trim();
  return reason || "child reported blocked without a reason";
}

const STOPWORDS = new Set(["the", "a", "an", "and", "or", "to", "of", "in", "on", "for", "with", "all", "this", "that", "then", "from"]);
function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 2 && !STOPWORDS.has(word)),
  );
}

function overlap(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared / Math.min(a.size, b.size);
}

export interface StepValidation {
  errors: string[];
  warnings: string[];
}

export function validateSteps(steps: Step[], roleAccess: Record<string, "read" | "write">, opts: { maxNodes?: number; existingNodes?: number } = {}): StepValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (typeof opts.maxNodes === "number" && steps.length + (opts.existingNodes ?? 0) > opts.maxNodes) {
    errors.push(`pipeline has ${steps.length + (opts.existingNodes ?? 0)} node(s); maxNodes is ${opts.maxNodes}`);
  }
  if (!Array.isArray(steps) || steps.length === 0) {
    return { errors: ["pipeline requires at least one step"], warnings };
  }

  const seen = new Set<string>();
  for (const step of steps) {
    const label = step?.id ? `step '${step.id}'` : "a step";
    if (!step?.id || !String(step.id).trim()) errors.push("every step needs a non-empty id");
    else if (seen.has(step.id)) errors.push(`duplicate step id '${step.id}'`);
    else seen.add(step.id);

    if (!step?.role || !String(step.role).trim()) errors.push(`${label}: role is required`);
    else if (!Object.prototype.hasOwnProperty.call(roleAccess, step.role)) {
      errors.push(`${label}: unknown role '${step.role}' (active profile roles: ${Object.keys(roleAccess).join(", ") || "none"})`);
    }
    if (!step?.objective || !String(step.objective).trim()) errors.push(`${label}: objective is required`);
    if (!step?.deliverable || !String(step.deliverable).trim()) errors.push(`${label}: deliverable is required`);
    if (step?.touches?.length && step.role && roleAccess[step.role] === "read") {
      errors.push(`${label}: touches is only meaningful for access 'write' roles`);
    }
  }

  const ids = new Set(steps.map((step) => step?.id));
  for (const step of steps) {
    for (const need of step?.needs ?? []) {
      if (!ids.has(need)) errors.push(`step '${step.id}': needs unknown step '${need}'`);
      if (need === step.id) errors.push(`step '${step.id}': needs itself`);
    }
  }

  for (let i = 0; i < steps.length; i += 1) {
    for (let j = i + 1; j < steps.length; j += 1) {
      const ratio = overlap(tokens(steps[i]?.objective ?? ""), tokens(steps[j]?.objective ?? ""));
      if (ratio >= 0.8) {
        warnings.push(`steps '${steps[i].id}' and '${steps[j].id}' have near-duplicate objectives (${Math.round(ratio * 100)}% overlap); they may duplicate work`);
      }
    }
  }
  return { errors, warnings };
}

/** Kahn levels; a cycle returns an error naming the remaining ids. */
export function orderLevels(steps: Step[], extraEdges: Array<[string, string]> = []): { levels: string[][]; error?: string } {
  const deps = new Map<string, Set<string>>();
  for (const step of steps) deps.set(step.id, new Set(step.needs ?? []));
  for (const [dependent, dependency] of extraEdges) {
    if (deps.has(dependent) && deps.has(dependency)) deps.get(dependent)!.add(dependency);
  }

  const levels: string[][] = [];
  const done = new Set<string>();
  let remaining = [...deps.keys()];
  while (remaining.length) {
    const ready = remaining.filter((id) => [...(deps.get(id) ?? [])].every((need) => done.has(need)));
    if (!ready.length) return { levels, error: `dependency cycle among: ${remaining.join(", ")}` };
    levels.push(ready);
    for (const id of ready) done.add(id);
    remaining = remaining.filter((id) => !done.has(id));
  }
  return { levels };
}

function pathsIn(text: string | undefined): string[] {
  if (!text) return [];
  return (text.match(/[\w./-]*\/[\w./-]+/g) ?? []).map((p) => p.replace(/[.,;:]$/, ""));
}

/** Glob match over workspace-relative paths: `*` is one segment, `**` spans segments. */
export function matchesGlob(path: string, glob: string): boolean {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  // `**/` may match zero path segments, so `src/**/*.ts` also matches `src/a.ts`.
  const body = escaped
    .replace(/\*\*\//g, "\x01")
    .replace(/\*\*/g, "\x00")
    .replace(/\*/g, "[^/]*")
    .replace(/\x01/g, "(?:.*/)?")
    .replace(/\x00/g, ".*");
  return new RegExp(`^${body}$`).test(path);
}

export function touchesAny(path: string, globs: string[] | undefined): boolean {
  if (!globs?.length) return false;
  return globs.some((glob) => matchesGlob(path, glob));
}

export interface Promotion {
  reader: string;
  writer: string;
  basis: "declared touches" | "inferred from text" | "conservative";
}

/** True when `from` transitively needs `target` in the declared dependency graph. */
function reaches(from: string, target: string, steps: Step[]): boolean {
  const byId = new Map(steps.map((step) => [step.id, step]));
  const seen = new Set<string>();
  const stack = [...(byId.get(from)?.needs ?? [])];
  while (stack.length) {
    const id = stack.pop()!;
    if (id === target) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...(byId.get(id)?.needs ?? []));
  }
  return false;
}

/**
 * A read step that could observe a partial write is ordered after that writer
 * (rev 5 answer). Returns the synthesized edges so the caller can re-order and report.
 */
export function promoteReaders(
  steps: Step[],
  roleAccess: Record<string, "read" | "write">,
): { edges: Array<[string, string]>; promotions: Promotion[] } {
  const edges: Array<[string, string]> = [];
  const promotions: Promotion[] = [];
  const writers = steps.filter((step) => roleAccess[step.role] === "write");
  for (const reader of steps) {
    if (roleAccess[reader.role] !== "read") continue;
    const declared = reader.needs ?? [];
    const mentioned = [...(reader.context ?? []), ...pathsIn(reader.objective), ...pathsIn(reader.deliverable)];
    for (const writer of writers) {
      // A writer that already depends on this reader must not gain an edge back to it,
      // or orderLevels reports a cycle for a valid plan (directly or transitively).
      if (writer.id === reader.id || declared.includes(writer.id) || reaches(writer.id, reader.id, steps)) continue;
      const targets = writer.touches ?? [];
      let basis: Promotion["basis"] | undefined;
      if (targets.length && mentioned.some((path) => touchesAny(path, targets))) {
        basis = "declared touches";
      } else if (!targets.length && mentioned.some((path) => pathsIn(writer.objective).some((p) => p.includes(path) || path.includes(p)))) {
        basis = "inferred from text";
      } else if (!mentioned.length && !targets.length) {
        basis = "conservative";
      }
      if (basis) {
        edges.push([reader.id, writer.id]);
        promotions.push({ reader: reader.id, writer: writer.id, basis });
      }
    }
  }
  return { edges, promotions };
}

export function totalUsage(nodes: Record<string, NodeState>): NodeUsage {
  const total: NodeUsage = { ...EMPTY_USAGE };
  for (const node of Object.values(nodes)) {
    total.input += node.usage.input;
    total.output += node.usage.output;
    total.cacheRead += node.usage.cacheRead;
    total.cacheWrite += node.usage.cacheWrite;
    total.totalTokens += node.usage.totalTokens;
    total.cost += node.usage.cost;
    total.costDetail.input += node.usage.costDetail?.input ?? 0;
    total.costDetail.output += node.usage.costDetail?.output ?? 0;
    total.costDetail.cacheRead += node.usage.costDetail?.cacheRead ?? 0;
    total.costDetail.cacheWrite += node.usage.costDetail?.cacheWrite ?? 0;
  }
  return total;
}

export function budgetExceeded(
  usage: NodeUsage,
  limits: { budget?: { tokens?: number; usd?: number } },
): boolean {
  const { tokens, usd } = limits.budget ?? {};
  if (tokens !== undefined && usage.totalTokens >= tokens) return true;
  if (usd !== undefined && usage.cost >= usd) return true;
  return false;
}

/** Clamp a requested read-parallelism to an integer in [1, limit]; absent means the limit. */
export function clampConcurrency(requested: number | undefined, limit: number): number {
  const max = Math.max(1, Math.floor(limit));
  if (requested === undefined || !Number.isFinite(requested)) return max;
  return Math.min(max, Math.max(1, Math.floor(requested)));
}

/** Total handoffs actually spent, not the number of nodes that escalated at least once. */
export function escalationsUsed(nodes: Record<string, NodeState>): number {
  return Object.values(nodes).reduce((sum, node) => sum + (node.attempts?.length ?? 0), 0);
}

export interface EscalationDecision {
  escalate: boolean;
  reason: string;
}

/**
 * Deterministic triggers only: explicit blocked, failed verification, thrown error or
 * timeout. A missing sentinel never escalates (rev 4, gap 6).
 */
export function shouldEscalate(
  node: NodeState,
  opts: { attemptsAllowed: number; escalationsUsed: number; maxEscalations: number },
): EscalationDecision {
  if (!node.escalateTarget) return { escalate: false, reason: "no escalation target configured" };
  if (node.attempts.length >= opts.attemptsAllowed) return { escalate: false, reason: "attempts exhausted" };
  if (opts.escalationsUsed >= opts.maxEscalations) return { escalate: false, reason: "run escalation budget exhausted" };
  if (node.status === "blocked") {
    return { escalate: true, reason: node.verification && !node.verification.ok ? "verification failed" : "child reported blocked" };
  }
  if (node.status === "failed") return { escalate: true, reason: node.error ?? "child failed" };
  return { escalate: false, reason: `status '${node.status}' is not an escalation trigger` };
}

function clip(text: string, width: number): string {
  if (width <= 1) return text.slice(0, Math.max(0, width));
  return text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`;
}

/** ANSI-free, width-safe rows. `decorate` lets the TUI color a row without changing its width. */
export function formatTreeRows(
  nodes: Record<string, NodeState>,
  opts: { width: number; maxRows?: number; decorate?: (text: string, node: NodeState) => string },
): string[] {
  // Derive the tree from parentId rather than trusting the denormalized `children` array, and
  // resolve nodes by id, so a mismatched map key or a stale children list cannot drop a subtree.
  const byId = new Map(Object.values(nodes).map((node) => [node.id, node]));
  const childrenOf = new Map<string, string[]>();
  for (const node of byId.values()) {
    if (!node.parentId || !byId.has(node.parentId)) continue;
    childrenOf.set(node.parentId, [...(childrenOf.get(node.parentId) ?? []), node.id]);
  }
  const roots = [...byId.values()].filter((node) => !node.parentId || !byId.has(node.parentId));
  const rows: string[] = [];
  const walk = (node: NodeState, prefix: string, isLast: boolean, depth: number): void => {
    const branch = depth === 0 ? "" : `${prefix}${isLast ? "└─ " : "├─ "}`;
    const childIds = childrenOf.get(node.id) ?? [];
    const descendants = childIds.length;
    const glyph = STATUS_GLYPH[node.status] ?? "?";
    const effort = node.thinking ? `:${node.thinking}` : "";
    const badges = [
      descendants ? `(+${descendants})` : "",
      node.attempts.length ? `↑${node.attempts.length}` : "",
      node.promotedBy?.length ? "⇢" : "",
      node.round > 1 ? `r${node.round}` : "",
      node.usage.totalTokens ? `${node.usage.totalTokens}t` : "",
    ].filter(Boolean);
    const head = `${branch}${glyph} ${node.role}`;
    const tail = ` ${badges.join(" ")}`.trimEnd();
    const middle = clip(`${node.model}${effort} — ${node.task}`, Math.max(8, opts.width - head.length - tail.length - 1));
    const row = clip(`${head} ${middle}${tail ? ` ${tail}` : ""}`, opts.width);
    rows.push(opts.decorate ? opts.decorate(row, node) : row);
    const childPrefix = depth === 0 ? "" : `${prefix}${isLast ? "   " : "│  "}`;
    childIds.forEach((childId, index) => {
      const child = byId.get(childId);
      if (child) walk(child, childPrefix, index === childIds.length - 1, depth + 1);
    });
  };
  roots.forEach((root, index) => walk(root, "", index === roots.length - 1, 0));
  return typeof opts.maxRows === "number" ? rows.slice(0, opts.maxRows) : rows;
}

export function sumUsage(usages: NodeUsage[]): NodeUsage {
  return usages.reduce<NodeUsage>((acc, usage) => ({
    input: acc.input + usage.input,
    output: acc.output + usage.output,
    cacheRead: acc.cacheRead + usage.cacheRead,
    cacheWrite: acc.cacheWrite + usage.cacheWrite,
    totalTokens: acc.totalTokens + usage.totalTokens,
    cost: acc.cost + usage.cost,
    costDetail: {
      input: acc.costDetail.input + (usage.costDetail?.input ?? 0),
      output: acc.costDetail.output + (usage.costDetail?.output ?? 0),
      cacheRead: acc.costDetail.cacheRead + (usage.costDetail?.cacheRead ?? 0),
      cacheWrite: acc.costDetail.cacheWrite + (usage.costDetail?.cacheWrite ?? 0),
    },
  }), { ...EMPTY_USAGE, costDetail: { ...EMPTY_USAGE.costDetail } });
}

/** Capped model-facing text; the full output always lives in the run directory. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, Math.floor(max * 0.6));
  const tail = text.slice(-Math.floor(max * 0.3));
  return `${head}\n\n[... ${text.length - head.length - tail.length} characters omitted; full output is in the run directory ...]\n\n${tail}`;
}

/** A declared verification passes only on the expected exit code. */
export function verificationOk(code: number, expectExit: number): boolean {
  return code === expectExit;
}

/** Files a writer changed that it never declared in `touches`. */
export function undeclaredChanges(changedFiles: string[], touches: string[] | undefined): string[] {
  if (!touches?.length) return [];
  return changedFiles.filter((path) => !touchesAny(path, touches));
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export interface LevelPlan {
  /** Steps to run now (already-ok steps are excluded). */
  runnable: string[];
  /** Steps that must not run because a dependency did not succeed. */
  skipped: Array<{ id: string; reason: string }>;
  /** One step per batch when a writer is present, otherwise bounded parallelism. */
  batches: string[][];
}

/**
 * Decide what a level may run: skip steps whose dependencies did not succeed, and never
 * run a writer next to anything else (A1: conflicting writes are the failure mode).
 */
export function planLevel(
  ids: string[],
  steps: Step[],
  nodes: Record<string, NodeState>,
  roleAccess: Record<string, "read" | "write">,
  maxConcurrent: number,
  extraEdges: Array<[string, string]> = [],
): LevelPlan {
  const byId = new Map(steps.map((step) => [step.id, step]));
  const extraDeps = new Map<string, string[]>();
  for (const [dependent, dependency] of extraEdges) {
    extraDeps.set(dependent, [...(extraDeps.get(dependent) ?? []), dependency]);
  }
  const pending = ids.filter((id) => nodes[id] && nodes[id].status !== "ok");
  const skipped: Array<{ id: string; reason: string }> = [];
  const runnable: string[] = [];
  for (const id of pending) {
    const blockedBy = [...(byId.get(id)?.needs ?? []), ...(extraDeps.get(id) ?? [])].filter(
      (need) => nodes[need] && nodes[need].status !== "ok",
    );
    if (blockedBy.length) {
      skipped.push({ id, reason: `dependencies did not succeed: ${blockedBy.join(", ")}` });
      continue;
    }
    runnable.push(id);
  }
  const hasWriter = runnable.some((id) => roleAccess[byId.get(id)?.role ?? ""] === "write");
  const batches = hasWriter ? runnable.map((id) => [id]) : chunk(runnable, Math.max(1, maxConcurrent));
  return { runnable, skipped, batches };
}
