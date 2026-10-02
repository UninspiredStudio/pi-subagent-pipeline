# pi-pipeline

A single agent context is a bottleneck. Everything a task touches — the code, the logs, the dead ends — piles into one conversation, and the model paying for that pile is also the model doing the work. One model cannot be both the cheap reader of many files and the expensive judge of the result.

pi-pipeline splits the work, and it does so from a roster you control:

- A **profile is the subagent roster**. It declares which subagents exist, each with its own model, provider, thinking effort, tool allowlist, access class, spawn rights, escalation target and prompt — plus the run envelope (budget, depth, concurrency, retention).
- A **pipeline is one task decomposed into steps**, each step run as a child agent session.

The parent stays small; the children carry the reading, the writing and the judgment. Delegation is a default path, not a special case: the parent picks roles from the roster, orders the steps, and gets back a live tree plus a run directory it can resume.

## Install

```bash
pi install npm:@uninspired/pi-subagent-pipeline
```

Then `/reload` (or restart Pi) and check `/pipeline-doctor`: the session exposes the `pipeline` and `pipeline_status` tools and registers the `pipeline` skill. Working on the plugin itself, install the checkout instead — `pi install /path/to/pi-subagent-pipeline` loads it in place, so edits take effect after `/reload`.

pi-pipeline and pi-subagents must not both be *active*: both inject delegation guidance and both draw a run UI. `/pipeline-doctor` names any second delegation tool it finds (`subagent`, `subagents_enable`).

## How it works

One run, end to end.

1. **The parent calls `pipeline({ steps })`.** Each step needs `id`, `role`, `objective` and `deliverable`; optional are `scope`, `context`, `needs`, `model`, `thinking` and `touches`. The plan is validated before anything spends tokens: unknown roles, missing fields, duplicate ids, `needs` on an unknown step, `needs` on itself, dependency cycles and `maxNodes` breaches are all rejected by name.
2. **Each step becomes a child session created from its role.** The child gets the role's model, thinking effort, tool allowlist and role prompt. The role prompt is *appended* to Pi's system prompt so children keep Pi's built-in tool guidance. A child gets the `pipeline` tool itself only while the depth cap allows, and only for roles it is allowed to spawn.
3. **Steps are ordered by `needs`, not array position.** Independent read steps run in parallel, clamped to the profile's `maxConcurrent`. A write step always runs alone. A reader that could observe a partial write is promoted after that writer, and the basis — declared `touches`, inferred from text, or conservative — is recorded and reported as a warning.
4. **Every child ends with a sentinel.** `PIPELINE_STATUS: ok` or `PIPELINE_STATUS: blocked - <reason>`. Only the last non-empty line counts. A child that produced no output at all is failed; a missing sentinel *with* output is treated as `ok`, so a forgotten line alone never spends escalation money.
5. **Blocked and failed steps escalate.** Escalation fires only when a step ends `blocked` — an explicit `PIPELINE_STATUS: blocked`, or a failed `verify.command` — or when it produced no output at all (recorded as `failed` with error `child produced no output`). A timeout returns `stopped`, and a thrown exception lands as `failed` in the catch block before the escalation check, so neither escalates. The target is validated at activation, self-escalation is rejected, and attempts and total escalations are capped. A `verify.command` runs in the workspace after the step; its exit code is the verdict, and a non-zero exit marks the step blocked — exactly the escalation trigger.
6. **Changed files come from the child's own `write`/`edit` tool events**, not from what the child claims. A write outside the workspace is recorded separately and never glob-matched against `touches`.
7. **The run is written down and drawn live.** Each run gets a run directory (below), and the tree renders under the tool call while children stream.
8. **Resume re-runs only the non-`ok` nodes.** `pipeline({ resume: runId })` or `/pipeline-resume <runId>` replays the recorded steps as a new round against the **currently active** profile, preserving `ok` nodes and cumulative usage.

## Worked example

```json
{
  "steps": [
    { "id": "recon", "role": "scout",
      "objective": "Map how auth middleware is wired.",
      "deliverable": "File list with line evidence." },
    { "id": "patch", "role": "worker",
      "objective": "Add a rate-limit guard to the login route.",
      "deliverable": "Guard implemented and npm test green.",
      "needs": ["recon"], "touches": ["src/auth/**"] },
    { "id": "review", "role": "reviewer",
      "objective": "Review the guard for bypasses.",
      "deliverable": "Findings with line references.",
      "needs": ["patch"] }
  ]
}
```

**What happens:** `recon` runs first as a `scout` child — the cheapest role, read-only. `patch` waits on it because `needs` says so, and runs alone as the only write step. `review` waits on `patch` and runs read-only against the result. Each child returns a sentinel; each child's output and session land in the run directory. The default roster pins no models, so each row shows `inherit` until you choose per-role models.

Tree rows render as `<glyph> <role> <model>:<effort> — <task> <badges>`, followed by one `id [role] status` detail line per node:

```text
pipeline completed (run-ldt8gk-2fz)
✔ scout inherit:low — Map how auth middleware is wired.
✔ worker inherit:low — Add a rate-limit guard to the login route.
✔ reviewer inherit:max — Review the guard for bypasses.
- recon [scout] ok
- patch [worker] ok
- review [reviewer] ok
run directory: ~/.pi/agent/pipeline/runs/run-ldt8gk-2fz
```

A child with spawn rights can nest: if `patch` spawned its own `scout` step, the tree grows a branch under it and the run keeps one directory and one cumulative usage total.

```text
✔ scout inherit:low — Map how auth middleware is wired.
✔ worker inherit:low — Add a rate-limit guard to the login route. (+1)
└─ scout inherit:low — Check the route registration order.
```

## Profiles

Profiles resolve across three scopes. The higher scope wins a name collision.

| Scope | Path |
|---|---|
| Project (needs trust, wins) | `<project>/.pi/pipeline/profiles/*.json` |
| User | `~/.pi/agent/profiles/pipeline/*.json` |
| Package | `<package>/profiles/*.json` |

Long prompts live next to the profile as `<role>.md` and are referenced with `promptFile`; inherited roles keep the prompt from the layer that defined them.

```jsonc
{
  "schemaVersion": 1,
  "name": "my-roster",
  "description": "What this roster is for.",
  "extends": "default",
  "defaults": { "provider": "opencode-go", "model": "deepseek-v4.1-flash", "thinking": "low" },
  "parent": { "model": "opencode-go/deepseek-v4.1-flash", "thinking": "low" },
  "limits": { "maxThinking": "max", "maxDepth": 2, "maxNodes": 12, "maxConcurrent": 3,
              "maxEscalations": 3, "perStepTimeoutMs": 300000, "maxResultChars": 8000,
              "rosterInjectTokens": 600, "allowUnavailableModels": false,
              "budget": { "tokens": 400000, "usd": 3 } },
  "runs": { "keep": 20, "maxAgeDays": 7, "pinUnfinished": true },
  "modelScope": { "enforce": false, "allow": ["opencode-go/*"] },
  "aggressiveness": "medium",
  "roles": {
    "worker": {
      "description": "Implements one validated change and validates it.",
      "promptFile": "worker.md",
      "model": "opencode-go/deepseek-v4.1-flash",
      "thinking": "low",
      "access": "write",
      "tools": ["read", "grep", "find", "ls", "bash", "edit", "write"],
      "context": { "projectFiles": true, "skills": false },
      "verify": { "command": "npm test", "expectExit": 0, "timeoutMs": 180000 },
      "escalate": { "to": "opencode-go/qwen3.8-max", "thinking": "xhigh", "crossFamily": true, "maxAttempts": 1 },
      "canSpawn": ["reviewer"]
    }
  }
}
```

**Profile fields:** `schemaVersion`, `name`, `description`, `extends`, `defaults` (`provider`, `model`, `thinking`, `tools`, `context`), `parent` (`model`, `thinking`), `limits`, `runs`, `modelScope` (`enforce`, `allow`), `aggressiveness`, `roles`.

**Role fields:** `description` (required), `prompt`, `promptFile`, `model`, `thinking` (a level, or `false` to disable), `provider`, `access`, `tools`, `context` (`projectFiles`, `skills`), `verify` (`command`, `expectExit`, `timeoutMs`), `canSpawn`, `escalate` (`to`, `thinking`, `crossFamily`, `maxAttempts`), `enabled`.

Defaults, from `src/profiles.ts`:

| Field | Default |
|---|---|
| `limits.maxThinking` | `max` |
| `limits.maxNodes` / `maxDepth` / `maxConcurrent` / `maxEscalations` | `12` / `2` / `3` / `3` |
| `limits.perStepTimeoutMs` | `300000` |
| `limits.maxResultChars` | `8000` |
| `limits.rosterInjectTokens` | `600` |
| `limits.allowUnavailableModels` | `false` |
| `limits.budget` | none (the shipped `default` profile sets `400000` tokens / `$3`) |
| `runs.keep` / `maxAgeDays` / `pinUnfinished` | `20` / `7` / `true` |
| `verify.timeoutMs` | `120000` |
| `escalate.maxAttempts` | `1` (allowed `1..3`) |
| role `tools` | `read`, `grep`, `find`, `ls`, `bash` |
| role `context.projectFiles` / `skills` | `true` / `false` |

**`aggressiveness`** (`low` | `medium` | `high` | `off`, default `medium`) sets how hard the injected guidance pushes the main session toward the pipeline. `low` delegates only when inline work genuinely cannot do the job, `medium` delegates where it applies, `high` makes a pipeline the default for any substantial task, and `off` suppresses the guidance entirely. Precedence is session override → profile → persisted default → `medium`.

- **A profile with zero roles is valid** — nothing can run, and `pipeline` says so instead of inventing roles.
- `access` is derived from `tools`: `edit` or `write` present means `write`, otherwise `read`. `access: "read"` with `edit`/`write` tools is an error.
- `canSpawn: []` is an explicit leaf. Omitting `canSpawn` allows any role up to `limits.maxDepth`.
- **`parent`** sets the default model and effort for the *main* session while the profile is active. It is applied on a fresh session (`startup`, `new`, `reload`) and immediately when you switch profile, but **not** on `resume` or `fork`, where the session keeps the model it recorded. Omit `model` to pin only the effort.
- **Precedence** for a role's model: step override → profile role → profile `defaults` → `extends` chain → the parent session model. `provider/id`, `provider:id`, bare ids, `inherit` and a `:thinking` suffix all resolve.
- **The shipped `default` profile pins no models.** A model belongs to the user's credentials, not the roster, so every role inherits the session model until you choose. Until a model is pinned, `/pipeline-doctor` and session start say so; the inherited model always works because the session already has credentials for it.
- **`/pipeline-init`** reads the accessible registry, suggests a cheapest, a middle and a most-expensive model as the cheap/mid/strong tiers, and lets you confirm or replace each pick. It writes `~/.pi/agent/profiles/pipeline/<name>.json` that `extends` the active roster with only the chosen `model` per role (recon → cheap, review/oracle/planner → strong, the rest → mid, plus a strong-model escalation on write roles), validates it as discovery will see it, and activates it. The non-interactive form is `/pipeline-init <name> <cheap> <mid> <strong>` with `provider/id` refs.
- **Activation fails closed**: unresolved models, unauthenticated models, `maxThinking` breaches, `modelScope` breaches, unknown `canSpawn` targets, self-escalation, an escalation that cannot change model or effort, and `access`/`tools` contradictions are all reported by name as errors, and nothing runs until they are fixed. Unknown keys are reported as warnings, not errors.

**Switching profiles:** `/pipeline-profile` (picker), `/pipeline-profile <name>`, `/pipeline-profile none`, `pipeline({ profile })` for one run, or `pi --pipeline-profile <name>`. The active profile is a plugin-owned pointer in `config.json` (the project file `<project>/.pi/pipeline/config.json` wins over `~/.pi/agent/extensions/pipeline/config.json` when the project is trusted), so a switch is instant and reversible. Switching is refused while a run is in flight: a run snapshots its roster.

## Running work

`pipeline({ steps })`. Each step needs `id`, `role`, `objective`, `deliverable`; optional are `scope`, `context`, `needs`, `model`, `thinking`, `touches`. The tool also takes `profile` (run on a named profile for this call), `concurrency` (max parallel read steps, clamped to `maxConcurrent`) and `resume` (a recorded run id).

For a single step, pass `task` instead of building a `steps` array — `pipeline({ task: "Map how auth is wired." })`, with an optional `role` that defaults to the first read role in the roster.

- Ordering comes from `needs`, not array position. Independent read steps run in parallel; **a write step always runs alone**, and a reader that could observe a partial write is promoted after that writer (recorded, with the basis: declared `touches`, inferred, or conservative).
- Every child ends with `PIPELINE_STATUS: ok` or `PIPELINE_STATUS: blocked - <reason>`.
- Escalation fires only for a step that ends `blocked` (explicit blocked, or a failed `verify.command`) or that produced **no output at all** (recorded `failed`). A timeout returns `stopped`; a thrown error is recorded `failed` in the catch block before the escalation check. Neither escalates. A missing sentinel *with* output is treated as `ok`.
- Escalation is a typed, validated handoff: the target is checked at activation, self-escalation is rejected, attempts and total escalations are capped, and the path is recorded on the node as `source → target` with a reason.
- A `verify.command` runs in the workspace after the step and its exit code is the verdict; a failure marks the step blocked, which is exactly the escalation trigger.
- Changed files come from the child's own `write`/`edit` tool events, not from what the child claims. Writes outside the workspace are recorded separately.
- The model-facing result is capped at `maxResultChars` and always names the run directory, so the full detail stays one read away.

## Runs, retention, resume

Each run writes `~/.pi/agent/pipeline/runs/<runId>/`:

| File | Contents |
|---|---|
| `run.json` | nodes, `rounds[]`, cumulative usage |
| `node-<id>.output.md` | each node's full output |
| `<session>.jsonl` | the child's own session transcript |
| `events.jsonl` | node start/end, escalation and error events |

Retention: finished runs age out by `maxAgeDays`, then by `keep`; unfinished runs are **pinned** and dropped only as a last resort, and every such drop is reported at session start.

`pipeline({ resume: runId })` or `/pipeline-resume <runId>` re-runs every non-`ok` node as a new round against the **currently active** profile, preserving `ok` nodes and cumulative usage. A role that has left the roster is named as a profile error. Each node records its `profile` and `round`, so rounds of a resumed run are visibly not comparable when the profile changed.

## UI and commands

- Inline tree under the `pipeline` tool call, live while children stream.
- One-line widget under the editor: `▸ pipeline profile: default · 1 running · 2/3 ok · 12400 tok` — the raw token count, not abbreviated.
- `/pipeline-tree`, or the configured shortcut (setting `pipeline.treeShortcut`, default `ctrl+shift+p`), opens the overlay: `↑↓`/`jk` select, `Enter` detail (status, verification, artifacts, output and transcript paths), `x` stop the selected node, `Esc` close.

| Command | Purpose |
|---|---|
| `/pipeline-aggressiveness [low\|medium\|high\|off]` | How readily the parent delegates (this session); `default <level>` persists it, `status` reports it |
| `/pipeline-tree` | The live tree (non-TUI modes print it) |
| `/pipeline-profile [name\|none\|list\|check\|generate]` | List, switch, validate, or generate a roster from the registry (`generate <provider> [role,role,...]`, metadata only, no probes) |
| `/pipeline-init [name] [cheap] [mid] [strong]` | Pick per-role models from the accessible registry (cheap/mid/strong tiers suggested by cost), write them as a user profile that `extends` the active roster, and activate it |
| `/pipeline-stop [nodeId]` | Stop a node, or the whole run |
| `/pipeline-resume <runId>` | Continue a recorded run |
| `/pipeline-runs` | List recorded runs |
| `/pipeline-doctor` | Active profile and source, every role's resolved model and credential state, limits, run-dir size, resumable count, delegation-tool collisions |
| `/pipeline-smoke` | One real read-only step, to verify children work (needs `PIPELINE_SMOKE=1`; spends tokens) |

`pipeline_status({action: "roster" | "tree" | "runs" | "stop", runId?, nodeId?})` exposes the same surface to the model, and is always authoritative for the roster. `/pipeline-doctor` reports the run directory as `<runs> on disk, <KiB> KiB · <n> resumable`.

## Checking it

```bash
npm install                                        # devDependencies: typescript and @types/node
npm run typecheck                                  # strict, no output means clean
npm run check                                      # node --experimental-strip-types scripts/selfcheck.mjs
PIPELINE_SMOKE=1 pi --extension ./src/index.ts     # then /pipeline-smoke
```

`selfcheck.mjs` needs no dependencies: the pure modules (`profiles.ts`, `plan.ts`, `runs.ts`) have no platform imports, so profile discovery and validation, ordering, reader/writer promotion, sentinel parsing, budget and escalation decisions, retention and the tree renderer are exercised directly.

## Trust

Profile files carry system prompts, tool allowlists and optional `verify.command` values, so **project-scoped profiles are only read after project trust**, and children inherit the parent's trust decision without prompting. A user profile may not extend a project profile. Escalation never widens a role's tool allowlist. Children run with Pi's normal (unsandboxed) OS permissions.

## Known limitations

- **In-process children only.** Detached/background runs need an `@earendil-works/pi-agent-core/node` export this Pi install does not provide; a run therefore lives and dies with its session.
- Role prompts are **appended** to the child's system prompt (so children keep Pi's built-in tool guidance) rather than replacing it.
- Model resolution is implemented on `ctx.modelRegistry` rather than `resolveCliModel`, because the extension context exposes a `ModelRegistry`, not a `ModelRuntime`.
- No steering of a live child (stop only), no worktree isolation, no external CLI runners, no live provider probes.

## Publishing

```bash
npm publish --access public
```

The `pi-package` keyword is what makes it eligible for the [Pi package gallery](https://pi.dev/packages), and `pi.extensions` / `pi.skills` declare what ships. `assets/icon-master.png` is the card image referenced by `pi.image`, so it has to be committed and pushed before the gallery can render it.
