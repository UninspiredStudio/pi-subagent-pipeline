/** Tool parameter schemas, shared by the parent tool and the nested child tool. */
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { THINKING_LEVELS } from "./profiles.ts";

export const StepSchema = Type.Object({
  id: Type.String({ description: "Unique step id, used by needs and as the node id" }),
  role: Type.String({ description: "A role from the active roster" }),
  objective: Type.String({ description: "What this step must achieve" }),
  deliverable: Type.String({ description: "The exact output or artifact expected" }),
  scope: Type.Optional(Type.String({ description: "Boundaries: what not to touch" })),
  context: Type.Optional(Type.Array(Type.String({ description: "Path or artifact to read first" }))),
  needs: Type.Optional(Type.Array(Type.String({ description: "Step ids that must finish first" }))),
  model: Type.Optional(Type.String({ description: "Per-step model override (provider/id or provider/id:effort)" })),
  thinking: Type.Optional(StringEnum(THINKING_LEVELS)),
  touches: Type.Optional(Type.Array(Type.String({ description: "Globs this step will write (write roles only)" }))),
});

export const PipelineParams = Type.Object({
  steps: Type.Array(StepSchema, { description: "Ordered plan; ordering comes from needs, not array position" }),
  profile: Type.Optional(Type.String({ description: "Run on a named profile without changing the active one" })),
  concurrency: Type.Optional(Type.Number({ minimum: 1, maximum: 32, description: "Max parallel read-only steps (clamped to the profile's maxConcurrent)" })),
  resume: Type.Optional(Type.String({ description: "Resume a recorded run id" })),
});

export const StatusParams = Type.Object({
  action: StringEnum(["roster", "tree", "runs", "stop"], { description: "roster: the active profile and its roles; tree: run nodes; runs: recorded runs; stop: stop a node or run" }),
  runId: Type.Optional(Type.String()),
  nodeId: Type.Optional(Type.String()),
});
