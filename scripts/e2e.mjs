/**
 * End-to-end tests: load the plugin in a real Pi session and prove that children
 * actually spawn. Needs credentials for one accessible model; spend is a few cheap
 * child turns. Runs against an isolated temp agent dir, so it touches no real runs.
 *
 * Run: node --experimental-strip-types scripts/e2e.mjs
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";

const REPO = join(import.meta.dirname, "..");
const REAL_AGENT = join(homedir(), ".pi", "agent");

function readText(path) {
  try {
    return readFileSync(path, "utf-8");
  } catch (error) {
    throw new Error(`cannot read ${path}: ${error.message}`);
  }
}
function readJson(path) {
  try {
    return JSON.parse(readText(path));
  } catch (error) {
    throw new Error(`cannot parse ${path}: ${error.message}`);
  }
}

// ---- isolated agent dir: credentials via symlink, no real runs touched ----
const agentDir = mkdtempSync(join(tmpdir(), "pipeline-e2e-"));
for (const file of ["auth.json", "models.json", "models-store.json"]) {
  if (existsSync(join(REAL_AGENT, file))) symlinkSync(join(REAL_AGENT, file), join(agentDir, file));
}
writeFileSync(join(agentDir, "settings.json"), "{}\n");
mkdirSync(join(agentDir, "extensions", "pipeline"), { recursive: true });
const configPath = join(agentDir, "extensions", "pipeline", "config.json");
const setProfile = (name) => writeFileSync(configPath, JSON.stringify({ activeProfile: name }));
setProfile("default");
process.env.PI_CODING_AGENT_DIR = agentDir;

const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager } = await import(
  "@earendil-works/pi-coding-agent"
);

const runsRoot = join(agentDir, "pipeline", "runs");
const runIds = () => (existsSync(runsRoot) ? readdirSync(runsRoot) : []);

const modelRuntime = await ModelRuntime.create();
const available = await modelRuntime.getAvailable();
if (!available.length) {
  console.error(`No accessible models: configure credentials, or this e2e cannot spawn a child.`);
  rmSync(agentDir, { recursive: true, force: true });
  process.exit(1);
}
// Prefer a cheap flash model; any accessible model works.
const model =
  available.find((m) => `${m.provider}/${m.id}`.includes("deepseek-v4.1-flash")) ??
  available.find((m) => m.reasoning === false) ??
  available[0];
console.log(`model: ${model.provider}/${model.id}`);

async function makeSession() {
  const loader = new DefaultResourceLoader({
    cwd: REPO,
    agentDir,
    additionalExtensionPaths: [join(REPO, "src", "index.ts")],
    noSkills: true,
    noContextFiles: true,
  });
  await loader.reload({ resolveProjectTrust: async () => false });
  const { session } = await createAgentSession({
    cwd: REPO,
    agentDir,
    model,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(),
  });
  return session;
}

/** The newest run whose directory is not in `before`, or undefined. */
function newRun(before) {
  const created = runIds().filter((id) => !before.has(id));
  return created.length ? { id: created.at(-1), count: created.length } : undefined;
}

let passed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures.push(`${name}: ${error.message}`);
    console.log(`FAIL  ${name}: ${error.message}`);
  }
}

// ------------------------------------------------------------------ tests

await test("the extension loads in a real session and registers both tools", async () => {
  const session = await makeSession();
  try {
    const tools = new Set(session.getActiveToolNames?.() ?? []);
    assert.ok(tools.has("pipeline"), "the pipeline tool must be active");
    assert.ok(tools.has("pipeline_status"), "the pipeline_status tool must be active");
  } finally {
    session.dispose();
  }
});

await test("/pipeline-smoke spawns a real child subagent with full artifacts", async () => {
  const before = new Set(runIds());
  const session = await makeSession();
  process.env.PIPELINE_SMOKE = "1";
  try {
    await session.prompt("/pipeline-smoke");
  } finally {
    delete process.env.PIPELINE_SMOKE;
    session.dispose();
  }

  const run = newRun(before);
  assert.ok(run, "a run directory must be created");
  assert.equal(run.count, 1, `expected exactly one new run, got ${run.count}`);

  const runDir = join(runsRoot, run.id);
  const state = readJson(join(runDir, "run.json"));
  const nodes = Object.values(state.nodes);
  assert.ok(nodes.length >= 1, "the run must contain at least one node");
  const node = nodes[0];
  assert.equal(node.role, "scout", "the smoke step runs the cheapest read role");
  assert.equal(node.status, "ok", `node must be ok, got ${node.status}${node.error ? `: ${node.error}` : ""}`);

  // The proof of spawning: a child session transcript on disk, non-empty.
  assert.ok(node.sessionFile, "the node must record a child session file");
  assert.ok(existsSync(node.sessionFile), `child transcript must exist: ${node.sessionFile}`);
  assert.ok(statSync(node.sessionFile).size > 0, "child transcript must be non-empty");
  const transcript = readText(node.sessionFile);
  assert.match(transcript, /"role":"assistant"/, "the child transcript must hold an assistant message");

  // And the node's own output, written from the child's last message.
  assert.ok(node.outputPath && existsSync(node.outputPath), "the node output file must exist");
  assert.ok(readText(node.outputPath).trim().length > 0, "the node output must be non-empty");

  // And the event log around the child.
  const events = readText(join(runDir, "events.jsonl"));
  assert.match(events, /"type":"node_start"/, "events must record node_start");
  assert.match(events, /"type":"node_end"/, "events must record node_end");
  assert.match(events, /"status":"ok"/, "events must record the ok status");

  // One child transcript and one output file per node, no more.
  const transcripts = readdirSync(runDir).filter((name) => name.endsWith(".jsonl") && name !== "events.jsonl");
  assert.equal(transcripts.length, nodes.length, `expected one child transcript per node, got ${transcripts.join(", ")}`);
  const outputs = readdirSync(runDir).filter((name) => name.startsWith("node-") && name.endsWith(".output.md"));
  assert.equal(outputs.length, nodes.length, `expected one output per node, got ${outputs.join(", ")}`);
});

await test("a profile with no roles refuses to spawn, cleanly", async () => {
  setProfile("none");
  const before = new Set(runIds());
  const session = await makeSession();
  process.env.PIPELINE_SMOKE = "1";
  try {
    await session.prompt("/pipeline-smoke");
  } finally {
    delete process.env.PIPELINE_SMOKE;
    session.dispose();
    setProfile("default");
  }
  assert.equal(newRun(before), undefined, "no run may be created without roles");
});

await test("an explicit instruction makes the parent spawn a run", async () => {
  let spawned;
  for (let attempt = 0; attempt < 2 && !spawned; attempt += 1) {
    const before = new Set(runIds());
    const session = await makeSession();
    try {
      await session.prompt(
        "Use the pipeline tool right now: run a single scout step that replies with the word ready. Do not do the reading yourself.",
      );
      // The injected directive must reach the parent conversation as a system section.
      const sections = (session.messages ?? [])
        .filter((message) => message.role === "system")
        .flatMap((message) => Object.keys(message.sections ?? {}));
      assert.ok(sections.includes("pipeline"), `the pipeline system section must be injected, got: ${sections.join(", ")}`);
    } finally {
      session.dispose();
    }
    spawned = newRun(before);
  }
  assert.ok(spawned, "an explicit instruction must create a run");
});

// ------------------------------------------------------------------ report

rmSync(agentDir, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const failure of failures) console.error(`  FAIL ${failure}`);
  process.exit(1);
}
