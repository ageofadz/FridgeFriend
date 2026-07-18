import { randomUUID } from "node:crypto";

import { Command, END, MemorySaver, START, StateGraph, StateSchema } from "@langchain/langgraph";
import { z } from "zod";

import { CHAT_MODEL } from "../../ai/chat-model.server";
import {
  buildQueryTraceOptions,
  classifyError,
  graphRevisionFor,
} from "../../observability/trace-context.server";
import {
  loadEvalPromptBundle,
  loadPromptBundle,
  type PromptBundle,
} from "../../prompts/registry.server";
import { createQueryGraph, normalizeQueryInput } from "../../query/graph.server";
import type { QueryGraphDependencies, QueryGraphInput } from "../../query/schemas/query";
import type { FridgeQueryStateValue } from "../../query/state";
import type { WorkspaceAction } from "../../../workspace/contracts";
import { captureGraphRun } from "../capture/trajectory-capture";
import { createFixtureImageResolver } from "../fixtures/fixture-image-resolver";
import { createFixtureInventoryAdapter } from "../fixtures/fixture-inventory-adapter";
import { createFixtureMemoryAdapter } from "../fixtures/fixture-memory-adapter";
import { createFixtureRecipeAdapter } from "../fixtures/fixture-recipe-adapter";
import {
  cloneCounters,
  createFixtureSideEffectLog,
  workspaceGrounding,
  type FixtureSideEffectLog,
  type WorkspaceGrounding,
} from "../fixtures/fixture-workspace-adapter";
import { createReplaySession, type ReplaySession } from "../replay/replay-model";
import { groupReplaySteps, ReplayMismatchError } from "../replay/replay-sequence";
import {
  EvalModeSchema,
  EvalResultSchema,
  type EvalError,
  type EvalMode,
  type EvalResult,
  type ReplayConsumptionReport,
} from "../schemas/eval-result";
import { QueryEvalCaseSchema, type QueryEvalCase } from "../schemas/query-eval-case";
import type { FixtureSideEffectCounters, StateDelta, TrajectoryEvent } from "../schemas/trajectory";

/**
 * Contract consumed by the deterministic evaluators. Assembled verbatim by
 * normalize_result — evaluators parse `EvalResult.output` against this shape.
 */
export type QueryEvalOutput = {
  answer: string | null;
  intent: string | null;
  terminalRoute: string;
  shoppingMode: string;
  recipeContinuation: boolean;
  workspaceActions: WorkspaceAction[];
  interrupted: boolean;
  interrupts: Array<Record<string, unknown>>;
  memoryWriteResults: unknown[];
  memoryWriteVerification: unknown;
  recipeIds: string[];
  recipeRetrievalAudit: unknown;
  counters: FixtureSideEffectCounters;
  countersBeforeResume?: FixtureSideEffectCounters;
  writes: Array<{ kind: string; target: string }>;
  grounding: WorkspaceGrounding;
};

const QueryEvalState = new StateSchema({
  case: z.unknown().optional(),
  // Explicit override; defaults from replay-step presence.
  mode: EvalModeSchema.nullable().default(null),
  result: EvalResultSchema.nullable().default(null),
  run: z.unknown().optional(),
});

type RunRecord = {
  status: EvalResult["status"];
  threadId: string;
  mode: EvalMode;
  trajectory: TrajectoryEvent[];
  stateDeltas: StateDelta[];
  interrupts: Array<Record<string, unknown>>;
  replay: ReplayConsumptionReport | null;
  error: EvalError | null;
  promptRefs: string[];
  counters: FixtureSideEffectCounters;
  countersBeforeResume?: FixtureSideEffectCounters;
  writes: FixtureSideEffectLog["writes"];
  final: {
    answer: string | null;
    intent: string | null;
    context: Record<string, unknown>;
    memoryWriteResults: unknown[];
    recipeRetrievalAudit: unknown;
  };
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
    suite: "query",
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
    model: CHAT_MODEL,
  };
}

function promptRefRecord(bundle: PromptBundle): Record<string, string> {
  return Object.fromEntries(
    Object.entries(bundle).map(([key, prompt]) => [key, prompt.ref]),
  );
}

function replayDependencies(session: ReplaySession): QueryGraphDependencies {
  return {
    intentEmbeddingRouter: session.intentRouter(),
    intentModel: session.modelFor("intent"),
    seededInventoryAssertionModel: session.modelFor("seeded_inventory_assertion"),
    memoryExtractionModel: session.modelFor("memory_extraction"),
    recipeSearchModel: session.modelFor("recipe_search"),
    recipeRetrievalGradeModel: session.modelFor("recipe_retrieval_grade"),
    recipeTournamentModel: session.modelFor("recipe_tournament"),
    groceryRecipeSelectionModel: session.modelFor("grocery_recipe_selection"),
    groceryAisleAssignmentModel: session.modelFor("grocery_aisle_assignment"),
    organizationPlannerModel: session.modelFor("organization_plan"),
    enrichmentModel: session.modelFor("enrichment"),
    inventorySplitModel: session.modelFor("inventory_split"),
    workspaceActionModel: session.modelFor("workspace_action"),
    responseModel: session.modelFor("response"),
  };
}

function finalStateExtract(state: FridgeQueryStateValue | null): RunRecord["final"] {
  const context = state && isRecord(state.context) ? (state.context as Record<string, unknown>) : {};

  return {
    answer: typeof state?.answer === "string" ? state.answer : null,
    intent: typeof state?.intent === "string" ? state.intent : null,
    context,
    memoryWriteResults: Array.isArray(state?.memoryWriteResults) ? state.memoryWriteResults : [],
    recipeRetrievalAudit: state?.recipeRetrievalAudit ?? null,
  };
}

function recipeIdsFromContext(context: Record<string, unknown>): string[] {
  const retrieval = isRecord(context.recipeRetrieval) ? context.recipeRetrieval : {};
  const recipes = Array.isArray(retrieval.recipes) ? retrieval.recipes : [];

  return recipes.flatMap((recipe) =>
    isRecord(recipe) && typeof recipe.id === "string" ? [recipe.id] : [],
  );
}

function workspaceActionsFromContext(context: Record<string, unknown>): WorkspaceAction[] {
  return Array.isArray(context.workspaceActions)
    ? (context.workspaceActions as WorkspaceAction[])
    : [];
}

async function runProductionGraph(input: {
  caseData: QueryEvalCase;
  mode: EvalMode;
}): Promise<RunRecord> {
  const { caseData, mode } = input;
  const log = createFixtureSideEffectLog();
  const session = mode === "replay" ? createReplaySession(caseData.replay ?? []) : null;
  const promptBundle = mode === "replay" ? await loadPromptBundle() : await loadEvalPromptBundle();
  const resolver = createFixtureImageResolver(caseData.fixtures.images);

  const deps: QueryGraphDependencies = {
    checkpointer: new MemorySaver() as never,
    promptBundle,
    ...createFixtureInventoryAdapter({ inventory: caseData.fixtures.inventory, log }),
    ...createFixtureMemoryAdapter({
      memories: caseData.fixtures.memories,
      knowledgeDocuments: caseData.fixtures.knowledgeDocuments,
      log,
    }),
    ...createFixtureRecipeAdapter(caseData.fixtures),
    loadImageDataUrlForQuery: resolver.loadImageDataUrlForQuery,
    ...(session ? replayDependencies(session) : {}),
  };

  const graph = createQueryGraph(deps);
  const threadId = `eval:query:${caseData.caseId}:${randomUUID()}`;
  const normalizedInput = normalizeQueryInput({
    ...(caseData.input as QueryGraphInput),
    threadId,
    requestId: `eval:${caseData.caseId}:${randomUUID()}`,
  });
  const traceOptions = buildQueryTraceOptions({
    threadId,
    requestId: normalizedInput.requestId,
    userId: normalizedInput.userId,
    fridgeId: normalizedInput.fridgeId,
    imageId: normalizedInput.imageId,
    environment: "evaluation",
    mode,
    model: CHAT_MODEL,
    promptRefs: promptRefRecord(promptBundle),
    graphRevision: graphRevisionFor(graph as never),
    evalCaseId: caseData.caseId,
    evalDatasetRevision: caseData.revision,
  });
  const config = {
    ...traceOptions,
    maxConcurrency: 5,
    configurable: { thread_id: threadId },
  };
  const promptRefs = Object.values(promptRefRecord(promptBundle));
  const assignedModelCalls: Record<string, number> = {};
  const modelCallCounts = session ? () => session.modelCallCounts() : undefined;

  const base = {
    threadId,
    mode,
    promptRefs,
    writes: log.writes,
  };

  try {
    const first = await captureGraphRun<FridgeQueryStateValue>({
      graph,
      value: normalizedInput,
      config,
      modelCallCounts,
      assignedModelCalls,
      sideEffectLog: log,
    });
    let trajectory = first.trajectory;
    let stateDeltas = first.stateDeltas;
    let interrupts = first.interrupts;
    let state = first.state;
    let countersBeforeResume: FixtureSideEffectCounters | undefined;
    let status: EvalResult["status"] = "completed";

    if (interrupts.length > 0) {
      countersBeforeResume = cloneCounters(log);

      if (caseData.resume) {
        const resumed = await captureGraphRun<FridgeQueryStateValue>({
          graph,
          value: new Command({ resume: caseData.resume }),
          config,
          modelCallCounts,
          assignedModelCalls,
          sideEffectLog: log,
          sequenceStart: trajectory.length,
        });
        trajectory = [...trajectory, ...resumed.trajectory];
        stateDeltas = [...stateDeltas, ...resumed.stateDeltas];
        state = resumed.state ?? state;

        if (resumed.interrupts.length > 0) {
          interrupts = [...interrupts, ...resumed.interrupts];
          status = "interrupted";
        }
      } else {
        status = "interrupted";
      }
    }

    const replay = session?.report() ?? null;
    let error: EvalError | null = null;

    if (status === "completed" && replay && !replay.consumedExactly) {
      status = "replay_mismatch";
      error = {
        errorKind: "replay_mismatch",
        node: trajectory[trajectory.length - 1]?.node ?? "invoke_production_graph",
        message: `Replay run finished with unused replay steps: ${replay.unusedCallIds.join(", ")}`,
      };
    }

    return {
      ...base,
      status,
      trajectory,
      stateDeltas,
      interrupts,
      replay,
      error,
      counters: cloneCounters(log),
      ...(countersBeforeResume ? { countersBeforeResume } : {}),
      final: finalStateExtract(state),
    };
  } catch (error) {
    // Never fabricate an answer for a failed run (spec requirement) — report
    // the failure with a classified error instead.
    const node = "invoke_production_graph";
    const classified = classifyError(error, node);
    const status = error instanceof ReplayMismatchError || classified.errorKind === "replay_mismatch"
      ? "replay_mismatch" as const
      : "failed" as const;

    return {
      ...base,
      status,
      trajectory: [],
      stateDeltas: [],
      interrupts: [],
      replay: session?.report() ?? null,
      error: classified,
      counters: cloneCounters(log),
      final: finalStateExtract(null),
    };
  }
}

function assembleResult(caseData: QueryEvalCase, run: RunRecord): EvalResult {
  const context = run.final.context;
  const routing = isRecord(context.intentRouting) ? context.intentRouting : {};
  const interrupted = run.status === "interrupted";
  const lastNode = run.trajectory[run.trajectory.length - 1]?.node ?? "";

  const output: QueryEvalOutput = {
    answer: run.final.answer,
    intent: run.final.intent,
    terminalRoute: interrupted ? "review_interrupt" : lastNode,
    shoppingMode: typeof routing.shoppingMode === "string" ? routing.shoppingMode : "direct",
    recipeContinuation: routing.recipeContinuation === true,
    workspaceActions: workspaceActionsFromContext(context),
    interrupted,
    interrupts: run.interrupts,
    memoryWriteResults: run.final.memoryWriteResults,
    memoryWriteVerification: context.memoryWriteVerification ?? null,
    recipeIds: recipeIdsFromContext(context),
    recipeRetrievalAudit: run.final.recipeRetrievalAudit,
    counters: run.counters,
    ...(run.countersBeforeResume ? { countersBeforeResume: run.countersBeforeResume } : {}),
    writes: run.writes,
    grounding: workspaceGrounding(caseData.fixtures),
  };

  return {
    caseId: caseData.caseId,
    revision: caseData.revision,
    suite: "query",
    mode: run.mode,
    status: run.status,
    threadId: run.threadId,
    error: run.error,
    trajectory: run.trajectory,
    stateDeltas: run.stateDeltas,
    replay: run.replay,
    output: output as unknown as Record<string, unknown>,
    feedback: [],
    promptRefs: run.promptRefs,
    model: CHAT_MODEL,
  };
}

/**
 * Thin eval wrapper around the production query graph (spec "Evaluation
 * targets"): START -> validate_case -> prepare_fixture_dependencies ->
 * invoke_production_graph -> normalize_result -> END. Routing logic lives
 * entirely in the production graph; this wrapper only injects fixtures,
 * captures trajectory/state deltas, and normalizes the result.
 */
export function createQueryEvalGraph() {
  return new StateGraph(QueryEvalState)
    .addNode("validate_case", async (state) => {
      const parsed = QueryEvalCaseSchema.safeParse(state.case);

      if (!parsed.success) {
        const message = `Query eval case is invalid: ${parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "case"}: ${issue.message}`)
          .join("; ")}`;
        return { result: invalidCaseResult({ rawCase: state.case, mode: modeOf(state), message }) };
      }

      return {};
    })
    .addNode("prepare_fixture_dependencies", async (state) => {
      if (state.result) return {};
      const caseData = QueryEvalCaseSchema.parse(state.case);

      try {
        // Replay steps must map onto known call sites before execution.
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
        for (const imageId of imageIds) {
          resolver.loadImageDataUrlForQuery(imageId);
        }
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
      const caseData = QueryEvalCaseSchema.parse(state.case);
      const run = await runProductionGraph({ caseData, mode: modeOf(state) });

      return { run };
    })
    .addNode("normalize_result", async (state) => {
      if (state.result) return {};
      const caseData = QueryEvalCaseSchema.parse(state.case);

      return { result: assembleResult(caseData, state.run as RunRecord) };
    })
    .addEdge(START, "validate_case")
    .addEdge("validate_case", "prepare_fixture_dependencies")
    .addEdge("prepare_fixture_dependencies", "invoke_production_graph")
    .addEdge("invoke_production_graph", "normalize_result")
    .addEdge("normalize_result", END)
    .compile();
}
