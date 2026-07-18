import { randomUUID } from "node:crypto";

import { END, START, StateGraph, StateSchema } from "@langchain/langgraph";
import { z } from "zod";

import { CHAT_VISION_MODEL } from "../../ai/chat-model.server";
import {
  buildScanTraceOptions,
  classifyError,
  graphRevisionFor,
} from "../../observability/trace-context.server";
import {
  loadEvalPromptBundle,
  loadPromptBundle,
  type PromptBundle,
} from "../../prompts/registry.server";
import { createScanGraph } from "../../scan/graph.server";
import type { ScanStateValue } from "../../scan/state";
import { captureGraphRun } from "../capture/trajectory-capture";
import { createFixtureImageResolver } from "../fixtures/fixture-image-resolver";
import { createReplaySession } from "../replay/replay-model";
import { groupReplaySteps, ReplayMismatchError } from "../replay/replay-sequence";
import {
  EvalModeSchema,
  EvalResultSchema,
  type EvalError,
  type EvalMode,
  type EvalResult,
} from "../schemas/eval-result";
import { ScanEvalCaseSchema, type ScanEvalCase } from "../schemas/scan-eval-case";

/**
 * Contract consumed by the scan evaluators. Assembled verbatim by
 * normalize_result.
 */
export type ScanEvalOutput = {
  terminalRoute: string;
  scanStatus: string;
  imageValidation: unknown;
  detectionValidation: unknown;
  zoneMapValidation: unknown;
  placementValidation: unknown;
  inventoryValidation: unknown;
  rawDetections: unknown[];
  zoneMaps: unknown[];
  groundedPlacements: unknown[];
  inventory: unknown;
  error: unknown;
};

const ScanEvalState = new StateSchema({
  case: z.unknown().optional(),
  mode: EvalModeSchema.nullable().default(null),
  result: EvalResultSchema.nullable().default(null),
  run: z.unknown().optional(),
});

type RunRecord = {
  status: EvalResult["status"];
  threadId: string;
  mode: EvalMode;
  trajectory: EvalResult["trajectory"];
  replay: EvalResult["replay"];
  error: EvalError | null;
  promptRefs: string[];
  output: ScanEvalOutput;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function caseIdOf(rawCase: unknown): string {
  return isRecord(rawCase) && typeof rawCase.caseId === "string" && rawCase.caseId.length > 0
    ? rawCase.caseId
    : "invalid-case";
}

function revisionOf(rawCase: unknown): string {
  return isRecord(rawCase) && typeof rawCase.revision === "string" && rawCase.revision.length > 0
    ? rawCase.revision
    : "unknown";
}

function modeOf(state: { mode: EvalMode | null; case?: unknown }): EvalMode {
  if (state.mode) return state.mode;
  const rawCase = state.case;
  const replay = isRecord(rawCase) ? rawCase.replay : undefined;
  return Array.isArray(replay) && replay.length > 0 ? "replay" : "live";
}

function invalidCaseResult(input: { rawCase: unknown; mode: EvalMode; message: string }): EvalResult {
  return {
    caseId: caseIdOf(input.rawCase),
    revision: revisionOf(input.rawCase),
    suite: "scan",
    mode: input.mode,
    status: "invalid_case",
    threadId: "none",
    error: { errorKind: "fixture", node: "validate_case", message: input.message },
    trajectory: [],
    stateDeltas: [],
    replay: null,
    output: {},
    feedback: [],
    promptRefs: [],
    model: CHAT_VISION_MODEL,
  };
}

function promptRefRecord(bundle: PromptBundle): Record<string, string> {
  return Object.fromEntries(Object.entries(bundle).map(([key, prompt]) => [key, prompt.ref]));
}

function scanOutput(state: ScanStateValue | null, terminalRoute: string): ScanEvalOutput {
  return {
    terminalRoute,
    scanStatus: typeof state?.scanStatus === "string" ? state.scanStatus : "",
    imageValidation: state?.imageValidation ?? null,
    detectionValidation: state?.detectionValidation ?? null,
    zoneMapValidation: state?.zoneMapValidation ?? null,
    placementValidation: state?.placementValidation ?? null,
    inventoryValidation: state?.inventoryValidation ?? null,
    rawDetections: Array.isArray(state?.rawDetections) ? state.rawDetections : [],
    zoneMaps: Array.isArray(state?.zoneMaps) ? state.zoneMaps : [],
    groundedPlacements: Array.isArray(state?.groundedPlacements) ? state.groundedPlacements : [],
    inventory: state?.inventory ?? null,
    error: state?.error ?? null,
  };
}

async function runScanCase(input: { caseData: ScanEvalCase; mode: EvalMode }): Promise<RunRecord> {
  const { caseData, mode } = input;
  const session = mode === "replay" ? createReplaySession(caseData.replay ?? []) : null;
  const promptBundle = mode === "replay" ? await loadPromptBundle() : await loadEvalPromptBundle();
  const resolver = createFixtureImageResolver(caseData.fixtures.images);
  const threadId = `eval:scan:${caseData.caseId}:${randomUUID()}`;

  // The scan graph has no interrupt sites, so no checkpointer is needed.
  const graph = await createScanGraph({
    promptBundle,
    checkpointer: null,
    loadImageDataUrls: resolver.loadImageDataUrls,
    ...(session
      ? {
        validationModel: session.modelFor("image_validation"),
        detectionModel: session.modelFor("inventory_detection"),
        zoneMapModel: session.modelFor("zone_map"),
      }
      : {}),
  });
  const traceOptions = buildScanTraceOptions({
    threadId,
    requestId: `eval:${caseData.caseId}`,
    fridgeId: caseData.input.fridgeId,
    imageId: caseData.input.imageId,
    environment: "evaluation",
    mode,
    model: CHAT_VISION_MODEL,
    promptRefs: promptRefRecord(promptBundle),
    graphRevision: graphRevisionFor(graph as never),
    evalCaseId: caseData.caseId,
    evalDatasetRevision: caseData.revision,
    imageCount: 1,
    storageKind: caseData.input.storageLocation,
  });
  const promptRefs = Object.values(promptRefRecord(promptBundle));
  const base = { threadId, mode, promptRefs };

  try {
    const { trajectory, state } = await captureGraphRun<ScanStateValue>({
      graph,
      value: {
        fridgeId: caseData.input.fridgeId,
        imageIds: [caseData.input.imageId],
        storageLocation: caseData.input.storageLocation,
      },
      config: {
        ...traceOptions,
        configurable: { thread_id: threadId },
      },
      modelCallCounts: session ? () => session.modelCallCounts() : undefined,
    });
    const terminalRoute = trajectory[trajectory.length - 1]?.node ?? "";
    const replay = session?.report() ?? null;
    let status: EvalResult["status"] = "completed";
    let error: EvalError | null = null;

    if (replay && !replay.consumedExactly) {
      status = "replay_mismatch";
      error = {
        errorKind: "replay_mismatch",
        node: terminalRoute || "invoke_production_graph",
        message: `Replay run finished with unused replay steps: ${replay.unusedCallIds.join(", ")}`,
      };
    }

    return {
      ...base,
      status,
      trajectory,
      replay,
      error,
      output: scanOutput(state, terminalRoute),
    };
  } catch (error) {
    const classified = classifyError(error, "invoke_production_graph");
    const status = error instanceof ReplayMismatchError || classified.errorKind === "replay_mismatch"
      ? "replay_mismatch" as const
      : "failed" as const;

    return {
      ...base,
      status,
      trajectory: [],
      replay: session?.report() ?? null,
      error: classified,
      output: scanOutput(null, ""),
    };
  }
}

/**
 * Thin eval wrapper around the production scan graph. Same wrapper shape as
 * the query eval graph; the production topology is never duplicated here.
 */
export function createScanEvalGraph() {
  return new StateGraph(ScanEvalState)
    .addNode("validate_case", async (state) => {
      const parsed = ScanEvalCaseSchema.safeParse(state.case);

      if (!parsed.success) {
        const message = `Scan eval case is invalid: ${parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "case"}: ${issue.message}`)
          .join("; ")}`;
        return { result: invalidCaseResult({ rawCase: state.case, mode: modeOf(state), message }) };
      }

      return {};
    })
    .addNode("prepare_fixture_dependencies", async (state) => {
      if (state.result) return {};
      const caseData = ScanEvalCaseSchema.parse(state.case);

      try {
        groupReplaySteps(caseData.replay ?? []);

        const callIds = (caseData.replay ?? []).map((step) => step.callId);
        if (new Set(callIds).size !== callIds.length) {
          throw new Error("Replay steps contain duplicate callIds");
        }

        const imageIds = caseData.fixtures.images.map((image) => image.imageId);
        if (new Set(imageIds).size !== imageIds.length) {
          throw new Error("Image fixtures contain duplicate imageIds");
        }

        const resolver = createFixtureImageResolver(caseData.fixtures.images);
        resolver.loadImageDataUrls([caseData.input.imageId]);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          result: invalidCaseResult({
            rawCase: state.case,
            mode: modeOf(state),
            message: `Fixture validation failed: ${message}`,
          }),
        };
      }

      return {};
    })
    .addNode("invoke_production_graph", async (state) => {
      if (state.result) return {};
      const caseData = ScanEvalCaseSchema.parse(state.case);
      const run = await runScanCase({ caseData, mode: modeOf(state) });

      return { run };
    })
    .addNode("normalize_result", async (state) => {
      if (state.result) return {};
      const caseData = ScanEvalCaseSchema.parse(state.case);
      const run = state.run as RunRecord;

      return {
        result: {
          caseId: caseData.caseId,
          revision: caseData.revision,
          suite: "scan" as const,
          mode: run.mode,
          status: run.status,
          threadId: run.threadId,
          error: run.error,
          trajectory: run.trajectory,
          stateDeltas: [],
          replay: run.replay,
          output: run.output as unknown as Record<string, unknown>,
          feedback: [],
          promptRefs: run.promptRefs,
          model: CHAT_VISION_MODEL,
        },
      };
    })
    .addEdge(START, "validate_case")
    .addEdge("validate_case", "prepare_fixture_dependencies")
    .addEdge("prepare_fixture_dependencies", "invoke_production_graph")
    .addEdge("invoke_production_graph", "normalize_result")
    .addEdge("normalize_result", END)
    .compile();
}
