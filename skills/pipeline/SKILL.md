---
name: pipeline
description: Reference for the pi-pipeline plugin - the profile schema, the pipeline and pipeline_status tools, step parameters, verification, escalation, and resuming a run. Load when authoring a subagent profile or when a pipeline step failed and you need to know why.
---

# pi-pipeline

A profile is the subagent roster: it defines which subagents exist, each with its own model, provider,
thinking effort, tools, access class and prompt, plus the run envelope (budget, depth, concurrency).

- `~/.pi/agent/profiles/pipeline/*.json` - user profiles
- `<project>/.pi/pipeline/profiles/*.json` - project profiles (require project trust; they win)
- `<package>/profiles/*.json` - the roster shipped with the plugin, used when nothing else defines one
- Long prompts live in `<role>.md` next to the profile, referenced with `promptFile`

The active profile is a plugin-owned pointer. `/pipeline-profile` picks one, `/pipeline-profile <name>`
switches, `pipeline({profile})` uses one for a single run, and `--pipeline-profile <name>` pins a session.

`aggressiveness` (`low` | `medium` | `high` | `off`) on the profile sets how readily the parent delegates;
`/pipeline-aggressiveness <level>` overrides it for the session (`default <level>` persists the default),
and `/pipeline-profile list | check | generate` lists rosters, validates the active one, or builds one from
the model registry.

## Running work

`pipeline({ steps })` runs a plan. Each step needs `id`, `role`, `objective` and `deliverable`. Optional:
`scope`, `context`, `needs`, `model`, `thinking`, `touches` (write globs). Independent read-only steps run in
parallel; a step with `access: write` runs alone, and a reader that could see a partial write is promoted
after the writer automatically.

Every child ends its reply with `PIPELINE_STATUS: ok` or `PIPELINE_STATUS: blocked - <reason>`. Only an
explicit `blocked`, a failed `verify.command`, an error or a timeout triggers escalation.

`pipeline_status({action})` reads or controls a run: `roster`, `tree`, `runs`, `stop`. A stopped or
interrupted run can be resumed with `pipeline({resume: runId})`, which re-resolves its remaining steps
against the currently active profile.

## When a step fails

Check `/pipeline-doctor` first: it reports the active profile and source file, each role's resolved model
and effort, unresolved or unauthenticated bindings, limits, the pinned run count and delegation-tool
collisions. Then `/pipeline-tree` for the run, and the run directory at
`~/.pi/agent/pipeline/runs/<runId>/` for the full child output and transcript.
