import { z } from "zod";

import { TrajectoryEventSchema, StateDeltaSchema } from "./trajectory";

export const EvalModeSchema = z.enum(["replay", "live"]);
export type EvalMode = z.infer<typeof EvalModeSchema>;

export const EvalCaseKindSchema = z.enum([
  "node_contract",
  "route_contract",
  "policy_safety",
  "model_behavior",
  "end_to_end",
]);
export type EvalCaseKind = z.infer<typeof EvalCaseKindSchema>;

export const EvalSplitSchema = z.enum(["smoke", "regression", "live", "safety"]);
export type EvalSplit = z.infer<typeof EvalSplitSchema>;

export const EvalStatusSchema = z.enum([
  "completed",
  "interrupted",
  "invalid_case",
  "replay_mismatch",
  "failed",
]);
export type EvalStatus = z.infer<typeof EvalStatusSchema>;

// Error classification required by the observability spec. `replay_mismatch`
// extends the spec's five kinds so strict replay failures stay distinguishable.
export const EvalErrorKindSchema = z.enum([
  "provider",
  "timeout",
  "schema",
  "fixture",
  "runtime",
  "replay_mismatch",
]);
export type EvalErrorKind = z.infer<typeof EvalErrorKindSchema>;

export const EvalErrorSchema = z.object({
  errorKind: EvalErrorKindSchema,
  node: z.string(),
  message: z.string(),
  retryAttempt: z.number().int().nonnegative().optional(),
  model: z.string().optional(),
  promptRef: z.string().optional(),
});
export type EvalError = z.infer<typeof EvalErrorSchema>;

export const EvalFeedbackSchema = z.object({
  key: z.string().min(1),
  score: z.number().min(0).max(1),
  comment: z.string().min(1),
});
export type EvalFeedback = z.infer<typeof EvalFeedbackSchema>;

export const ReplayConsumptionReportSchema = z.object({
  consumedCallIds: z.array(z.string()),
  unusedCallIds: z.array(z.string()),
  consumedExactly: z.boolean(),
});
export type ReplayConsumptionReport = z.infer<typeof ReplayConsumptionReportSchema>;

export const EvalResultSchema = z.object({
  caseId: z.string().min(1),
  revision: z.string().min(1),
  suite: z.enum(["query", "scan"]),
  mode: EvalModeSchema,
  status: EvalStatusSchema,
  threadId: z.string().min(1),
  error: EvalErrorSchema.nullable().default(null),
  trajectory: z.array(TrajectoryEventSchema).default([]),
  stateDeltas: z.array(StateDeltaSchema).default([]),
  replay: ReplayConsumptionReportSchema.nullable().default(null),
  output: z.record(z.string(), z.unknown()).default({}),
  feedback: z.array(EvalFeedbackSchema).default([]),
  promptRefs: z.array(z.string()).default([]),
  model: z.string(),
});
export type EvalResult = z.infer<typeof EvalResultSchema>;
