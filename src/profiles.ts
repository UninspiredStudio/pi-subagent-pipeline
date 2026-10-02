/**
 * Profile discovery, validation and role resolution.
 *
 * Deliberately free of platform imports so `scripts/selfcheck.mjs` can exercise it
 * under `node --experimental-strip-types` with injected model/fs data.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
const THINKING_RANK: Record<string, number> = Object.fromEntries(
  THINKING_LEVELS.map((level, index) => [level, index]),
);

export type Access = "read" | "write";

export interface ModelLike {
  provider: string;
  id: string;
  name?: string;
  reasoning?: boolean;
  contextWindow?: number;
  cost?: { input?: number; output?: number };
}

export interface VerifyDef {
  command: string;
  expectExit?: number;
  timeoutMs?: number;
}

export interface EscalateDef {
  to: string;
  thinking?: ThinkingLevel;
  crossFamily?: boolean;
  maxAttempts?: number;
}

export interface ContextDef {
  projectFiles?: boolean;
  skills?: boolean;
}

export interface RoleDef {
  description?: string;
  prompt?: string;
  promptFile?: string;
  model?: string;
  thinking?: ThinkingLevel | false;
  provider?: string;
  access?: Access;
  tools?: string[];
  context?: ContextDef;
  verify?: VerifyDef;
  canSpawn?: string[];
  escalate?: EscalateDef;
  enabled?: boolean;
}

export interface ProfileLimits {
  maxThinking?: ThinkingLevel;
  maxNodes?: number;
  maxDepth?: number;
  maxConcurrent?: number;
  maxEscalations?: number;
  perStepTimeoutMs?: number;
  maxResultChars?: number;
  rosterInjectTokens?: number;
  allowUnavailableModels?: boolean;
  budget?: { tokens?: number; usd?: number };
}

export interface Profile {
  schemaVersion?: number;
  name?: string;
  description?: string;
  extends?: string;
  defaults?: { provider?: string; model?: string; thinking?: ThinkingLevel | false; tools?: string[]; context?: ContextDef };
  /** Default model and effort for the *parent* session while this profile is active. */
  parent?: { model?: string; thinking?: ThinkingLevel | false };
  limits?: ProfileLimits;
  runs?: { keep?: number; maxAgeDays?: number; pinUnfinished?: boolean };
  modelScope?: { enforce?: boolean; allow?: string[] };
  /** How readily the parent should delegate to the pipeline. `off` suppresses the guidance. */
  aggressiveness?: Aggressiveness;
  roles?: Record<string, RoleDef>;
}

/** How hard the injected guidance pushes the parent toward the pipeline. */
export type Aggressiveness = "low" | "medium" | "high" | "off";
export const AGGRESSIVENESS: readonly Aggressiveness[] = ["low", "medium", "high", "off"];

export interface ProfileSource {
  name: string;
  path: string;
  scope: "project" | "user" | "package";
  profile: Profile;
}

export interface ResolvedRole {
  name: string;
  description: string;
  prompt: string;
  access: Access;
  tools: string[];
  context: Required<ContextDef>;
  verify?: VerifyDef;
  canSpawn?: string[];
  escalate?: EscalateDef & { attempts: number };
  modelRef?: string;
  model?: ModelLike;
  thinking?: ThinkingLevel;
  inherit?: boolean;
}

export interface ResolvedProfile {
  source: ProfileSource;
  profile: Profile;
  roles: Record<string, ResolvedRole>;
  limits: Required<Omit<ProfileLimits, "budget">> & { budget?: { tokens?: number; usd?: number } };
  runs: { keep: number; maxAgeDays: number; pinUnfinished: boolean };
  aggressiveness?: Aggressiveness;
  /** Resolved parent defaults, applied to the main session rather than to children. */
  parent?: { model?: ModelLike; thinking?: ThinkingLevel };
  errors: string[];
  warnings: string[];
}

export interface ProfileDirs {
  cwd: string;
  agentDir: string;
  packageDir: string;
  trusted: boolean;
}

const DEFAULT_LIMITS = {
  maxThinking: "max" as ThinkingLevel,
  maxNodes: 12,
  maxDepth: 2,
  maxConcurrent: 3,
  maxEscalations: 3,
  perStepTimeoutMs: 300_000,
  maxResultChars: 8_000,
  rosterInjectTokens: 600,
  allowUnavailableModels: false,
};

const PROFILE_KEYS = new Set([
  "schemaVersion", "name", "description", "extends", "defaults", "parent", "limits", "runs", "modelScope", "aggressiveness", "roles",
]);
const ROLE_KEYS = new Set([
  "description", "prompt", "promptFile", "model", "thinking", "provider", "access", "tools", "context", "verify", "canSpawn", "escalate", "enabled",
]);
const READ_TOOLS = new Set(["read", "grep", "find", "ls"]);

function readJson(path: string): { value?: Profile; error?: string } {
  try {
    return { value: JSON.parse(readFileSync(path, "utf-8")) as Profile };
  } catch (error) {
    return { error: `${path}: ${(error as Error).message}` };
  }
}

function jsonFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir).filter((f) => f.endsWith(".json")).sort().map((f) => join(dir, f));
  } catch {
    return [];
  }
}

/** Project wins over user, user wins over package. */
export function discoverProfiles(dirs: ProfileDirs): { sources: Map<string, ProfileSource>; errors: string[] } {
  const scopes: Array<{ scope: ProfileSource["scope"]; dir: string }> = [];
  if (dirs.trusted) scopes.push({ scope: "project", dir: join(dirs.cwd, ".pi", "pipeline", "profiles") });
  scopes.push({ scope: "user", dir: join(dirs.agentDir, "profiles", "pipeline") });
  scopes.push({ scope: "package", dir: join(dirs.packageDir, "profiles") });

  const sources = new Map<string, ProfileSource>();
  const errors: string[] = [];
  for (const { scope, dir } of scopes) {
    for (const path of jsonFiles(dir)) {
      const name = basename(path, ".json");
      if (sources.has(name)) continue; // higher scope already claimed this name
      const { value, error } = readJson(path);
      if (error || !value) {
        errors.push(error ?? `${path}: empty profile`);
        continue;
      }
      sources.set(name, { name, path, scope, profile: value });
    }
  }
  return { sources, errors };
}

function mergeDefaults(base?: Profile["defaults"], child?: Profile["defaults"]): Profile["defaults"] {
  if (!base) return child;
  if (!child) return base;
  return {
    ...base,
    ...child,
    context: { ...(base.context ?? {}), ...(child.context ?? {}) },
  };
}

/** Resolve `extends` chains (child overrides parent), nearest parent first. */
export function resolveChain(name: string, sources: Map<string, ProfileSource>): { profile?: Profile; source?: ProfileSource; errors: string[] } {
  const errors: string[] = [];
  const seen = new Set<string>();
  const chain: ProfileSource[] = [];
  let current = name;
  while (current) {
    if (seen.has(current)) {
      errors.push(`profile '${name}': extends cycle at '${current}'`);
      return { errors };
    }
    seen.add(current);
    const source = sources.get(current);
    if (!source) {
      if (chain.length === 0) errors.push(`profile '${name}' not found`);
      else errors.push(`profile '${chain[chain.length - 1].name}': extends unknown profile '${current}'`);
      return { errors };
    }
    chain.push(source);
    current = source.profile.extends ?? "";
  }

  const source = chain[0];
  // A user profile must not extend a project profile (untrusted content would leak upward).
  for (let i = 1; i < chain.length; i += 1) {
    if (chain[i].scope === "project" && source.scope !== "project") {
      errors.push(`profile '${name}' (${source.scope}) may not extend project profile '${chain[i].name}'`);
    }
  }

  let merged: Profile = {};
  const roles: Record<string, RoleDef> = {};
  for (let i = chain.length - 1; i >= 0; i -= 1) {
    const layer = chain[i].profile;
    merged = {
      ...merged,
      ...layer,
      defaults: mergeDefaults(merged.defaults, layer.defaults),
      parent: { ...(merged.parent ?? {}), ...(layer.parent ?? {}) },
      limits: { ...(merged.limits ?? {}), ...(layer.limits ?? {}) },
      runs: { ...(merged.runs ?? {}), ...(layer.runs ?? {}) },
      modelScope: layer.modelScope ?? merged.modelScope,
      roles: undefined,
    };
    const layerDir = dirname(chain[i].path);
    for (const [roleName, role] of Object.entries(layer.roles ?? {})) {
      const inherited = { ...(roles[roleName] ?? {}) };
      const next: RoleDef = { ...inherited, ...role };
      // A layer that defines its own prompt source wins over an inherited one.
      if (role.prompt !== undefined) next.prompt = role.prompt;
      else if (role.promptFile !== undefined) next.prompt = undefined;
      // Resolve this layer's promptFile against this layer's own directory, so a profile
      // that inherits the role keeps the real prompt instead of falling back to a stub.
      if (!next.prompt && next.promptFile) {
        for (const candidate of [join(layerDir, next.promptFile), join(layerDir, "roles", next.promptFile)]) {
          if (existsSync(candidate)) {
            next.prompt = readFileSync(candidate, "utf-8").trim();
            break;
          }
        }
      }
      roles[roleName] = next;
    }
  }
  merged.roles = roles;
  merged.name = source.profile.name ?? source.name;
  return { profile: merged, source, errors };
}

function normalizeId(id: string): string {
  return id
    .toLowerCase()
    .replace(/[._]/g, "-")
    .replace(/-\d{8}$/, "")
    .replace(/-\d{4}-\d{2}-\d{2}$/, "");
}

function matchIn(models: ModelLike[], id: string): ModelLike[] {
  const plain = models.filter((m) => m.id === id);
  if (plain.length) return plain;
  const lower = models.filter((m) => m.id.toLowerCase() === id.toLowerCase());
  if (lower.length) return lower;
  const norm = normalizeId(id);
  const normalized = models.filter((m) => normalizeId(m.id) === norm);
  if (normalized.length) return normalized;
  return models.filter((m) => normalizeId(m.id).startsWith(norm) || m.id.toLowerCase().startsWith(id.toLowerCase()));
}

function splitThinking(ref: string): { modelRef: string; thinking?: ThinkingLevel } {
  const match = /^(.*):([a-z]+)$/.exec(ref);
  if (match && (THINKING_LEVELS as readonly string[]).includes(match[2])) {
    return { modelRef: match[1], thinking: match[2] as ThinkingLevel };
  }
  return { modelRef: ref };
}

/** Resolve `provider/id`, `inherit` or a bare id (preferring `preferredProvider`). */
export function resolveModelRef(
  ref: string,
  models: ModelLike[],
  preferredProvider?: string,
): { model?: ModelLike; thinking?: ThinkingLevel; inherit?: boolean; error?: string } {
  const { modelRef, thinking } = splitThinking(ref);
  if (modelRef === "inherit") return { inherit: true, thinking };
  if (!modelRef) return { error: "empty model reference" };

  if (modelRef.includes("/")) {
    const slash = modelRef.indexOf("/");
    const provider = modelRef.slice(0, slash);
    const id = modelRef.slice(slash + 1);
    const scoped = models.filter((m) => m.provider === provider);
    const found = matchIn(scoped, id);
    if (!found.length) return { error: `model '${modelRef}' is not in the registry` };
    if (found.length > 1) return { error: `model '${modelRef}' is ambiguous (${found.map((m) => m.id).join(", ")})` };
    return { model: found[0], thinking };
  }

  const found = matchIn(models, modelRef);
  if (!found.length) return { error: `model '${modelRef}' is not in the registry` };
  const providers = new Set(found.map((m) => m.provider));
  if (providers.size === 1) return { model: found[0], thinking };
  const preferred = preferredProvider ? found.filter((m) => m.provider === preferredProvider) : [];
  if (preferred.length === 1) return { model: preferred[0], thinking };
  return { error: `model '${modelRef}' exists under ${[...providers].join(", ")}; qualify it as provider/id` };
}

function globToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

function scopeAllows(model: ModelLike, allow: string[]): boolean {
  return allow.some((pattern) => globToRegex(pattern).test(`${model.provider}/${model.id}`));
}

function deriveAccess(role: RoleDef): Access {
  const tools = role.tools ?? [];
  return tools.includes("edit") || tools.includes("write") ? "write" : (role.access ?? "read");
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function promptForRole(role: RoleDef, name: string, dir: string): string {
  if (role.prompt && role.prompt.trim()) return role.prompt.trim();
  if (role.promptFile) {
    for (const candidate of [join(dir, role.promptFile), join(dir, "roles", role.promptFile)]) {
      if (existsSync(candidate)) return readFileSync(candidate, "utf-8").trim();
    }
  }
  const auto = join(dir, `${name}.md`);
  if (existsSync(auto)) return readFileSync(auto, "utf-8").trim();
  return `You are the '${name}' subagent. ${role.description ?? ""}`.trim();
}

export interface ValidationInput {
  models: ModelLike[];
  available: ModelLike[];
  parentModel?: ModelLike;
  maxThinking?: ThinkingLevel;
}

export function validateProfile(profile: Profile, source: ProfileSource, input: ValidationInput): ResolvedProfile {
  const errors: string[] = [];
  const warnings: string[] = [];
  const dir = join(source.path, "..");

  if (profile.schemaVersion !== undefined && profile.schemaVersion !== 1) {
    errors.push(`unsupported schemaVersion ${profile.schemaVersion} (expected 1)`);
  }
  for (const key of Object.keys(profile)) {
    if (!PROFILE_KEYS.has(key)) warnings.push(`unknown profile key '${key}' (ignored)`);
  }
  if (profile.aggressiveness !== undefined && !AGGRESSIVENESS.includes(profile.aggressiveness)) {
    errors.push(`aggressiveness '${profile.aggressiveness}' is not one of ${AGGRESSIVENESS.join("|")}`);
  }

  const limits = { ...DEFAULT_LIMITS, ...(profile.limits ?? {}) };
  if (input.maxThinking && THINKING_RANK[input.maxThinking] < THINKING_RANK[limits.maxThinking]) {
    limits.maxThinking = input.maxThinking;
  }
  const ceiling = THINKING_RANK[limits.maxThinking];
  const scope = profile.modelScope?.enforce ? (profile.modelScope.allow ?? []) : undefined;
  const availableKeys = new Set(input.available.map((m) => `${m.provider}/${m.id}`));

  const roles: Record<string, ResolvedRole> = {};
  for (const [name, rawRole] of Object.entries(profile.roles ?? {})) {
    const role = rawRole ?? {};
    if (role.enabled === false) continue;
    for (const key of Object.keys(role)) {
      if (!ROLE_KEYS.has(key)) warnings.push(`role '${name}': unknown key '${key}' (ignored)`);
    }
    if (!role.description || !role.description.trim()) {
      errors.push(`role '${name}': description is required`);
    }
    const access = deriveAccess(role);
    if (role.access === "read" && (role.tools ?? []).some((t) => t === "edit" || t === "write")) {
      errors.push(`role '${name}': access 'read' contradicts tools (${(role.tools ?? []).join(", ")})`);
    }
    const ref = role.model ?? profile.defaults?.model;
    const provider = role.provider ?? profile.defaults?.provider;
    let model: ModelLike | undefined;
    let inherit = false;
    const requestedThinking = role.thinking ?? profile.defaults?.thinking;
    let thinking: ThinkingLevel | undefined = requestedThinking === false ? undefined : requestedThinking;

    if (!ref) {
      inherit = true;
      model = input.parentModel;
    } else {
      const resolved = resolveModelRef(ref, input.models, provider);
      if (resolved.error) {
        errors.push(`role '${name}': ${resolved.error}`);
      } else {
        inherit = resolved.inherit ?? false;
        model = resolved.model ?? input.parentModel;
        thinking = resolved.thinking ?? thinking;
      }
    }

    if (thinking && THINKING_RANK[thinking] > ceiling) {
      errors.push(`role '${name}': thinking '${thinking}' exceeds maxThinking '${limits.maxThinking}'`);
    }
    if (thinking && model && !model.reasoning) {
      warnings.push(`role '${name}': thinking '${thinking}' requested but '${model.id}' does not declare reasoning`);
    }
    if (model && scope && !scopeAllows(model, scope)) {
      errors.push(`role '${name}': model '${model.provider}/${model.id}' is outside modelScope`);
    }
    if (model && !limits.allowUnavailableModels && !availableKeys.has(`${model.provider}/${model.id}`) && !inherit) {
      errors.push(`role '${name}': model '${model.provider}/${model.id}' has no usable credentials`);
    }

    if (role.verify !== undefined) {
      if (!role.verify.command || !role.verify.command.trim()) {
        errors.push(`role '${name}': verify.command must be a non-empty string`);
      }
      if (role.verify.timeoutMs !== undefined && !(role.verify.timeoutMs > 0)) {
        errors.push(`role '${name}': verify.timeoutMs must be positive`);
      }
    }

    const escalate = role.escalate;
    if (escalate) {
      const attempts = escalate.maxAttempts ?? 1;
      if (attempts < 1 || attempts > 3) errors.push(`role '${name}': escalate.maxAttempts must be 1..3`);
      const targetIsRole = Object.prototype.hasOwnProperty.call(profile.roles ?? {}, escalate.to);
      let targetModel: ModelLike | undefined;
      if (targetIsRole) {
        targetModel = resolveModelRef(profile.roles![escalate.to]?.model ?? profile.defaults?.model ?? "", input.models, provider).model;
      } else {
        const resolvedTarget = resolveModelRef(escalate.to, input.models, provider);
        if (resolvedTarget.error) errors.push(`role '${name}': escalate.to '${escalate.to}': ${resolvedTarget.error}`);
        targetModel = resolvedTarget.model;
      }
      if (targetIsRole && escalate.to === name) {
        errors.push(`role '${name}': escalate.to may not be itself`);
      }
      if (targetModel && model && targetModel.provider === model.provider) {
        warnings.push(
          escalate.crossFamily === true
            ? `role '${name}': escalate.crossFamily is set but '${escalate.to}' is in the same provider family (${model.provider})`
            : `role '${name}': escalation stays inside provider family (${model.provider}); cross-family escalation is stronger`,
        );
      }
      const sameModel = Boolean(
        targetModel && model && targetModel.id === model.id && targetModel.provider === model.provider,
      );
      if (sameModel && (escalate.thinking ?? thinking) === thinking) {
        errors.push(`role '${name}': escalate.to resolves to the same model and thinking level, so escalation could not change anything`);
      } else if (sameModel) {
        warnings.push(`role '${name}': escalation is the same model at a higher thinking level; a different model is a stronger escalation`);
      }
      if (escalate.thinking && THINKING_RANK[escalate.thinking] > ceiling) {
        errors.push(`role '${name}': escalate.thinking '${escalate.thinking}' exceeds maxThinking '${limits.maxThinking}'`);
      }
      if (targetModel && scope && !scopeAllows(targetModel, scope)) {
        errors.push(`role '${name}': escalate target '${targetModel.provider}/${targetModel.id}' is outside modelScope`);
      }
    }

    roles[name] = {
      name,
      description: role.description ?? "",
      prompt: promptForRole(role, name, dir),
      access,
      tools: role.tools ?? profile.defaults?.tools ?? [...READ_TOOLS, "bash"],
      context: {
        projectFiles: role.context?.projectFiles ?? profile.defaults?.context?.projectFiles ?? true,
        skills: role.context?.skills ?? profile.defaults?.context?.skills ?? false,
      },
      verify: role.verify,
      canSpawn: role.canSpawn,
      escalate: escalate ? { ...escalate, attempts: escalate.maxAttempts ?? 1 } : undefined,
      modelRef: ref,
      model,
      thinking,
      inherit,
    };
  }

  let parent: { model?: ModelLike; thinking?: ThinkingLevel } | undefined;
  if (profile.parent) {
    const requested = profile.parent.thinking;
    let parentThinking: ThinkingLevel | undefined = requested === false ? undefined : requested;
    let parentModel: ModelLike | undefined;
    if (profile.parent.model) {
      const resolvedParent = resolveModelRef(profile.parent.model, input.models, profile.defaults?.provider);
      if (resolvedParent.error) {
        errors.push(`parent: ${resolvedParent.error}`);
      } else {
        parentModel = resolvedParent.model;
        parentThinking = resolvedParent.thinking ?? parentThinking;
        if (parentModel && scope && !scopeAllows(parentModel, scope)) {
          warnings.push(`parent: ${parentModel.provider}/${parentModel.id} is outside modelScope, which covers roles`);
        }
        if (parentModel && !limits.allowUnavailableModels && !availableKeys.has(`${parentModel.provider}/${parentModel.id}`)) {
          errors.push(`parent: model '${parentModel.provider}/${parentModel.id}' has no usable credentials`);
        }
      }
    }
    if (parentThinking && THINKING_RANK[parentThinking] > ceiling) {
      errors.push(`parent: thinking '${parentThinking}' exceeds maxThinking '${limits.maxThinking}'`);
    }
    parent = { model: parentModel, thinking: parentThinking };
  }
  for (const [name, role] of Object.entries(roles)) {
    for (const target of role.canSpawn ?? []) {
      if (!Object.prototype.hasOwnProperty.call(roles, target)) {
        errors.push(`role '${name}': canSpawn '${target}' is not a role in this profile`);
      }
    }
  }

  return {
    source,
    profile,
    roles,
    limits,
    runs: { keep: profile.runs?.keep ?? 20, maxAgeDays: profile.runs?.maxAgeDays ?? 7, pinUnfinished: profile.runs?.pinUnfinished ?? true },
    aggressiveness: profile.aggressiveness,
    parent,
    errors,
    warnings,
  };
}

/** Short roster for injection, or a pointer when the roster is too large (gap 1). */
export function renderRoster(resolved: ResolvedProfile): { mode: "injected" | "pointer"; text: string } {
  const names = Object.keys(resolved.roles);
  const lines = names.map((name) => {
    const role = resolved.roles[name];
    const model = role.model ? `${role.model.provider}/${role.model.id}` : "inherit";
    const effort = role.thinking ? `:${role.thinking}` : "";
    return `- ${name} (${role.access}, ${model}${effort}): ${role.description}`;
  });
  const header = `Active profile: ${resolved.profile.name ?? resolved.source.name} (${resolved.source.path})`;
  const injected = [header, ...lines].join("\n");
  if (estimateTokens(injected) <= resolved.limits.rosterInjectTokens) {
    return { mode: "injected", text: injected };
  }
  const summary = names.map((name) => `${name} (${resolved.roles[name].access})`).join(", ");
  return {
    mode: "pointer",
    text: `${header}\nRoles (${names.length}): ${summary}\nCall pipeline_status({action:"roster"}) before planning; do not guess role names.`,
  };
}

/** Cost used for tiering; a model with no declared cost is treated as free (usually local). */
function costOf(model: ModelLike): number {
  const cost = model.cost?.input;
  return typeof cost === "number" && Number.isFinite(cost) ? cost : 0;
}

/** Which tier a role should get: cheap recon, strong judgment, mid for everything else. */
export function tierForRole(roleName: string): "cheap" | "mid" | "strong" {
  if (/scout|recon|search|explore/i.test(roleName)) return "cheap";
  if (/oracle|planner|architect|audit|design|review/i.test(roleName)) return "strong";
  return "mid";
}

/**
 * Rank the accessible models into the three tiers the roster uses, cheapest first.
 * Suggestions only: the user confirms or replaces each pick.
 */
export function suggestModelTiers(models: ModelLike[]): { cheap?: ModelLike; mid?: ModelLike; strong?: ModelLike } {
  const ranked = [...models].sort((a, b) => costOf(a) - costOf(b));
  if (!ranked.length) return {};
  const third = Math.max(1, Math.floor(ranked.length / 3));
  return {
    cheap: ranked[0],
    mid: ranked[Math.min(ranked.length - 1, third)],
    strong: ranked[ranked.length - 1],
  };
}

export type ModelTierPicks = { cheap: string; mid: string; strong: string };

/**
 * Build a profile that layers user-chosen models onto an existing roster via `extends`.
 * Only `model` (and a matching escalation on write roles) is set; prompts, tools, access
 * and spawn rights stay with the base profile.
 */
export function buildModelsProfile(name: string, base: string, picks: ModelTierPicks, roleNames: string[]): Profile {
  const roles: Record<string, RoleDef> = {};
  const modelFor = (roleName: string): string => picks[tierForRole(roleName)] ?? picks.mid;
  for (const roleName of roleNames) {
    const role: RoleDef = { model: modelFor(roleName) };
    if (/worker|coder|build/i.test(roleName) && picks.strong !== picks.mid) {
      role.escalate = { to: picks.strong, thinking: "xhigh", maxAttempts: 1 };
    }
    roles[roleName] = role;
  }
  return {
    schemaVersion: 1,
    name,
    description: `Models chosen from the accessible registry for the '${base}' roster.`,
    extends: base,
    roles,
  };
}

/** Metadata-only roster generation from the live registry (no probes). */
export function generateProfile(provider: string, models: ModelLike[], roleNames: string[]): Profile {
  const scoped = models.filter((m) => m.provider === provider);
  const ranked = [...scoped].sort((a, b) => (a.cost?.input ?? 0) - (b.cost?.input ?? 0));
  const third = Math.max(1, Math.floor(ranked.length / 3));
  const tiers = {
    cheap: ranked[0],
    mid: ranked[Math.min(ranked.length - 1, third)],
    strong: ranked[ranked.length - 1],
  };
  const roles: Record<string, RoleDef> = {};
  for (const roleName of roleNames) {
    const tier = /scout|recon|search|explore|review/i.test(roleName)
      ? "cheap"
      : /oracle|planner|architect|audit|design/i.test(roleName)
        ? "strong"
        : "mid";
    const model = tiers[tier] ?? tiers.mid;
    roles[roleName] = {
      description: `${roleName} (generated) ${tier} tier from the ${provider} catalog`,
      model: model ? `${model.provider}/${model.id}` : undefined,
      access: /worker|writer|coder|build/i.test(roleName) ? "write" : "read",
      canSpawn: [],
    };
  }
  return {
    schemaVersion: 1,
    name: `${provider}-generated`,
    description: `Generated from the ${provider} model catalog (metadata only)`,
    roles,
  };
}
