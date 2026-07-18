// Public surface of the evaluation layer.

export * from "./schemas/eval-result";
export * from "./schemas/trajectory";
export * from "./schemas/query-eval-case";
export * from "./schemas/scan-eval-case";

export {
  ReplayMismatchError,
  QUERY_REPLAY_CALL_SITES,
  SCAN_REPLAY_CALL_SITES,
  canonicalSchemaName,
  groupReplaySteps,
  type ReplayCallSite,
  type ReplayCallSiteKey,
} from "./replay/replay-sequence";
export { createReplaySession, type ReplaySession } from "./replay/replay-model";

export {
  createFixtureSideEffectLog,
  cloneCounters,
  workspaceGrounding,
  type FixtureSideEffectLog,
  type FixtureSideEffectWrite,
  type WorkspaceGrounding,
} from "./fixtures/fixture-workspace-adapter";
export { createFixtureInventoryAdapter } from "./fixtures/fixture-inventory-adapter";
export { createFixtureMemoryAdapter } from "./fixtures/fixture-memory-adapter";
export { createFixtureRecipeAdapter } from "./fixtures/fixture-recipe-adapter";
export { createFixtureImageResolver } from "./fixtures/fixture-image-resolver";

export {
  captureGraphRun,
  type CaptureGraphRunResult,
} from "./capture/trajectory-capture";
export {
  captureStateDeltas,
  DEFAULT_SAFETY_NODES,
  type StateDeltaCapture,
} from "./capture/state-delta-capture";

export { createQueryEvalGraph, type QueryEvalOutput } from "./graphs/query-eval.graph";
export { createScanEvalGraph, type ScanEvalOutput } from "./graphs/scan-eval.graph";
