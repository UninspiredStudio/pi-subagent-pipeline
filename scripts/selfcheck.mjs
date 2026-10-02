/**
 * Assert-based self-check. No framework, no platform imports, no token cost.
 * Run: node --experimental-strip-types scripts/selfcheck.mjs
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  THINKING_LEVELS,
  discoverProfiles,
  generateProfile,
  buildModelsProfile,
  renderRoster,
  resolveChain,
  resolveModelRef,
  suggestModelTiers,
  tierForRole,
  validateProfile,
} from "../src/profiles.ts";
import {
  EMPTY_USAGE,
  blockedReason,
  budgetExceeded,
  clampConcurrency,
  emptyNode,
  escalationsUsed,
  formatTreeRows,
  matchesGlob,
  orderLevels,
  parseSentinel,
  planLevel,
  promoteReaders,
  shouldEscalate,
  sumUsage,
  totalUsage,
  touchesAny,
  truncate,
  undeclaredChanges,
  validateSteps,
  verificationOk,
} from "../src/plan.ts";
import { listRuns, planPrune, readRun, runDirSize, writeRun } from "../src/runs.ts";

let passed = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (error) {
    failures.push(`${name}: ${error.message}`);
  }
}

const MODELS = [
  { provider: "p", id: "cheap", reasoning: false },
  { provider: "p", id: "mid", reasoning: true },
  { provider: "p", id: "strong", reasoning: true },
  { provider: "q", id: "other", reasoning: true },
];
const AVAILABLE = MODELS.slice(0, 3);
const SRC = { name: "default", path: "/tmp/x/default.json", scope: "user", profile: {} };

function role(extra) {
  return { description: "a role", ...extra };
}
function check(profile, models = MODELS, available = AVAILABLE, extra = {}) {
  return validateProfile(profile, SRC, { models, available, ...extra });
}
function tempDir() {
  return mkdtempSync(join(tmpdir(), "pipeline-selfcheck-"));
}

/** Guarded read: a missing or malformed fixture must fail loudly, not as a parse stack. */
function readJson(url) {
  try {
    return JSON.parse(readFileSync(url, "utf-8"));
  } catch (error) {
    throw new Error(`cannot read ${url.pathname}: ${error.message}`);
  }
}

// ---------------------------------------------------------------- profiles

test("scope precedence: project beats user beats package", () => {
  const root = tempDir();
  const dirs = { cwd: join(root, "proj"), agentDir: join(root, "user"), packageDir: join(root, "pkg") };
  for (const dir of [
    join(dirs.packageDir, "profiles"),
    join(dirs.agentDir, "profiles", "pipeline"),
    join(dirs.cwd, ".pi", "pipeline", "profiles"),
  ]) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "dup.json"), JSON.stringify({ name: "dup" }), "utf-8");
  }
  const trusted = discoverProfiles({ ...dirs, trusted: true });
  assert.equal(trusted.sources.get("dup").scope, "project");
  const untrusted = discoverProfiles({ ...dirs, trusted: false });
  assert.equal(untrusted.sources.get("dup").scope, "user", "project profiles must be ignored when untrusted");
  rmSync(root, { recursive: true, force: true });
});

test("extends merges roles and defaults, child wins", () => {
  const sources = new Map([
    ["base", { name: "base", path: "/b.json", scope: "user", profile: { defaults: { thinking: "low" }, roles: { a: role({ model: "p/cheap" }) } } }],
    ["child", { name: "child", path: "/c.json", scope: "user", profile: { extends: "base", roles: { a: role({ thinking: "high" }), b: role({}) } } }],
  ]);
  const { profile, errors } = resolveChain("child", sources);
  assert.deepEqual(errors, []);
  assert.equal(profile.roles.a.thinking, "high");
  assert.equal(profile.roles.a.model, "p/cheap", "unset fields must inherit from the parent profile");
  assert.ok(profile.roles.b);
});

test("an inherited role keeps the prompt from the layer that defined it", () => {
  const root = tempDir();
  writeFileSync(join(root, "scout.md"), "REAL PROMPT BODY", "utf-8");
  const sources = new Map([
    ["base", { name: "base", path: join(root, "base.json"), scope: "user", profile: { roles: { scout: role({ model: "p/mid", promptFile: "scout.md" }) } } }],
    ["ladder", { name: "ladder", path: "/elsewhere/ladder.json", scope: "user", profile: { extends: "base", roles: { scout: { thinking: "minimal" } } } }],
  ]);
  const { profile } = resolveChain("ladder", sources);
  const resolved = validateProfile(profile, { ...SRC, path: "/elsewhere/ladder.json" }, { models: MODELS, available: AVAILABLE });
  assert.match(resolved.roles.scout.prompt, /REAL PROMPT BODY/, "an inheriting profile must keep the defining layer's prompt");
  assert.equal(resolved.roles.scout.thinking, "minimal");
  rmSync(root, { recursive: true, force: true });
});

test("extends cycle is rejected", () => {
  const sources = new Map([
    ["a", { name: "a", path: "/a.json", scope: "user", profile: { extends: "b" } }],
    ["b", { name: "b", path: "/b.json", scope: "user", profile: { extends: "a" } }],
  ]);
  assert.match(resolveChain("a", sources).errors.join(" "), /cycle/);
});

test("a user profile may not extend a project profile", () => {
  const sources = new Map([
    ["child", { name: "child", path: "/c.json", scope: "user", profile: { extends: "proj" } }],
    ["proj", { name: "proj", path: "/p.json", scope: "project", profile: {} }],
  ]);
  assert.match(resolveChain("child", sources).errors.join(" "), /may not extend project/);
});

test("unknown keys are reported, not ignored silently", () => {
  const resolved = check({ nonsense: 1, roles: { a: role({ bogus: 2 }) } });
  assert.match(resolved.warnings.join(" "), /unknown profile key 'nonsense'/);
  assert.match(resolved.warnings.join(" "), /role 'a': unknown key 'bogus'/);
});

test("access is derived from tools and contradictions are errors", () => {
  assert.equal(check({ roles: { w: role({ tools: ["read", "write"] }) } }).roles.w.access, "write");
  assert.equal(check({ roles: { r: role({ tools: ["read"] }) } }).roles.r.access, "read");
  assert.match(check({ roles: { r: role({ access: "read", tools: ["edit"] }) } }).errors.join(" "), /contradicts tools/);
});

test("aggressiveness accepts low|medium|high|off and rejects anything else", () => {
  for (const level of ["low", "medium", "high", "off"]) {
    assert.equal(check({ aggressiveness: level, roles: { a: role({ model: "p/mid" }) } }).aggressiveness, level);
  }
  const unresolved = check({ aggressiveness: "medium", roles: {} });
  assert.equal(unresolved.aggressiveness, "medium");
  assert.equal(check({ roles: {} }).aggressiveness, undefined);
  assert.match(check({ aggressiveness: "always", roles: {} }).errors.join(" "), /aggressiveness 'always' is not one of low\|medium\|high\|off/);
});

test("zero roles and 100 roles are both valid", () => {
  assert.deepEqual(check({ roles: {} }).errors, []);
  const roles = {};
  for (let i = 0; i < 100; i += 1) roles[`r${i}`] = role({ model: "p/mid" });
  const resolved = check({ roles });
  assert.deepEqual(resolved.errors, []);
  assert.equal(Object.keys(resolved.roles).length, 100);
});

test("description is required per role", () => {
  assert.match(check({ roles: { a: { model: "p/mid" } } }).errors.join(" "), /description is required/);
});

test("an unresolved model names the model", () => {
  assert.match(check({ roles: { a: role({ model: "p/missing" }) } }).errors.join(" "), /'p\/missing' is not in the registry/);
});

test("an unauthenticated model fails preflight unless allowed", () => {
  const strict = check({ roles: { a: role({ model: "q/other" }) } });
  assert.match(strict.errors.join(" "), /no usable credentials/);
  const lenient = check({ limits: { allowUnavailableModels: true }, roles: { a: role({ model: "q/other" }) } });
  assert.deepEqual(lenient.errors, []);
});

test("maxThinking ceiling is enforced", () => {
  const resolved = check({ limits: { maxThinking: "low" }, roles: { a: role({ model: "p/mid", thinking: "high" }) } });
  assert.match(resolved.errors.join(" "), /exceeds maxThinking/);
});

test("thinking on a non-reasoning model warns", () => {
  const resolved = check({ roles: { a: role({ model: "p/cheap", thinking: "high" }) } });
  assert.match(resolved.warnings.join(" "), /does not declare reasoning/);
});

test("modelScope rejects models outside the allow list", () => {
  const resolved = check({ modelScope: { enforce: true, allow: ["q/*"] }, roles: { a: role({ model: "p/mid" }) } });
  assert.match(resolved.errors.join(" "), /outside modelScope/);
});

test("canSpawn must name roles; omission means unrestricted", () => {
  assert.match(check({ roles: { a: role({ canSpawn: ["ghost"] }) } }).errors.join(" "), /canSpawn 'ghost' is not a role/);
  assert.equal(check({ roles: { a: role({}) } }).roles.a.canSpawn, undefined);
  assert.deepEqual(check({ roles: { a: role({ canSpawn: [] }) } }).roles.a.canSpawn, []);
});

test("self-escalation is rejected; a no-op escalation errors and an effort-only one warns", () => {
  const self = check({ roles: { a: role({ model: "p/mid", escalate: { to: "a" } }) } });
  assert.match(self.errors.join(" "), /may not be itself/);
  const noop = check({ roles: { a: role({ model: "p/mid", escalate: { to: "p/mid" } }) } });
  assert.match(noop.errors.join(" "), /could not change anything/);
  const effortOnly = check({
    roles: { a: role({ model: "p/mid", thinking: "low", escalate: { to: "p/mid", thinking: "max" } }) },
  });
  assert.deepEqual(effortOnly.errors, [], "the same model at a higher effort is a legitimate ladder");
  assert.match(effortOnly.warnings.join(" "), /same model at a higher thinking level/);
});

test("cross-family escalation that stays in-family warns but loads", () => {
  const resolved = check({ roles: { a: role({ model: "p/mid", escalate: { to: "p/strong", crossFamily: true } }) } });
  assert.deepEqual(resolved.errors, []);
  assert.match(resolved.warnings.join(" "), /same provider family/);
});

test("escalate.maxAttempts is bounded", () => {
  const resolved = check({ roles: { a: role({ model: "p/mid", escalate: { to: "p/strong", maxAttempts: 9 } }) } });
  assert.match(resolved.errors.join(" "), /must be 1\.\.3/);
});

test("a profile can set the parent model and effort", () => {
  const ok = check({ parent: { model: "p/mid", thinking: "low" }, roles: {} });
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.parent.model.id, "mid");
  assert.equal(ok.parent.thinking, "low");
  assert.match(check({ parent: { model: "p/ghost" }, roles: {} }).errors.join(" "), /parent: model .p\/ghost. is not in the registry/);
  assert.match(check({ parent: { model: "q/other" }, roles: {} }).errors.join(" "), /parent: model .q\/other. has no usable credentials/);
  assert.match(
    check({ limits: { maxThinking: "low" }, parent: { model: "p/mid", thinking: "xhigh" }, roles: {} }).errors.join(" "),
    /parent: thinking 'xhigh' exceeds maxThinking/,
  );
  const effortOnly = check({ parent: { thinking: "medium" }, roles: {} });
  assert.deepEqual(effortOnly.errors, [], "an effort-only parent default is valid");
  assert.equal(effortOnly.parent.model, undefined);
});

test("parent settings inherit through extends", () => {
  const sources = new Map([
    ["base", { name: "base", path: "/b.json", scope: "user", profile: { parent: { model: "p/mid", thinking: "low" } } }],
    ["child", { name: "child", path: "/c.json", scope: "user", profile: { extends: "base", parent: { thinking: "high" } } }],
  ]);
  const { profile } = resolveChain("child", sources);
  assert.equal(profile.parent.model, "p/mid");
  assert.equal(profile.parent.thinking, "high");
});

test("roster is injected when small and a pointer when large", () => {
  const small = check({ roles: { scout: role({ model: "p/cheap" }), worker: role({ model: "p/mid" }) } });
  assert.equal(renderRoster(small).mode, "injected");
  const roles = {};
  for (let i = 0; i < 100; i += 1) roles[`role-${i}`] = role({ model: "p/mid" });
  const large = check({ roles });
  const rendered = renderRoster(large);
  assert.equal(rendered.mode, "pointer");
  assert.match(rendered.text, /pipeline_status/);
});

test("model references support provider/id, bare id and :thinking", () => {
  assert.equal(resolveModelRef("p/mid", MODELS).model.id, "mid");
  const withThinking = resolveModelRef("p/mid:high", MODELS);
  assert.equal(withThinking.thinking, "high");
  assert.equal(resolveModelRef("mid", MODELS).model.id, "mid");
  assert.equal(resolveModelRef("inherit", MODELS).inherit, true);
  assert.match(resolveModelRef("nope", MODELS).error, /not in the registry/);
});

test("generation is metadata-only and tier-aware", () => {
  const generated = generateProfile("p", MODELS, ["scout", "worker"]);
  assert.equal(generated.roles.scout.access, "read");
  assert.equal(generated.roles.worker.access, "write");
  assert.ok(generated.roles.scout.model.startsWith("p/"));
  assert.deepEqual(generated.roles.scout.canSpawn, []);
});

test("the shipped starter profile is the seven declared roles with the documented spawn rights", () => {
  const path = new URL("../profiles/default.json", import.meta.url);
  const raw = readJson(path);
  const declared = new Set();
  for (const roleDef of Object.values(raw.roles ?? {})) {
    if (typeof roleDef.model === "string") declared.add(roleDef.model);
    if (typeof roleDef.escalate?.to === "string" && roleDef.escalate.to.includes("/")) declared.add(roleDef.escalate.to);
  }
  const models = [...declared].map((ref) => {
    const slash = ref.indexOf("/");
    return { provider: ref.slice(0, slash), id: ref.slice(slash + 1), reasoning: true };
  });
  const resolved = validateProfile(raw, { ...SRC, path: path.pathname }, { models, available: models });
  assert.deepEqual(resolved.errors, [], `the shipped profile must validate: ${resolved.errors.join("; ")}`);
  assert.deepEqual(Object.keys(resolved.roles).sort(), ["oracle", "planner", "researcher", "reviewer", "scout", "worker", "writer"]);
  assert.deepEqual(resolved.roles.scout.canSpawn, [], "scout is the cheapest role and must stay a leaf");
  assert.deepEqual(resolved.roles.researcher.canSpawn, [], "researcher has no cheaper helper and must stay a leaf");
  assert.deepEqual(resolved.roles.worker.canSpawn, ["scout", "reviewer"]);
  assert.deepEqual(resolved.roles.reviewer.canSpawn, ["scout"]);
  assert.deepEqual(resolved.roles.oracle.canSpawn, ["scout"]);
  assert.deepEqual(resolved.roles.planner.canSpawn, ["scout"]);
  assert.equal(resolved.roles.writer.access, "write");
  assert.deepEqual(resolved.roles.writer.canSpawn, ["scout", "researcher"]);
  // A shipped profile must not assume a provider: the user picks models with /pipeline-init.
  for (const roleDef of Object.values(raw.roles ?? {})) {
    assert.equal(roleDef.model, undefined, "the shipped profile must not pin a model");
    assert.equal(roleDef.escalate, undefined, "the shipped profile must not pin an escalation model");
  }
  assert.equal(raw.parent?.model, undefined, "the shipped profile must not pin a parent model");
  assert.equal(Object.values(resolved.roles).some((r) => r.modelRef), false);
});

test("model tiering suggests cheap/mid/strong from declared cost", () => {
  const models = [
    { provider: "p", id: "x16", cost: { input: 16, output: 30 } },
    { provider: "p", id: "free" },
    { provider: "p", id: "c1", cost: { input: 1, output: 2 } },
    { provider: "p", id: "s8", cost: { input: 8, output: 16 } },
    { provider: "p", id: "c2", cost: { input: 2, output: 4 } },
    { provider: "p", id: "m4", cost: { input: 4, output: 8 } },
  ];
  const tiers = suggestModelTiers(models);
  assert.equal(tiers.cheap.id, "free", "an undeclared cost is treated as free, not as the most expensive");
  assert.equal(tiers.mid.id, "c2");
  assert.equal(tiers.strong.id, "x16");
  assert.deepEqual(suggestModelTiers([]), {});
  assert.equal(suggestModelTiers([models[1]]).cheap.id, "free");
});

test("role tiers favour recon, judgement, and the middle", () => {
  assert.equal(tierForRole("scout"), "cheap");
  assert.equal(tierForRole("reviewer"), "strong");
  assert.equal(tierForRole("oracle"), "strong");
  assert.equal(tierForRole("planner"), "strong");
  assert.equal(tierForRole("worker"), "mid");
  assert.equal(tierForRole("writer"), "mid");
});

test("buildModelsProfile layers models onto a base roster and escalates write roles", () => {
  const profile = buildModelsProfile("mine", "default", { cheap: "p/cheap", mid: "p/mid", strong: "p/strong" }, [
    "scout",
    "worker",
    "reviewer",
  ]);
  assert.equal(profile.extends, "default");
  assert.equal(profile.roles.scout.model, "p/cheap");
  assert.equal(profile.roles.worker.model, "p/mid");
  assert.deepEqual(profile.roles.worker.escalate, { to: "p/strong", thinking: "xhigh", maxAttempts: 1 });
  assert.equal(profile.roles.reviewer.model, "p/strong");
  assert.equal(profile.roles.reviewer.escalate, undefined);
  const same = buildModelsProfile("mine", "default", { cheap: "p/x", mid: "p/x", strong: "p/x" }, ["worker"]);
  assert.equal(same.roles.worker.escalate, undefined, "no escalation when strong and mid are the same model");
});

// ------------------------------------------------------------- plan logic

test("sentinel parsing covers all five cases", () => {
  assert.equal(parseSentinel("work\nPIPELINE_STATUS: ok"), "ok");
  assert.equal(parseSentinel("work\nPIPELINE_STATUS: blocked - no access"), "blocked");
  assert.equal(parseSentinel("just prose"), undefined);
  assert.equal(parseSentinel(""), undefined);
  assert.equal(parseSentinel("PIPELINE_STATUS: ok\ntrailing note"), undefined, "only the last non-empty line counts");
  assert.equal(blockedReason("x\nPIPELINE_STATUS: blocked - needs credentials"), "needs credentials");
});

test("step validation rejects the shapes the plan must reject", () => {
  const access = { reader: "read", writer: "write" };
  assert.match(validateSteps([], access).errors.join(" "), /at least one step/);
  const base = { id: "s1", role: "reader", objective: "do a thing", deliverable: "a result" };
  assert.match(validateSteps([{ ...base, deliverable: "" }], access).errors.join(" "), /deliverable is required/);
  assert.match(validateSteps([{ ...base, objective: "  " }], access).errors.join(" "), /objective is required/);
  assert.match(validateSteps([{ ...base, role: "ghost" }], access).errors.join(" "), /unknown role 'ghost'/);
  assert.match(validateSteps([base, { ...base }], access).errors.join(" "), /duplicate step id/);
  assert.match(validateSteps([{ ...base, needs: ["nope"] }], access).errors.join(" "), /needs unknown step/);
  assert.match(validateSteps([{ ...base, needs: ["s1"] }], access).errors.join(" "), /needs itself/);
  assert.match(
    validateSteps([{ ...base, role: "reader", touches: ["src/a.ts"] }], access).errors.join(" "),
    /only meaningful for access 'write'/,
  );
  assert.deepEqual(
    validateSteps([{ ...base, role: "writer", touches: ["src/a.ts"] }], access).errors,
    [],
    "touches is legitimate for a write role",
  );
  const dupes = validateSteps([base, { ...base, id: "s2" }], access);
  assert.match(dupes.warnings.join(" "), /near-duplicate objectives/);
});

test("ordering is topological and cycles are rejected", () => {
  const steps = [
    { id: "c", role: "reader", objective: "c", deliverable: "c" },
    { id: "b", role: "reader", objective: "b", deliverable: "b", needs: ["c"] },
    { id: "a", role: "reader", objective: "a", deliverable: "a", needs: ["b"] },
  ];
  assert.deepEqual(orderLevels(steps).levels, [["c"], ["b"], ["a"]]);
  const cyc = [
    { id: "x", role: "reader", objective: "x", deliverable: "x", needs: ["y"] },
    { id: "y", role: "reader", objective: "y", deliverable: "y", needs: ["x"] },
  ];
  assert.match(orderLevels(cyc).error, /cycle/);
});

test("a reader that a writer needs is not promoted before its own dependency", () => {
  const access = { reader: "read", writer: "write" };
  const plan = promoteReaders(
    [
      { id: "r", role: "reader", objective: "check", deliverable: "review" },
      { id: "w", role: "writer", objective: "edit", deliverable: "change", touches: ["src/a.ts"], needs: ["r"] },
    ],
    access,
  );
  assert.deepEqual(plan.edges, [], "the writer already depends on the reader; promotion must not invert it");
});

test("promotion stays acyclic through an indirect dependency", () => {
  const access = { reader: "read", writer: "write", mid: "read" };
  const steps = [
    { id: "r", role: "reader", objective: "check", deliverable: "review", context: ["src/a.ts"] },
    { id: "x", role: "mid", objective: "transform", deliverable: "data", needs: ["r"] },
    { id: "w", role: "writer", objective: "edit", deliverable: "change", touches: ["src/a.ts"], needs: ["x"] },
  ];
  const plan = promoteReaders(steps, access);
  assert.deepEqual(plan.edges, [], "the writer reaches the reader transitively; no back edge may be synthesized");
  assert.equal(orderLevels(steps, plan.edges).error, undefined, "the plan must stay orderable");
});

test("a **/ glob may match zero path segments", () => {
  assert.equal(matchesGlob("src/a.ts", "src/**/*.ts"), true);
  assert.equal(matchesGlob("src/x/y.ts", "src/**/*.ts"), true);
  assert.equal(matchesGlob("other/a.ts", "src/**/*.ts"), false);
});

test("write globs are anchored, not substring matches", () => {
  assert.equal(matchesGlob("src/a.ts", "src/a.ts"), true);
  assert.equal(matchesGlob("/elsewhere/src/a.ts", "src/a.ts"), false, "'src/a.ts' must not match a path elsewhere");
  assert.equal(matchesGlob("src/a.ts", "src/*.ts"), true);
  assert.equal(matchesGlob("src/x/y.ts", "src/**"), true);
  assert.equal(touchesAny("/elsewhere/src/a.ts", ["src/a.ts"]), false);
  assert.deepEqual(undeclaredChanges(["/elsewhere/src/a.ts"], ["src/a.ts"]), ["/elsewhere/src/a.ts"]);
});

test("cumulative usage folds prior rounds with the current attempt", () => {
  const prior = { ...EMPTY_USAGE, totalTokens: 10, cost: 1, costDetail: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const current = { ...EMPTY_USAGE, totalTokens: 5, cost: 2, costDetail: { input: 0, output: 2, cacheRead: 0, cacheWrite: 0 } };
  const folded = sumUsage([prior, current]);
  assert.equal(folded.totalTokens, 15);
  assert.equal(folded.cost, 3);
  assert.deepEqual(folded.costDetail, { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 });
});

test("a promotion edge also gates the skip decision", () => {
  const steps = [
    { id: "w", role: "writer", objective: "a", deliverable: "a" },
    { id: "r", role: "reader", objective: "b", deliverable: "b" },
  ];
  const nodes = {
    w: { ...emptyNode("w", { role: "writer", task: "a", profile: "p", access: "write", model: "p/m" }), status: "skipped" },
    r: emptyNode("r", { role: "reader", task: "b", profile: "p", access: "read", model: "p/m" }),
  };
  const plan = planLevel(["r"], steps, nodes, { reader: "read", writer: "write" }, 2, [["r", "w"]]);
  assert.deepEqual(plan.runnable, []);
  assert.match(plan.skipped[0].reason, /dependencies did not succeed: w/);
});

test("maxNodes constrains a plan including existing nodes", () => {
  const access = { reader: "read" };
  const base = { id: "s1", role: "reader", objective: "do", deliverable: "d" };
  assert.match(validateSteps([base], access, { maxNodes: 0 }).errors.join(" "), /maxNodes/);
  assert.match(validateSteps([base], access, { maxNodes: 3, existingNodes: 3 }).errors.join(" "), /maxNodes/);
  assert.deepEqual(validateSteps([base], access, { maxNodes: 3, existingNodes: 2 }).errors, []);
});

test("requested concurrency is clamped, not trusted", () => {
  assert.equal(clampConcurrency(9, 3), 3);
  assert.equal(clampConcurrency(0, 3), 1);
  assert.equal(clampConcurrency(2.7, 3), 2);
  assert.equal(clampConcurrency(undefined, 3), 3);
});

test("escalation count sums attempts, not escalated nodes", () => {
  const attempt = { source: "a", target: "b", reason: "r", depth: 1, crossFamily: true, checks: [] };
  const nodes = {
    a: { ...emptyNode("a", { role: "w", task: "a", profile: "p", access: "write", model: "p/m" }), attempts: [attempt, attempt] },
    b: { ...emptyNode("b", { role: "w", task: "b", profile: "p", access: "write", model: "p/m" }), attempts: [attempt] },
  };
  assert.equal(escalationsUsed(nodes), 3);
  assert.equal(escalationsUsed({}), 0);
});

test("reader/writer promotion records its basis", () => {
  const access = { reader: "read", writer: "write" };
  const declared = promoteReaders(
    [
      { id: "w", role: "writer", objective: "edit it", deliverable: "change", touches: ["src/a.ts"] },
      { id: "r", role: "reader", objective: "check", deliverable: "review", context: ["src/a.ts"] },
    ],
    access,
  );
  assert.deepEqual(declared.edges, [["r", "w"]]);
  assert.equal(declared.promotions[0].basis, "declared touches");
  const inferred = promoteReaders(
    [
      { id: "w", role: "writer", objective: "update src/b.ts", deliverable: "change" },
      { id: "r", role: "reader", objective: "check", deliverable: "review", context: ["src/b.ts"] },
    ],
    access,
  );
  assert.equal(inferred.promotions[0].basis, "inferred from text");
  const conservative = promoteReaders(
    [
      { id: "w", role: "writer", objective: "change the code", deliverable: "change" },
      { id: "r", role: "reader", objective: "check it", deliverable: "review" },
    ],
    access,
  );
  assert.equal(conservative.promotions[0].basis, "conservative");
  const ordered = promoteReaders(
    [
      { id: "w", role: "writer", objective: "edit", deliverable: "change", touches: ["src/a.ts"] },
      { id: "r", role: "reader", objective: "check", deliverable: "review", context: ["src/a.ts"], needs: ["w"] },
    ],
    access,
  );
  assert.deepEqual(ordered.edges, [], "an already-declared dependency must not be duplicated");
});

test("a level never runs a writer beside anything else", () => {
  const steps = [
    { id: "r1", role: "reader", objective: "a", deliverable: "a" },
    { id: "r2", role: "reader", objective: "b", deliverable: "b" },
    { id: "w", role: "writer", objective: "c", deliverable: "c" },
  ];
  const nodes = Object.fromEntries(steps.map((step) => [step.id, emptyNode(step.id, { role: step.role, task: step.id, profile: "p", access: step.role === "writer" ? "write" : "read", model: "p/m" })]));
  const readerOnly = planLevel(["r1", "r2"], steps, nodes, { reader: "read", writer: "write" }, 2);
  assert.deepEqual(readerOnly.batches, [["r1", "r2"]], "readers may run in parallel");
  const withWriter = planLevel(["r1", "r2", "w"], steps, nodes, { reader: "read", writer: "write" }, 2);
  assert.ok(withWriter.batches.every((batch) => batch.length === 1), "a writer must run alone");
});

test("a step whose dependency did not succeed is skipped, not run", () => {
  const steps = [
    { id: "w", role: "writer", objective: "a", deliverable: "a" },
    { id: "r", role: "reader", objective: "b", deliverable: "b", needs: ["w"] },
  ];
  const nodes = {
    w: { ...emptyNode("w", { role: "writer", task: "a", profile: "p", access: "write", model: "p/m" }), status: "failed" },
    r: emptyNode("r", { role: "reader", task: "b", profile: "p", access: "read", model: "p/m" }),
  };
  const plan = planLevel(["r"], steps, nodes, { reader: "read", writer: "write" }, 2);
  assert.deepEqual(plan.runnable, []);
  assert.match(plan.skipped[0].reason, /dependencies did not succeed: w/);
});

test("completed steps are preserved on resume", () => {
  const steps = [{ id: "a", role: "reader", objective: "a", deliverable: "a" }];
  const nodes = { a: { ...emptyNode("a", { role: "reader", task: "a", profile: "p", access: "read", model: "p/m" }), status: "ok" } };
  assert.deepEqual(planLevel(["a"], steps, nodes, { reader: "read" }, 2).runnable, []);
});

test("budget stops on tokens or usd", () => {
  assert.equal(budgetExceeded({ ...EMPTY_USAGE, totalTokens: 100 }, { budget: { tokens: 100 } }), true);
  assert.equal(budgetExceeded({ ...EMPTY_USAGE, totalTokens: 99 }, { budget: { tokens: 100 } }), false);
  assert.equal(budgetExceeded({ ...EMPTY_USAGE, cost: 3 }, { budget: { usd: 3 } }), true);
  assert.equal(budgetExceeded({ ...EMPTY_USAGE }, {}), false);
});

test("escalation triggers deterministically and respects both caps", () => {
  const node = { ...emptyNode("n", { role: "w", task: "t", profile: "p", access: "write", model: "p/cheap" }), escalateTarget: "p/strong", status: "blocked" };
  assert.equal(shouldEscalate(node, { attemptsAllowed: 1, escalationsUsed: 0, maxEscalations: 3 }).escalate, true);
  assert.equal(shouldEscalate(node, { attemptsAllowed: 1, escalationsUsed: 0, maxEscalations: 0 }).escalate, false);
  assert.equal(shouldEscalate({ ...node, attempts: [{ source: "a", target: "b", reason: "r", depth: 1, crossFamily: true, checks: [] }] }, { attemptsAllowed: 1, escalationsUsed: 0, maxEscalations: 3 }).escalate, false);
  assert.equal(shouldEscalate({ ...node, status: "ok", sentinelMissing: true }, { attemptsAllowed: 1, escalationsUsed: 0, maxEscalations: 3 }).escalate, false, "a forgotten sentinel must never cost an escalation");
  assert.equal(shouldEscalate({ ...node, escalateTarget: undefined }, { attemptsAllowed: 1, escalationsUsed: 0, maxEscalations: 3 }).escalate, false);
});

test("verification, touches mismatch and truncation behave", () => {
  assert.equal(verificationOk(0, 0), true);
  assert.equal(verificationOk(1, 0), false);
  assert.deepEqual(undeclaredChanges(["src/a.ts", "src/b.ts"], ["src/a.ts"]), ["src/b.ts"]);
  assert.deepEqual(undeclaredChanges(["src/a.ts"], undefined), []);
  const long = "x".repeat(500);
  const clipped = truncate(long, 100);
  assert.ok(clipped.length < long.length);
  assert.match(clipped, /characters omitted/);
});

test("usage folds including per-bucket cost", () => {
  const nodes = {
    a: { ...emptyNode("a", { role: "r", task: "a", profile: "p", access: "read", model: "p/m" }), usage: { ...EMPTY_USAGE, totalTokens: 10, cost: 1, costDetail: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 } } },
    b: { ...emptyNode("b", { role: "r", task: "b", profile: "p", access: "read", model: "p/m" }), usage: { ...EMPTY_USAGE, totalTokens: 5, cost: 2, costDetail: { input: 0, output: 2, cacheRead: 0, cacheWrite: 0 } } },
  };
  const total = totalUsage(nodes);
  assert.equal(total.totalTokens, 15);
  assert.equal(total.cost, 3);
  assert.deepEqual(total.costDetail, { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 });
});

test("tree rows are width-safe at 40/80/200 with indentation and counts", () => {
  const leaf = emptyNode("grand", { role: "reviewer", task: "check the diff", profile: "p", access: "read", model: "p/mid", thinking: "max" });
  const child = { ...emptyNode("child", { role: "worker", task: "write the file", profile: "p", access: "write", model: "p/cheap" }), status: "running", parentId: "root", children: ["grand"] };
  const sibling = emptyNode("sib", { role: "scout", task: "map it", profile: "p", access: "read", model: "p/cheap" });
  Object.assign(sibling, { parentId: "root" });
  const root = { ...emptyNode("root", { role: "scout", task: "root task", profile: "p", access: "read", model: "p/cheap" }), status: "escalated", children: ["child", "sib"] };
  const nodes = { root, child, sibling, grand: { ...leaf, parentId: "child" } };
  for (const width of [40, 80, 200]) {
    const rows = formatTreeRows(nodes, { width });
    assert.equal(rows.length, 4);
    for (const row of rows) assert.ok(row.length <= width, `row wider than ${width}: ${row}`);
    assert.match(rows[0], /\(\+2\)/);
    assert.match(rows[1], /├─ |└─ /);
  }
  assert.deepEqual(formatTreeRows({}, { width: 80 }), []);
});

// ------------------------------------------------------------- runs/retention

test("retention age-prunes finished runs and pins unfinished ones", () => {
  const day = 24 * 60 * 60 * 1000;
  const now = Date.now();
  const entries = [
    { runId: "old-finished", finished: true, updatedAt: now - 10 * day },
    { runId: "old-unfinished", finished: false, updatedAt: now - 10 * day },
    { runId: "recent-finished", finished: true, updatedAt: now - 1 * day },
  ];
  const pinned = planPrune(entries, { keep: 20, maxAgeDays: 7, now, pinUnfinished: true });
  assert.deepEqual(pinned.drop, ["old-finished"]);
  assert.deepEqual(pinned.pinned, ["old-unfinished"]);
  const unpinned = planPrune(entries, { keep: 20, maxAgeDays: 7, now, pinUnfinished: false });
  assert.deepEqual(unpinned.drop.sort(), ["old-finished", "old-unfinished"]);
});

test("count pruning drops finished runs before resumable ones", () => {
  const now = Date.now();
  const entries = [
    { runId: "f1", finished: true, updatedAt: now - 1000 },
    { runId: "f2", finished: true, updatedAt: now - 500 },
    { runId: "u1", finished: false, updatedAt: now - 100 },
  ];
  const { drop } = planPrune(entries, { keep: 2, maxAgeDays: 7, now, pinUnfinished: true });
  assert.deepEqual(drop, ["f1"], "the oldest finished run goes first, and the resumable one survives");
  const forced = planPrune(entries, { keep: 0, maxAgeDays: 7, now, pinUnfinished: true });
  assert.ok(forced.drop.includes("u1"), "unfinished runs are dropped only when nothing else can be");
});

test("unpinned count pruning still honors keep", () => {
  const now = Date.now();
  const entries = [
    { runId: "f1", finished: true, updatedAt: now - 1000 },
    { runId: "f2", finished: true, updatedAt: now - 900 },
    { runId: "u1", finished: false, updatedAt: now - 800 },
    { runId: "u2", finished: false, updatedAt: now - 700 },
  ];
  const { drop } = planPrune(entries, { keep: 1, maxAgeDays: 7, now, pinUnfinished: false });
  assert.equal(drop.length, 3, "keep:1 means three of four runs are dropped");
  assert.equal(entries.filter((entry) => !entry.finished && !drop.includes(entry.runId)).length, 1, "one resumable run survives");
});

test("a corrupt run.json is ignored instead of throwing", () => {
  const root = tempDir();
  const bad = join(root, "run-corrupt");
  mkdirSync(bad, { recursive: true });
  writeFileSync(join(bad, "run.json"), JSON.stringify({ nodes: null }), "utf-8");
  assert.equal(readRun(root, "run-corrupt"), undefined);
  assert.deepEqual(listRuns(root), []);
  rmSync(root, { recursive: true, force: true });
});

test("run directory round-trips and is summarised", () => {
  const root = tempDir();
  const state = {
    runId: "run-test",
    profile: "default",
    steps: [{ id: "a", role: "reader", objective: "o", deliverable: "d" }],
    nodes: { a: { ...emptyNode("a", { role: "reader", task: "o", profile: "default", access: "read", model: "p/mid" }), status: "ok" } },
    rounds: [{ round: 1, profile: "default", startedAt: Date.now() }],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    finished: true,
  };
  writeRun(root, state);
  const loaded = readRun(root, "run-test");
  assert.equal(loaded.runId, "run-test");
  assert.equal(loaded.nodes.a.status, "ok");
  const summaries = listRuns(root);
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].ok, 1);
  assert.equal(runDirSize(root).runs, 1);
  rmSync(root, { recursive: true, force: true });
});

// --------------------------------------------------------------------- report

console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const failure of failures) console.error(`  FAIL ${failure}`);
  process.exit(1);
}
console.log("thinking levels:", THINKING_LEVELS.join("|"));
