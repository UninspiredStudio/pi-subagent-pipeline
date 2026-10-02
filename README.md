# pi-pipeline

A profile **is** the subagent roster, and delegation is a default path.

A profile defines which subagents exist — each with its own model, provider, thinking effort, tools,
access class, spawn rights, escalation target and prompt — plus the run envelope (budget, depth,
concurrency, retention). A task is decomposed into steps, run as a pipeline, escalated on blocked steps,
and visible as a live tree.

## Status

Implemented and verified:

- `npm run typecheck` passes with `strict` against the real peer declarations.
- `node --experimental-strip-types scripts/selfcheck.mjs` — pure-logic assertions over profile validation, ordering,
  promotion, sentinel parsing, budgets, escalation and retention; no dependencies and no token cost.
- Live in Pi: the extension loads, the shipped profile resolves all seven roles against the live registry,
  a real child session runs a step, the sentinel is parsed, and the run directory is written.

Not yet exercised interactively: the TUI overlay and widget, a live escalation, a live resume, nested
spawning, `verify.command`, and retention pruning in a real session. `scripts/selfcheck.mjs` covers their
decision logic; they need a hands-on pass.

## Install

```bash
pi install npm:@uninspired/pi-subagent-pipeline
```

Then `/reload` (or restart Pi) and check `/pipeline-doctor`: a fresh session exposes the `pipeline` and
`pipeline_status` tools and registers the `pipeline` skill. Working on the plugin itself, install the checkout
instead — `pi install /path/to/pi-subagent-pipeline` loads it in place, so edits take effect after `/reload`.

`pi-pipeline` and `pi-subagents` must not both be *active*: both inject delegation guidance and both draw a
run UI. `/pipeline-doctor` names any second delegation tool it finds.

## Profiles

| Scope | Path |
|---|---|
| Project (needs trust, wins) | `<project>/.pi/pipeline/profiles/*.json` |
| User | `~/.pi/agent/profiles/pipeline/*.json` |
| Package | `<package>/profiles/*.json` |

Long prompts live next to the profile as `<role>.md` and are referenced with `promptFile`.

```jsonc
{
  "schemaVersion": 1,
  "name": "default",
  "extends": "default",
  "defaults": { "model": "opencode-go/deepseek-v4.1-flash", "thinking": "low" },
  "limits": { "maxDepth": 2, "maxNodes": 12, "maxConcurrent": 3, "maxEscalations": 3,
              "budget": { "tokens": 400000, "usd": 3 } },
  "runs": { "keep": 20, "maxAgeDays": 7, "pinUnfinished": true },
  "aggressiveness": "medium",
  "roles": {
    "worker": {
      "description": "Implements one validated change and validates it.",
      "promptFile": "worker.md",
      "access": "write",
      "tools": ["read", "grep", "find", "ls", "bash", "edit", "write"],
      "verify": { "command": "npm test", "expectExit": 0, "timeoutMs": 180000 },
      "escalate": { "to": "opencode-go/qwen3.8-max", "thinking": "xhigh", "crossFamily": true },
      "canSpawn": ["reviewer"]
    }
  }
}
```

Role fields: `description` (required), `prompt`/`promptFile`, `model`, `thinking`, `provider`, `access`,
`tools`, `context` (`projectFiles`, `skills`), `verify`, `canSpawn`, `escalate`, `enabled`.

**`aggressiveness`** (`low` | `medium` | `high` | `off`, default `medium`) sets how hard the injected guidance
pushes the main session toward the pipeline — the profile's own default. `low` delegates only when inline work
genuinely cannot do the job, `medium` delegates where it applies, `high` makes a pipeline the default for any
substantial task, and `off` suppresses the guidance entirely. The `/pipeline-aggressiveness` switch overrides it
for the current session (`default <level>` persists a global default), with precedence session → profile →
persisted default → `medium`.

- **A profile with zero roles is valid** — nothing can run, and `pipeline` says so instead of inventing roles.
- `access` defaults from `tools`: `edit`/`write` present means `write`.
- `canSpawn: []` is an explicit leaf. Omitting `canSpawn` allows any role up to `limits.maxDepth`.
- **`parent`** sets the default model and effort for the *main* session while the profile is active:
  `"parent": { "model": "opencode-go/deepseek-v4.1-flash", "thinking": "low" }`. It is applied on a
  fresh session (`startup`, `new`, `reload`) and immediately when you switch profile, but **not** on
  `resume` or `fork`, where the session keeps the model it recorded. Omit `model` to pin only the effort.
- **Switching**: `/pipeline-profile` (picker), `/pipeline-profile <name>`, `/pipeline-profile none`,
  `pipeline({ profile })` for one run, or `pi --pipeline-profile <name>`. The active profile is a plugin-owned
  pointer in `~/.pi/agent/extensions/pipeline/config.json` (project config wins), so a switch is instant and
  reversible. Switching is refused while a run is in flight: a run snapshots its roster.
- **Precedence** for a role's model: step override → profile role → profile `defaults` → `extends` chain →
  the parent session model.
- **Activation fails closed**: unresolved models, unauthenticated models, `maxThinking` breaches,
  `modelScope` breaches, unknown `canSpawn` targets, self-escalation and `access`/`tools` contradictions are all
  reported by name as errors, and nothing runs until they are fixed. Unknown keys are reported as warnings, not
  errors.

## Running work

`pipeline({ steps })`. Each step needs `id`, `role`, `objective`, `deliverable`; optional `scope`, `context`,
`needs`, `model`, `thinking`, `touches`.

- Ordering comes from `needs`, not array position. Independent read steps run in parallel; **a write step always
  runs alone**, and a reader that could observe a partial write is promoted after that writer (recorded, with the
  basis: declared `touches`, inferred, or conservative).
- Every child ends with `PIPELINE_STATUS: ok` or `PIPELINE_STATUS: blocked - <reason>`.
- Only an explicit `blocked`, a failed `verify.command`, a thrown error or a timeout can escalate. A child that
  produced **no output at all** is failed and may escalate; a missing sentinel *with* output is treated as `ok`,
  so forgotten boilerplate alone must not spend money.
- Escalation is a typed, validated handoff: the target is checked at activation, self-escalation is rejected,
  attempts and total escalations are capped, and the path is recorded on the node.
- A `verify.command` runs in the workspace after the step and its exit code is the verdict; a failure marks the
  step blocked, which is exactly the escalation trigger.
- Changed files come from the child's own `write`/`edit` tool events, not from what the child claims.

## Runs, retention, resume

Each run writes `~/.pi/agent/pipeline/runs/<runId>/`: `run.json` (nodes, `rounds[]`, cumulative usage),
`node-<id>.output.md`, the child's own session `.jsonl`, and `events.jsonl`.

The model-facing result is capped at `maxResultChars` and always names the run directory, so detail is one read
away rather than lost.

Retention: finished runs age out by `maxAgeDays`, then by `keep`; unfinished runs are **pinned** and dropped only
as a last resort, and every such drop is reported.

`pipeline({ resume: runId })` or `/pipeline-resume <runId>` re-runs every non-`ok` node as a new round against the
**currently active** profile, preserving `ok` nodes and cumulative usage. A role that has left the roster is
skipped and named. Rounds of a resumed run are not comparable when the profile changed; each node records its
`profile` and `round` so that is visible rather than implied.

## UI and commands

- Inline tree under the `pipeline` tool call, live while children stream.
- One-line widget under the editor: `▸ pipeline profile: default · 1 running · 2/3 ok · 12.4k tok`.
- `/pipeline-tree` (or the configured shortcut, default `ctrl+shift+p`) opens the overlay: `↑↓`/`jk` select,
  `Enter` detail (status, verification, artifacts, output and transcript paths), `x` stop the selected node,
  `Esc` close.

| Command | Purpose |
|---|---|
| `/pipeline-aggressiveness [low\|medium\|high\|off]` | How readily the parent delegates to the pipeline (this session); `default <level>` persists it, `status` reports it |
| `/pipeline-tree` | The live tree (non-TUI modes print it) |
| `/pipeline-profile [name\|none\|list\|check\|generate]` | List, switch, validate, or generate a roster from the registry (metadata only, no probes) |
| `/pipeline-stop [nodeId]` | Stop a node, or the whole run |
| `/pipeline-resume <runId>` | Continue a recorded run |
| `/pipeline-runs` | List recorded runs |
| `/pipeline-doctor` | Active profile and source, every role's resolved model and credential state, limits, run-dir size, pinned and resumable counts, delegation-tool collisions |
| `/pipeline-smoke` | One real read-only step, to verify children work (needs `PIPELINE_SMOKE=1`; spends tokens) |

`pipeline_status({action: "roster" \| "tree" \| "runs" \| "stop"})` exposes the same surface to the model,
and is always authoritative for the roster.

## Checking it

```bash
npm install                                        # devDependencies: typescript and @types/node
npm run typecheck                                  # strict, no output means clean
node --experimental-strip-types scripts/selfcheck.mjs
PIPELINE_SMOKE=1 pi --extension ./src/index.ts     # then /pipeline-smoke
```

`selfcheck.mjs` needs no dependencies: the pure modules (`profiles.ts`, `plan.ts`, `runs.ts`) have no platform
imports, so profile validation, ordering, promotion, sentinel parsing, budget and escalation decisions,
retention and the tree renderer are tested directly.

## Trust

Profile files carry system prompts, tool allowlists and optional `verify.command` values, so **project-scoped
profiles are only read after project trust** and children inherit the parent's trust decision without prompting.
Escalation never widens a role's tool allowlist. Children run with Pi's normal (unsandboxed) OS permissions.

## Known limitations

- **In-process children only.** Detached/background runs need an `@earendil-works/pi-agent-core/node` export that
  this Pi install does not provide; a run therefore lives and dies with its session.
- Role prompts are **appended** to the child's system prompt (so children keep Pi's built-in tool guidance) rather
  than replacing it.
- Model resolution is implemented on `ctx.modelRegistry` rather than `resolveCliModel`, because the extension
  context exposes a `ModelRegistry`, not a `ModelRuntime`. `provider/id`, `provider:id`, bare ids, `inherit` and a
  `:thinking` suffix all work.
- No steering of a live child (stop only), no worktree isolation, no external CLI runners, no live provider probes.

## Publishing

```bash
npm publish --access public
```

The `pi-package` keyword is what makes it eligible for the [Pi package gallery](https://pi.dev/packages), and
`pi.extensions` / `pi.skills` declare what ships. `assets/icon-master.png` is the card image referenced by
`pi.image`, so it has to be committed and pushed before the gallery can render it.
