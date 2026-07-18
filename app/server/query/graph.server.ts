import { Command, END, START, Overwrite, StateGraph, type RetryPolicy } from "@langchain/langgraph";

import { checkpointer } from "../checkpointer.server";
import {
  readGeminiStream,
} from "../ai/gemini-errors.server";
import { getLangSmithConfig } from "../langsmith.server";
import { CHAT_MODEL } from "../ai/chat-model.server";
import {
  buildQueryTraceOptions,
  graphRevisionFor,
  resolveTraceEnvironment,
} from "../observability/trace-context.server";
import { loadPromptBundle } from "../prompts/registry.server";
import { createCalculateSpaceNode } from "./nodes/calculate-space.node";
import { createDetermineIntentNode } from "./nodes/determine-intent.node";
import { createApplySeededInventoryAssertionsNode } from "./nodes/apply-seeded-inventory-assertions.node";
import { createBuildRecipeSearchNode } from "./nodes/build-recipe-search.node";
import {
  createExtractMemoryCandidatesNode,
  filterRecipeGoalCandidates,
} from "./nodes/extract-memory-candidates.node";
import { createLoadFridgeContextNode } from "./nodes/load-fridge-context.node";
import {
  createApplyMemoryWritesNode,
  createIndexSemanticMemoryNode,
  createReloadMemoryContextNode,
} from "./nodes/persist-memory.node";
import { createPlanWorkspaceActionsNode } from "./nodes/plan-workspace-actions.node";
import { createPlanExpiryNode } from "./nodes/plan-expiry.node";
import { createQueryInventoryNode } from "./nodes/query-inventory.node";
import { createProposeScopedInventorySplitNode, reviewScopedInventorySplitNode, routeScopedInventorySplitReview } from "./nodes/propose-drawer-split.node";
import {
  createAssessInventoryEnrichmentNode,
  createPersistInventoryEnrichmentNode,
  createRequestInventoryClarificationNode,
  createRunFocusedInventoryEnrichmentNode,
} from "./nodes/enrich-inventory.node";
import { requestClarificationNode } from "./nodes/request-clarification.node";
import { createRespondNode } from "./nodes/respond.node";
import { createRankRetrievedRecipesNode, createRetrieveRecipeCandidatesNode } from "./nodes/retrieve-recipes.node";
import { createGradeRecipeRetrievalNode } from "./nodes/grade-recipe-retrieval.node";
import { createRewriteRecipeQueryNode } from "./nodes/rewrite-recipe-query.node";
import { createEvaluateRecipeNode } from "./nodes/evaluate-recipe.node";
import { createResolveRecipeTournamentNode } from "./nodes/resolve-recipe-tournament.node";
import { createPlanGroceriesNode } from "./nodes/plan-groceries.node";
import { createPlanPantryCompletionNode } from "./nodes/plan-pantry-completion.node";
import { createPlanOrganizationNode } from "./nodes/plan-organization.node";
import { createPlanPlacementCorrectionNode } from "./nodes/plan-placement-correction.node";
import { validateMemoryCandidatesNode } from "./nodes/validate-memory-candidates.node";
import {
  routeIntent,
  routeAfterConcurrentResponse,
  routeAfterMemoryClassification,
  routeAfterInventoryEnrichment,
  routeMemoryLaneCompletion,
  routeRecipeRetrievalGrade,
  routeRecipeQueryRewrite,
  routeRecipeSearch,
  routeExpiryPlan,
  routeInventorySplitProposal,
  routeRecipeTournamentResult,
} from "./routing/query-routing";
import type {
  DietaryPreferenceMemory,
  DietaryRestrictionMemory,
  GoalMemory,
} from "../memory/schemas";
import type {
  QueryGraphDependencies,
  QueryGraphInput,
  ExpiryPlan,
  QueryResume,
  QueryIntent,
  RecipeCard,
  QueryVisualEvidence,
  QueryStreamEvent,
  GroceryPlan,
  PantryCompletionPlan,
} from "./schemas/query";
import {
  ExpiryPlanSchema,
  QueryIntentSchema,
  QueryStreamEventSchema,
  QueryVisualEvidenceSchema,
  RecipeRetrievalAuditSchema,
  RecipeCardSchema,
  QUERY_VISIBLE_RESPONSE_TAG,
} from "./schemas/query";
import { OrganizationPlanSchema, type OrganizationPlan } from "../organization/schemas";
import {
  groceryPlanErrorFromContext,
  groceryPlanFromContext,
  pantryCompletionClarificationFromContext,
  pantryCompletionErrorFromContext,
  pantryCompletionPlanFromContext,
} from "./services/grocery-planner.server";
import { FridgeQueryState, type FridgeQueryStateValue } from "./state";
import { DEFAULT_USER_ID } from "../sqlite.server";
import {
  WorkspaceActionSchema,
  type WorkspaceAction,
} from "../../workspace/contracts";
import type { RankedRecipe } from "./services/recipe-retrieval.server";
import {
  RECIPE_TOURNAMENT_DISPLAY_LIMIT,
  rankEvaluatedRecipeTournament,
  type RecipeTournamentEvaluation,
} from "./services/recipe-tournament.server";
import { z } from "zod";

// Caps how many parallel tasks (for example fanned-out evaluate_recipe Sends)
// run at once so a twenty-candidate tournament cannot burst twenty model calls.
const QUERY_GRAPH_MAX_CONCURRENCY = 5;
const GROCERY_PLAN_FAILURE_MESSAGE = "I couldn't finish the grocery plan. Please try again.";
const PANTRY_COMPLETION_FAILURE_MESSAGE = "I couldn't finish the pantry plan. Please try again.";

const queryGraphModelRetryPolicy: RetryPolicy = {
  maxAttempts: 4,
  initialInterval: 1000,
  backoffFactor: 2,
  jitter: false,
  logWarning: false,
};

function queryThreadId(input: QueryGraphInput) {
  return input.threadId ?? `query:${input.imageId ?? input.fridgeId}`;
}

export function normalizeQueryInput(input: QueryGraphInput) {
  const threadId = queryThreadId(input);

  return {
    ...input,
    userId: input.userId?.trim() || DEFAULT_USER_ID,
    threadId,
    requestId: input.requestId?.trim() ?? "",
    intent: null,
    recipeSearch: null,
    recipeClarification: null,
    recipeSearchError: null,
    recipeCandidates: [],
    recipeInputIngredients: [],
    answer: null,
    visualEvidence: [],
    recipeRewriteCount: 0,
    recipeRetrievalGrade: null,
    recipeRetrievalAudit: null,
    tournamentCandidates: [],
    tournamentCandidate: null,
    tournamentEvaluations: new Overwrite([]),
    memoryCandidates: [],
    memoryValidations: [],
    memoryWriteResults: [],
    pendingSemanticMemories: [],
    indexedSemanticMemoryIds: [],
    completedOperationKeys: [],
    externalInventory: [],
    dietaryRestrictions: [],
    dietaryPreferences: [],
    activeGoals: [],
    semanticMemories: [],
    context: {
      memoryExtractionCompleted: false,
      memoryExtractionError: null,
      memoryWriteResults: [],
      memoryWriteVerification: null,
      memoryWriteVerificationError: null,
      scannedInventoryMutations: [],
      recipeContinuationRequested: input.recipeContinuation === true,
      conversationContext: input.conversationContext ?? {
        selectedItemIds: [],
        selectedZoneIds: [],
        selectedRecipeId: null,
      },
      recentChatMessages: input.recentChatMessages ?? [],
      workspaceActions: [],
    },
  };
}

export function createQueryGraph(deps: QueryGraphDependencies = {}) {
  const graphCheckpointer = deps.checkpointer === undefined
    ? checkpointer
    : deps.checkpointer;

  return new StateGraph(FridgeQueryState)
    .addNode("load_context", createLoadFridgeContextNode(deps))
    .addNode("apply_seeded_inventory_assertions", createApplySeededInventoryAssertionsNode(deps), {
      retryPolicy: queryGraphModelRetryPolicy,
    })
    .addNode(
      "extract_memory_candidates",
      createExtractMemoryCandidatesNode(deps),
      {
        retryPolicy: queryGraphModelRetryPolicy,
      },
    )
    .addNode("filter_recipe_goal_candidates", filterRecipeGoalCandidates)
    .addNode("validate_memory_candidates", validateMemoryCandidatesNode)
    .addNode("apply_memory_writes", createApplyMemoryWritesNode(deps), {
      retryPolicy: queryGraphModelRetryPolicy,
    })
    .addNode("index_semantic_memory", createIndexSemanticMemoryNode(deps), {
      retryPolicy: queryGraphModelRetryPolicy,
    })
    .addNode("reload_memory_context", createReloadMemoryContextNode(deps))
    .addNode("await_memory_before_intent", async () => ({}))
    .addNode("intent_ready_for_memory", async () => ({}))
    .addNode("memory_candidates_ready", async () => ({}))
    .addNode("continue_after_memory_classification", async () => ({}))
    .addNode("memory_ready_for_intent", async () => ({}))
    .addNode("continue_after_memory", async () => ({}))
    .addNode("memory_lane_finished", async () => ({}))
    .addNode("response_lane_finished", async () => ({}))
    .addNode("determine_intent", createDetermineIntentNode(deps), {
      retryPolicy: queryGraphModelRetryPolicy,
    })
    .addNode("build_recipe_search", createBuildRecipeSearchNode(deps), {
      retryPolicy: queryGraphModelRetryPolicy,
    })
    .addNode("query_inventory", createQueryInventoryNode(deps))
    .addNode("propose_scoped_inventory_split", createProposeScopedInventorySplitNode(deps), {
      retryPolicy: queryGraphModelRetryPolicy,
    })
    .addNode("review_inventory_split", reviewScopedInventorySplitNode)
    .addNode("plan_expiry", createPlanExpiryNode(deps))
    .addNode("assess_inventory_enrichment", createAssessInventoryEnrichmentNode(deps))
    .addNode("run_focused_inventory_enrichment", createRunFocusedInventoryEnrichmentNode(deps), {
      retryPolicy: queryGraphModelRetryPolicy,
    })
    .addNode("request_inventory_clarification", createRequestInventoryClarificationNode(deps))
    .addNode("persist_inventory_enrichment", createPersistInventoryEnrichmentNode(deps))
    .addNode("retrieve_recipes", createRetrieveRecipeCandidatesNode(deps), {
      retryPolicy: queryGraphModelRetryPolicy,
    })
    .addNode("rank_retrieved_recipes", createRankRetrievedRecipesNode(deps))
    .addNode("grade_recipe_retrieval", createGradeRecipeRetrievalNode(deps), {
      retryPolicy: queryGraphModelRetryPolicy,
    })
    .addNode("rewrite_recipe_query", createRewriteRecipeQueryNode(deps), {
      retryPolicy: queryGraphModelRetryPolicy,
    })
    .addNode("evaluate_recipe", createEvaluateRecipeNode(deps), {
      retryPolicy: queryGraphModelRetryPolicy,
    })
    .addNode("resolve_recipe_tournament", createResolveRecipeTournamentNode(deps))
    .addNode("plan_groceries", createPlanGroceriesNode(deps), {
      retryPolicy: queryGraphModelRetryPolicy,
    })
    .addNode("plan_pantry_completion", createPlanPantryCompletionNode(deps), {
      retryPolicy: queryGraphModelRetryPolicy,
    })
    .addNode("plan_organization", createPlanOrganizationNode(deps), {
      retryPolicy: queryGraphModelRetryPolicy,
    })
    .addNode("plan_placement_correction", createPlanPlacementCorrectionNode(deps))
    .addNode("calculate_space", createCalculateSpaceNode(deps))
    .addNode("request_clarification", requestClarificationNode)
    .addNode("plan_workspace_actions", createPlanWorkspaceActionsNode(deps), {
      retryPolicy: queryGraphModelRetryPolicy,
    })
    .addNode("respond", createRespondNode(deps), {
      retryPolicy: queryGraphModelRetryPolicy,
    })
    .addEdge(START, "load_context")
    .addEdge("load_context", "apply_seeded_inventory_assertions")
    .addEdge("apply_seeded_inventory_assertions", "extract_memory_candidates")
    .addEdge("apply_seeded_inventory_assertions", "determine_intent")
    .addEdge("extract_memory_candidates", "memory_candidates_ready")
    .addEdge("determine_intent", "intent_ready_for_memory")
    .addEdge(["intent_ready_for_memory", "memory_candidates_ready"], "continue_after_memory_classification")
    .addConditionalEdges("continue_after_memory_classification", routeAfterMemoryClassification, {
      inventory: "query_inventory",
      expiry: "query_inventory",
      food_knowledge: "respond",
      recipe: "query_inventory",
      shopping: "query_inventory",
      space: "calculate_space",
      organization: "query_inventory",
      placement_correction: "query_inventory",
      general_chat: "respond",
      clarification: "request_clarification",
      await_memory_before_intent: "await_memory_before_intent",
    })
    .addEdge("continue_after_memory_classification", "filter_recipe_goal_candidates")
    .addEdge("filter_recipe_goal_candidates", "validate_memory_candidates")
    .addEdge("validate_memory_candidates", "apply_memory_writes")
    .addEdge("apply_memory_writes", "index_semantic_memory")
    .addEdge("index_semantic_memory", "reload_memory_context")
    .addConditionalEdges("reload_memory_context", routeMemoryLaneCompletion, {
      memory_ready_for_intent: "memory_ready_for_intent",
      memory_lane_finished: "memory_lane_finished",
    })
    .addEdge(["await_memory_before_intent", "memory_ready_for_intent"], "continue_after_memory")
    .addConditionalEdges("continue_after_memory", routeIntent, {
      inventory: "query_inventory",
      expiry: "query_inventory",
      food_knowledge: "respond",
      recipe: "query_inventory",
      shopping: "query_inventory",
      space: "calculate_space",
      organization: "query_inventory",
      placement_correction: "query_inventory",
      general_chat: "respond",
      clarification: "request_clarification",
    })
    .addConditionalEdges("query_inventory", routeInventorySplitProposal, {
      propose_scoped_inventory_split: "propose_scoped_inventory_split",
      assess_inventory_enrichment: "assess_inventory_enrichment",
    })
    .addEdge("propose_scoped_inventory_split", "assess_inventory_enrichment")
    .addConditionalEdges("assess_inventory_enrichment", routeAfterInventoryEnrichment, {
      focused_vlm: "run_focused_inventory_enrichment",
      ask_user: "request_inventory_clarification",
      respond: "respond",
      build_recipe_search: "build_recipe_search",
      plan_expiry: "plan_expiry",
      plan_organization: "plan_organization",
      plan_placement_correction: "plan_placement_correction",
    })
    .addEdge("run_focused_inventory_enrichment", "persist_inventory_enrichment")
    .addEdge("request_inventory_clarification", "persist_inventory_enrichment")
    .addEdge("persist_inventory_enrichment", "assess_inventory_enrichment")
    .addConditionalEdges("plan_expiry", routeExpiryPlan, {
      build_recipe_search: "build_recipe_search",
      respond: "respond",
    })
    .addConditionalEdges("build_recipe_search", routeRecipeSearch, {
      retrieve_recipes: "retrieve_recipes",
      clarification: "request_clarification",
    })
    .addEdge("retrieve_recipes", "rank_retrieved_recipes")
    .addEdge("rank_retrieved_recipes", "grade_recipe_retrieval")
    .addConditionalEdges("grade_recipe_retrieval", routeRecipeRetrievalGrade, {
      rewrite_recipe_query: "rewrite_recipe_query",
      respond: "respond",
      plan_groceries: "plan_groceries",
      plan_pantry_completion: "plan_pantry_completion",
      evaluate_recipe: "evaluate_recipe",
    })
    .addConditionalEdges("rewrite_recipe_query", routeRecipeQueryRewrite, {
      retrieve_recipes: "retrieve_recipes",
      respond: "respond",
      plan_groceries: "plan_groceries",
      plan_pantry_completion: "plan_pantry_completion",
    })
    .addEdge("evaluate_recipe", "resolve_recipe_tournament")
    .addConditionalEdges("resolve_recipe_tournament", routeRecipeTournamentResult, {
      respond: "respond",
      plan_groceries: "plan_groceries",
      plan_pantry_completion: "plan_pantry_completion",
    })
    .addEdge("plan_groceries", "respond")
    .addEdge("plan_pantry_completion", "respond")
    .addEdge("plan_organization", "respond")
    .addEdge("plan_placement_correction", "respond")
    .addEdge("calculate_space", "respond")
    .addEdge("request_clarification", END)
    .addConditionalEdges("respond", routeAfterConcurrentResponse, {
      plan_workspace_actions: "plan_workspace_actions",
      response_lane_finished: "response_lane_finished",
    })
    .addEdge(["response_lane_finished", "memory_lane_finished"], "plan_workspace_actions")
    .addConditionalEdges("plan_workspace_actions", routeScopedInventorySplitReview, {
      review: "review_inventory_split",
      end: END,
    })
    .addEdge("review_inventory_split", END)
    .compile(graphCheckpointer ? { checkpointer: graphCheckpointer } : undefined);
}

function graphInterrupts(result: unknown): Array<Record<string, unknown>> {
  if (!isRecord(result) || !Array.isArray(result.__interrupt__)) {
    return [];
  }

  return result.__interrupt__.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    return isRecord(entry.value) ? [entry.value] : [entry];
  });
}

function memoryWriteVerificationErrorFromContext(context: Record<string, unknown>) {
  return typeof context.memoryWriteVerificationError === "string"
    ? context.memoryWriteVerificationError
    : null;
}

export async function runQueryForFridgeImage(
  input: QueryGraphInput,
  deps: QueryGraphDependencies = {},
) {
  const promptBundle = deps.promptBundle ?? await loadPromptBundle();
  const graph = createQueryGraph({ ...deps, promptBundle });
  const normalizedInput = normalizeQueryInput(input);
  const result = await graph.invoke(normalizedInput, streamConfig(normalizedInput));
  const interrupts = graphInterrupts(result);

  if (interrupts.length > 0) {
    return {
      status: "interrupted" as const,
      threadId: normalizedInput.threadId,
      interrupts,
      answer: null,
      intent: result.intent,
      visualEvidence: [],
      workspaceActions: [],
      groceryPlan: null,
      groceryPlanError: null,
      pantryCompletionPlan: null,
      pantryCompletionError: null,
      pantryCompletionClarification: null,
      memoryWriteVerificationError: memoryWriteVerificationErrorFromContext(result.context),
    };
  }

  if (!result.answer) {
    throw new Error("Query graph completed without an answer");
  }

  return {
    status: "completed" as const,
    threadId: normalizedInput.threadId,
    interrupts: [] as Array<Record<string, unknown>>,
    answer: result.answer,
    intent: result.intent,
    visualEvidence: result.visualEvidence,
    workspaceActions: workspaceActionsFromContext(result.context),
    groceryPlan: groceryPlanFromContext(result.context),
    groceryPlanError: groceryPlanErrorFromContext(result.context) ? GROCERY_PLAN_FAILURE_MESSAGE : null,
    pantryCompletionPlan: pantryCompletionPlanFromContext(result.context),
    pantryCompletionError: pantryCompletionErrorFromContext(result.context) ? PANTRY_COMPLETION_FAILURE_MESSAGE : null,
    pantryCompletionClarification: pantryCompletionClarificationFromContext(result.context),
    memoryWriteVerificationError: memoryWriteVerificationErrorFromContext(result.context),
  };
}

let cachedQueryGraphRevision: string | null = null;

function queryGraphRevision() {
  if (cachedQueryGraphRevision === null) {
    cachedQueryGraphRevision = graphRevisionFor(createQueryGraph({ checkpointer: null }));
  }
  return cachedQueryGraphRevision;
}

function streamConfig(normalizedInput: ReturnType<typeof normalizeQueryInput>) {
  const langsmith = getLangSmithConfig();
  const trace = buildQueryTraceOptions({
    threadId: normalizedInput.threadId,
    requestId: normalizedInput.requestId,
    userId: normalizedInput.userId,
    fridgeId: normalizedInput.fridgeId,
    imageId: normalizedInput.imageId,
    environment: resolveTraceEnvironment(),
    mode: "live",
    model: CHAT_MODEL,
    promptRefs: {},
    graphRevision: queryGraphRevision(),
  });

  return {
    runName: trace.runName,
    tags: trace.tags,
    maxConcurrency: QUERY_GRAPH_MAX_CONCURRENCY,
    metadata: {
      ...trace.metadata,
      ...(langsmith ? { langsmithProject: langsmith.project } : {}),
    },
    configurable: {
      thread_id: normalizedInput.threadId,
    },
  };
}

// [active, done] status messages per node, keyed by graph node name.
const NODE_STATUS_MESSAGES: Record<string, [active: string, done: string]> = {
  load_context: ["Loading query context.", "Loaded query context."],
  apply_seeded_inventory_assertions: ["Checking selected inventory assertions.", "Checked selected inventory assertions."],
  extract_memory_candidates: ["Checking for durable memory updates.", "Checked for durable memory updates."],
  validate_memory_candidates: ["Validating memory updates.", "Validated memory updates."],
  apply_memory_writes: ["Checking durable memory writes.", "Checked durable memory writes."],
  index_semantic_memory: ["Checking semantic memory indexing.", "Checked semantic memory indexing."],
  reload_memory_context: ["Reloading durable memory context.", "Checked durable memory context."],
  await_memory_before_intent: ["Waiting for your profile update.", "Profile update is ready."],
  memory_ready_for_intent: ["Preparing verified profile context.", "Prepared verified profile context."],
  continue_after_memory: ["Applying profile context.", "Applied profile context."],
  memory_lane_finished: ["Finishing profile update.", "Finished profile update."],
  response_lane_finished: ["Finishing response.", "Finished response."],
  determine_intent: ["Understanding the request.", "Understood the request."],
  query_inventory: ["Preparing inventory lookup.", "Prepared inventory lookup."],
  propose_scoped_inventory_split: ["Checking the selected area for separate inventory items.", "Checked the selected area for separate inventory items."],
  review_inventory_split: ["Preparing the inventory split for review.", "Prepared the inventory split for review."],
  plan_expiry: ["Assessing freshness and food-waste priorities.", "Assessed freshness and food-waste priorities."],
  assess_inventory_enrichment: ["Checking whether more inventory detail is needed.", "Checked whether more inventory detail is needed."],
  run_focused_inventory_enrichment: ["Inspecting relevant inventory details.", "Inspected relevant inventory details."],
  request_inventory_clarification: ["Requesting inventory clarification.", "Requested inventory clarification."],
  persist_inventory_enrichment: ["Saving inventory enrichment.", "Saved inventory enrichment."],
  build_recipe_search: ["Building the local recipe search.", "Built the local recipe search."],
  retrieve_recipes: ["Retrieving local recipe options.", "Retrieved local recipe options."],
  rank_retrieved_recipes: ["Ranking local recipe options.", "Ranked local recipe options."],
  grade_recipe_retrieval: ["Checking recipe retrieval relevance.", "Checked recipe retrieval relevance."],
  rewrite_recipe_query: ["Refining the recipe search.", "Refined the recipe search."],
  evaluate_recipe: ["Scoring recipe tournament candidates.", "Scored a recipe tournament candidate."],
  resolve_recipe_tournament: ["Ranking recipe suggestions.", "Ranked recipe suggestions."],
  plan_groceries: ["Building the grocery plan.", "Built the grocery plan."],
  plan_pantry_completion: ["Building the smart pantry completion plan.", "Built the smart pantry completion plan."],
  plan_organization: ["Preparing the kitchen organization plan.", "Prepared the kitchen organization plan."],
  plan_placement_correction: ["Preparing the inventory correction.", "Prepared the inventory correction."],
  calculate_space: ["Calculating fridge space.", "Calculated fridge space."],
  request_clarification: ["Preparing a clarification.", "Prepared a clarification."],
  plan_workspace_actions: ["Preparing visual workspace updates.", "Prepared visual workspace updates."],
  respond: ["Drafting the answer.", "Drafting the answer."],
};

function nodeStatusMessage(node: string) {
  return NODE_STATUS_MESSAGES[node]?.[1] ?? `Finished ${node}.`;
}

function memoryWriteResultsFromUpdate(update: Record<string, unknown>) {
  return Array.isArray(update.memoryWriteResults)
    ? update.memoryWriteResults.filter((entry): entry is { kind: string; action: string; status: string; message?: string } =>
      isRecord(entry) &&
      typeof entry.kind === "string" &&
      typeof entry.action === "string" &&
      typeof entry.status === "string"
    )
    : [];
}

function memoryVerificationFromContext(context: Record<string, unknown>) {
  return isRecord(context.memoryWriteVerification) ? context.memoryWriteVerification : null;
}

function memoryUpdateFromReload(input: {
  update: Record<string, unknown>;
  context: Record<string, unknown>;
}) {
  const verification = memoryVerificationFromContext(input.context);

  if (
    !verification ||
    (verification.status !== "verified" && verification.status !== "failed") ||
    typeof verification.message !== "string"
  ) {
    return null;
  }
  const status = verification.status as "verified" | "failed";

  const changedKinds = [...new Set(memoryWriteResultsFromUpdate(input.update)
    .map((write) => write.kind)
    .filter((kind): kind is "inventory_item" | "dietary_restriction" | "preference" | "goal" | "misc" =>
      kind === "inventory_item" ||
      kind === "dietary_restriction" ||
      kind === "preference" ||
      kind === "goal" ||
      kind === "misc"
    ))];

  return {
    type: "memory_update" as const,
    status,
    message: status === "verified"
      ? "Profile update saved."
      : "I couldn't save that update. Please try again.",
    changedKinds,
    dietaryRestrictions: Array.isArray(input.update.dietaryRestrictions)
      ? input.update.dietaryRestrictions as DietaryRestrictionMemory[]
      : [],
    dietaryPreferences: Array.isArray(input.update.dietaryPreferences)
      ? input.update.dietaryPreferences as DietaryPreferenceMemory[]
      : [],
    activeGoals: Array.isArray(input.update.activeGoals)
      ? input.update.activeGoals as GoalMemory[]
      : [],
  };
}

function nodeStatusMessageForUpdate(
  node: string,
  update: Record<string, unknown>,
  context: Record<string, unknown>,
) {
  if (node === "apply_memory_writes") {
    const writes = memoryWriteResultsFromUpdate(update);
    const persistedCount = writes.filter((write) => write.status === "persisted").length;

    if (writes.length === 0) {
      return "No durable memory writes were attempted.";
    }

    if (persistedCount === 0) {
      return "Couldn't save the update.";
    }

    return `Persisted ${persistedCount} durable memory update${persistedCount === 1 ? "" : "s"}; awaiting reload verification.`;
  }

  if (node === "index_semantic_memory") {
    const indexed = Array.isArray(update.indexedSemanticMemoryIds)
      ? update.indexedSemanticMemoryIds.length
      : 0;

    return indexed > 0
      ? `Indexed ${indexed} semantic memory update${indexed === 1 ? "" : "s"}.`
      : "No semantic memory updates required indexing.";
  }

  if (node === "reload_memory_context") {
    const verification = memoryVerificationFromContext(context);

    if (verification && verification.status === "verified" && typeof verification.verifiedCount === "number") {
      return `Verified ${verification.verifiedCount} durable memory update${verification.verifiedCount === 1 ? "" : "s"} in the profile.`;
    }

    if (verification && verification.status === "failed" && typeof verification.message === "string") {
      return "Couldn't confirm the profile update.";
    }

    if (verification && verification.status === "not_applicable" && typeof verification.message === "string") {
      return verification.message;
    }

    return nodeStatusMessage(node);
  }

  return nodeStatusMessage(node);
}

function nodeActiveStatusMessage(node: string) {
  return NODE_STATUS_MESSAGES[node]?.[0] ?? `Running ${node}.`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isQueryIntent(value: unknown): value is QueryIntent {
  return QueryIntentSchema.safeParse(value).success;
}

function extractStreamText(messageChunk: unknown) {
  if (!isRecord(messageChunk)) {
    return "";
  }

  const content = messageChunk.content;

  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }

        if (isRecord(part) && typeof part.text === "string") {
          return part.text;
        }

        return "";
      })
      .join("");
  }

  const contentBlocks = messageChunk.contentBlocks;

  if (Array.isArray(contentBlocks)) {
    return contentBlocks
      .map((part) => {
        if (!isRecord(part)) {
          return "";
        }

        if (typeof part.text === "string") {
          return part.text;
        }

        if (typeof part.text_delta === "string") {
          return part.text_delta;
        }

        return "";
      })
      .join("");
  }

  return "";
}

export function isVisibleResponseMessageMetadata(metadata: unknown) {
  if (!isRecord(metadata)) {
    return false;
  }

  const tags = metadata.tags;

  return Array.isArray(tags) && tags.includes(QUERY_VISIBLE_RESPONSE_TAG);
}

function isQueryStreamEvent(value: unknown): value is QueryStreamEvent {
  return QueryStreamEventSchema.safeParse(value).success;
}

function isQueryVisualEvidence(value: unknown): value is QueryVisualEvidence[] {
  return z.array(QueryVisualEvidenceSchema).safeParse(value).success;
}

function workspaceActionsFromContext(context: Record<string, unknown>): WorkspaceAction[] {
  const parsed = z.array(WorkspaceActionSchema).safeParse(context.workspaceActions);
  return parsed.success ? parsed.data : [];
}

function updateEntries(chunk: unknown): Array<[string, Record<string, unknown>]> {
  if (!isRecord(chunk)) {
    return [];
  }

  return Object.entries(chunk).filter(
    (entry): entry is [string, Record<string, unknown>] => isRecord(entry[1]),
  );
}

function recipeCardFromRecord(recipe: Record<string, unknown>): RecipeCard | null {
  const parsed = RecipeCardSchema.safeParse(recipe);
  return parsed.success ? parsed.data : null;
}

function recipeCardFromRankedRecipe(recipe: RankedRecipe): RecipeCard {
  return {
    id: recipe.id,
    name: recipe.name,
    description: recipe.description,
    minutes: recipe.minutes,
    matchedIngredients: recipe.matchedIngredients,
    missingIngredients: recipe.missingIngredients,
    matchedTags: recipe.matchedTags,
    matchBadges: recipe.matchBadges,
    usesSoonIngredients: recipe.usesSoonIngredients,
  };
}

function recipeCardsFromContext(context: Record<string, unknown>): RecipeCard[] {
  if (!isRecord(context.recipeRetrieval)) {
    return [];
  }

  const recipes = context.recipeRetrieval.recipes;

  if (!Array.isArray(recipes)) {
    return [];
  }

  return recipes.flatMap((recipe) => {
    if (!isRecord(recipe)) {
      return [];
    }

    const card = recipeCardFromRecord(recipe);

    return card ? [card] : [];
  });
}

function expiryPlanFromContext(context: Record<string, unknown>): ExpiryPlan | null {
  const parsed = ExpiryPlanSchema.safeParse(context.expiryPlan);
  return parsed.success ? parsed.data : null;
}

function organizationPlanFromContext(context: Record<string, unknown>): OrganizationPlan | null {
  const parsed = OrganizationPlanSchema.safeParse(context.organizationPlan);
  return parsed.success ? parsed.data : null;
}

function scannedInventoryMutationInventories(context: Record<string, unknown>) {
  if (!Array.isArray(context.scannedInventoryMutations)) {
    return [];
  }

  return context.scannedInventoryMutations.flatMap((mutation) => {
    if (
      !isRecord(mutation) ||
      mutation.status !== "updated" ||
      !isRecord(mutation.inventory)
    ) {
      return [];
    }

    return [mutation.inventory];
  });
}

function rankedRecipesFromUpdate(value: unknown): RankedRecipe[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((recipe): recipe is RankedRecipe =>
    isRecord(recipe) && recipeCardFromRecord(recipe) !== null
  );
}

function isRecipeTournamentScores(value: unknown): value is RecipeTournamentEvaluation["scores"] {
  return isRecord(value) &&
    typeof value.nutrition === "number" &&
    Number.isFinite(value.nutrition) &&
    typeof value.ingredientCoverage === "number" &&
    Number.isFinite(value.ingredientCoverage) &&
    typeof value.difficulty === "number" &&
    Number.isFinite(value.difficulty) &&
    typeof value.wasteReduction === "number" &&
    Number.isFinite(value.wasteReduction) &&
    typeof value.preferenceMatch === "number" &&
    Number.isFinite(value.preferenceMatch);
}

function tournamentEvaluationsFromUpdate(value: unknown): RecipeTournamentEvaluation[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((evaluation): evaluation is RecipeTournamentEvaluation =>
    isRecord(evaluation) &&
    typeof evaluation.recipeId === "string" &&
    (evaluation.error === null || typeof evaluation.error === "string") &&
    (evaluation.scores === null || isRecipeTournamentScores(evaluation.scores))
  );
}

export async function* streamQueryForFridgeImage(
  input: QueryGraphInput,
  deps: QueryGraphDependencies = {},
  resume?: QueryResume,
  continueExecution = false,
): AsyncGenerator<QueryStreamEvent> {
  const promptBundle = deps.promptBundle ?? await loadPromptBundle();
  const graph = createQueryGraph({ ...deps, promptBundle });
  const normalizedInput = normalizeQueryInput(input);
  const config = streamConfig(normalizedInput);
  let finalAnswer = "";
  let finalIntent: QueryIntent | null = null;
  let finalRecipeCards: RecipeCard[] = [];
  let finalVisualEvidence: QueryVisualEvidence[] = [];
  let finalWorkspaceActions: WorkspaceAction[] = [];
  let finalExpiryPlan: ExpiryPlan | undefined;
  let finalGroceryPlan: GroceryPlan | undefined;
  let finalGroceryPlanError: string | undefined;
  let finalPantryCompletionPlan: PantryCompletionPlan | undefined;
  let finalPantryCompletionError: string | undefined;
  let finalPantryCompletionClarification: string | undefined;
  let finalOrganizationPlan: OrganizationPlan | undefined;
  let finalDietaryRestrictions: DietaryRestrictionMemory[] = [];
  let finalDietaryPreferences: DietaryPreferenceMemory[] = [];
  let finalActiveGoals: GoalMemory[] = [];
  let finalRecipeRetrievalAudit: z.infer<typeof RecipeRetrievalAuditSchema> | undefined;
  let tournamentCandidates: RankedRecipe[] = [];
  let tournamentEvaluations: RecipeTournamentEvaluation[] = [];
  let displayedTournamentRecipeIds: string[] = [];
  let groceryPlannerRequested = false;
  let pantryCompletionRequested = false;
  let groceryPlanEmitted = false;
  let groceryPlanErrorEmitted = false;
  let pantryCompletionPlanEmitted = false;
  let pantryCompletionErrorEmitted = false;
  let pantryCompletionClarificationEmitted = false;

  yield {
    type: "status",
    node: "load_context",
    message: nodeActiveStatusMessage("load_context"),
  };

  const stream = await graph.stream(
    continueExecution ? null : resume ? new Command({ resume }) : normalizedInput,
    {
    ...config,
    streamMode: ["updates", "messages", "custom"],
    },
  );
  let interrupted = false;

  for await (const streamResult of readGeminiStream(stream, "Query graph stream")) {
    if (streamResult.type === "gemini_stream_parse_error") {
      yield {
        type: "error",
        error: "I couldn't complete that request. Please try again.",
      };
      return;
    }

    const streamedChunk = streamResult.chunk;

    if (!Array.isArray(streamedChunk) || streamedChunk.length !== 2) {
      continue;
    }

    const [mode, chunk] = streamedChunk as [string, unknown];

    if (mode === "updates") {
      if (isRecord(chunk) && Array.isArray(chunk.__interrupt__)) {
        for (const entry of chunk.__interrupt__) {
          if (!isRecord(entry) || !isRecord(entry.value)) continue;
          if (entry.value.type === "inventory_clarification" && Array.isArray(entry.value.questions)) {
            const questions = entry.value.questions.filter((question): question is { itemId: string; field: "identity" | "quantity" | "fill_level" | "expiration_date" | "opened"; question: string } =>
              isRecord(question) &&
              typeof question.itemId === "string" &&
              (question.field === "identity" || question.field === "quantity" || question.field === "fill_level" || question.field === "expiration_date" || question.field === "opened") &&
              typeof question.question === "string"
            );
            if (questions.length > 0) {
              interrupted = true;
              yield { type: "clarification", questions };
            }
          }
          if (
            entry.value.type === "inventory_split_review" &&
            typeof entry.value.scopeLabel === "string" &&
            typeof entry.value.summary === "string" &&
            Array.isArray(entry.value.items) &&
            entry.value.items.every((item) => isRecord(item) && typeof item.label === "string" && typeof item.name === "string")
          ) {
            interrupted = true;
            yield {
              type: "inventory_split_review",
              scopeLabel: entry.value.scopeLabel,
              summary: entry.value.summary,
              items: entry.value.items as Array<{ label: string; name: string }>,
            };
          }
          if (
            entry.value.type === "inventory_mutation_review" &&
            (entry.value.operation === "consume" || entry.value.operation === "remove") &&
            typeof entry.value.itemName === "string" &&
            typeof entry.value.storageLocation === "string"
          ) {
            interrupted = true;
            yield {
              type: "inventory_mutation_review",
              operation: entry.value.operation,
              itemName: entry.value.itemName,
              storageLocation: entry.value.storageLocation,
            };
          }
        }
      }
      for (const [node, update] of updateEntries(chunk)) {
        const context = isRecord(update.context) ? update.context : {};

        yield {
          type: "status",
          node,
          message: nodeStatusMessageForUpdate(node, update, context),
        };

        if (typeof update.answer === "string") {
          finalAnswer = update.answer;
        }

        if (isQueryIntent(update.intent)) {
          finalIntent = update.intent;
        }

        if (Array.isArray(update.dietaryRestrictions)) {
          finalDietaryRestrictions = update.dietaryRestrictions as DietaryRestrictionMemory[];
        }

        if (Array.isArray(update.dietaryPreferences)) {
          finalDietaryPreferences = update.dietaryPreferences as DietaryPreferenceMemory[];
        }

        if (Array.isArray(update.activeGoals)) {
          finalActiveGoals = update.activeGoals as GoalMemory[];
        }

        const recipeRetrievalAudit = RecipeRetrievalAuditSchema.safeParse(update.recipeRetrievalAudit);
        if (recipeRetrievalAudit.success) {
          finalRecipeRetrievalAudit = recipeRetrievalAudit.data;
        }

        if (isRecord(context.intentRouting)) {
          groceryPlannerRequested = context.intentRouting.shoppingMode === "grocery_planner";
          pantryCompletionRequested = context.intentRouting.shoppingMode === "pantry_completion";
        }

        if (isQueryVisualEvidence(update.visualEvidence)) {
          finalVisualEvidence = update.visualEvidence;
        }

        if (node === "apply_memory_writes") {
          for (const inventory of scannedInventoryMutationInventories(context)) {
            yield { type: "inventory_updated", inventory };
          }
        }

        if (node === "reload_memory_context") {
          const memoryUpdate = memoryUpdateFromReload({ update, context });
          if (memoryUpdate) {
            yield memoryUpdate;
          }
        }

        const workspaceActions = workspaceActionsFromContext(context);
        if (workspaceActions.length > 0) {
          finalWorkspaceActions = workspaceActions;
          for (const action of workspaceActions) {
            yield { type: "workspace_action", action };
          }
        }

        const expiryPlan = expiryPlanFromContext(context);
        if (expiryPlan) {
          finalExpiryPlan = expiryPlan;
          yield { type: "expiry_plan", plan: expiryPlan };
        }

        const groceryPlan = groceryPlanFromContext(context);
        if (groceryPlan) {
          finalGroceryPlan = groceryPlan;
          finalGroceryPlanError = undefined;
          if (!groceryPlanEmitted) {
            groceryPlanEmitted = true;
            yield { type: "grocery_plan", plan: groceryPlan };
          }
        }

        const groceryPlanError = groceryPlanErrorFromContext(context);
        if (groceryPlanError) {
          finalGroceryPlanError = GROCERY_PLAN_FAILURE_MESSAGE;
          if (!groceryPlanErrorEmitted) {
            groceryPlanErrorEmitted = true;
            yield { type: "grocery_plan_error", error: GROCERY_PLAN_FAILURE_MESSAGE };
          }
        }

        const pantryCompletionPlan = pantryCompletionPlanFromContext(context);
        if (pantryCompletionPlan) {
          finalPantryCompletionPlan = pantryCompletionPlan;
          finalPantryCompletionError = undefined;
          finalPantryCompletionClarification = undefined;
          if (!pantryCompletionPlanEmitted) {
            pantryCompletionPlanEmitted = true;
            yield { type: "pantry_completion", plan: pantryCompletionPlan };
          }
        }

        const pantryCompletionError = pantryCompletionErrorFromContext(context);
        if (pantryCompletionError) {
          finalPantryCompletionError = PANTRY_COMPLETION_FAILURE_MESSAGE;
          if (!pantryCompletionErrorEmitted) {
            pantryCompletionErrorEmitted = true;
            yield { type: "pantry_completion_error", error: PANTRY_COMPLETION_FAILURE_MESSAGE };
          }
        }

        const pantryCompletionClarification = pantryCompletionClarificationFromContext(context);
        if (pantryCompletionClarification) {
          finalPantryCompletionPlan = undefined;
          finalPantryCompletionError = undefined;
          finalPantryCompletionClarification = pantryCompletionClarification;
          if (!pantryCompletionClarificationEmitted) {
            pantryCompletionClarificationEmitted = true;
            yield { type: "pantry_completion_clarification", message: pantryCompletionClarification };
          }
        }

        const organizationPlan = organizationPlanFromContext(context);
        if (organizationPlan) {
          finalOrganizationPlan = organizationPlan;
          yield { type: "organization_plan", plan: organizationPlan };
        }

        const recipeCards = recipeCardsFromContext(context);

        if (recipeCards.length > 0) {
          finalRecipeCards = recipeCards;
        }

        if (node === "rank_retrieved_recipes" && !groceryPlannerRequested && !pantryCompletionRequested) {
          tournamentCandidates = rankedRecipesFromUpdate(update.tournamentCandidates);
          tournamentEvaluations = [];
          displayedTournamentRecipeIds = [];

          if (tournamentCandidates.length > 0) {
            yield {
              type: "recipe_tournament_started",
              candidateCount: tournamentCandidates.length,
              displaySlotCount: Math.min(RECIPE_TOURNAMENT_DISPLAY_LIMIT, tournamentCandidates.length),
            };
          }
        }

        if (node === "evaluate_recipe" && tournamentCandidates.length > 0 && !groceryPlannerRequested && !pantryCompletionRequested) {
          const nextEvaluations = tournamentEvaluationsFromUpdate(update.tournamentEvaluations);
          const evaluationsByRecipeId = new Map<string, RecipeTournamentEvaluation>();

          for (const evaluation of [...tournamentEvaluations, ...nextEvaluations]) {
            evaluationsByRecipeId.set(evaluation.recipeId, evaluation);
          }

          tournamentEvaluations = [...evaluationsByRecipeId.values()];

          const ranked = rankEvaluatedRecipeTournament(
            tournamentCandidates,
            tournamentEvaluations,
            Math.min(RECIPE_TOURNAMENT_DISPLAY_LIMIT, tournamentCandidates.length),
          );
          const recipes = ranked.map(recipeCardFromRankedRecipe);
          const nextDisplayedIds = recipes.map((recipe) => recipe.id);
          const droppedRecipeIds = displayedTournamentRecipeIds.filter((recipeId) =>
            !nextDisplayedIds.includes(recipeId)
          );

          displayedTournamentRecipeIds = nextDisplayedIds;

          yield {
            type: "recipe_tournament_update",
            recipes,
            evaluatedCount: tournamentEvaluations.length,
            totalCount: tournamentCandidates.length,
            droppedRecipeIds,
          };
        }

        if (node === "resolve_recipe_tournament" && recipeCards.length > 0 && !groceryPlannerRequested && !pantryCompletionRequested) {
          displayedTournamentRecipeIds = recipeCards.map((recipe) => recipe.id);
          yield {
            type: "recipe_tournament_finished",
            recipes: recipeCards,
          };
        }
      }
      continue;
    }

    if (mode === "messages" && Array.isArray(chunk) && chunk.length >= 2) {
      const [messageChunk, metadata] = chunk;

      if (!isVisibleResponseMessageMetadata(metadata)) {
        continue;
      }

      const text = extractStreamText(messageChunk);

      if (text.length > 0) {
        yield {
          type: "token",
          text,
        };
      }
      continue;
    }

    if (mode === "custom" && isQueryStreamEvent(chunk)) {
      yield chunk;
    }
  }

  if (interrupted) {
    if (finalAnswer) {
      yield {
        type: "final",
        answer: finalAnswer,
        intent: finalIntent,
        recipes: finalRecipeCards,
        groceryPlan: finalGroceryPlan,
        groceryPlanError: finalGroceryPlanError,
        pantryCompletionPlan: finalPantryCompletionPlan,
        pantryCompletionError: finalPantryCompletionError,
        pantryCompletionClarification: finalPantryCompletionClarification,
        organizationPlan: finalOrganizationPlan,
        visualEvidence: finalVisualEvidence,
        dietaryRestrictions: finalDietaryRestrictions,
        dietaryPreferences: finalDietaryPreferences,
        activeGoals: finalActiveGoals,
        workspaceActions: finalWorkspaceActions,
        agentEvents: [],
        retrievalAudit: finalRecipeRetrievalAudit,
      };
    }
    return;
  }

  if (!finalAnswer) {
    throw new Error("Query graph completed without an answer");
  }

  yield {
    type: "final",
    answer: finalAnswer,
    intent: finalIntent,
    recipes: finalRecipeCards,
    expiryPlan: finalExpiryPlan,
    groceryPlan: finalGroceryPlan,
    groceryPlanError: finalGroceryPlanError,
    pantryCompletionPlan: finalPantryCompletionPlan,
    pantryCompletionError: finalPantryCompletionError,
    pantryCompletionClarification: finalPantryCompletionClarification,
    organizationPlan: finalOrganizationPlan,
    visualEvidence: finalVisualEvidence,
    dietaryRestrictions: finalDietaryRestrictions,
    dietaryPreferences: finalDietaryPreferences,
    activeGoals: finalActiveGoals,
    workspaceActions: finalWorkspaceActions,
    agentEvents: [],
    retrievalAudit: finalRecipeRetrievalAudit,
  };
}

export async function* continueQueryForFridgeThread(
  input: { threadId: string },
  deps: QueryGraphDependencies = {},
): AsyncGenerator<QueryStreamEvent> {
  const promptBundle = deps.promptBundle ?? await loadPromptBundle();
  const graph = createQueryGraph({ ...deps, promptBundle });
  const state = await graph.getState({ configurable: { thread_id: input.threadId } });
  const values = state.values as Partial<FridgeQueryStateValue>;

  if (state.next.length === 0) {
    if (typeof values.answer !== "string" || values.answer.length === 0) {
      throw new Error(`Query thread ${input.threadId} has no pending execution to continue`);
    }

    const context = isRecord(values.context) ? values.context : {};
    yield {
      type: "final",
      answer: values.answer,
      intent: isQueryIntent(values.intent) ? values.intent : null,
      recipes: recipeCardsFromContext(context),
      expiryPlan: expiryPlanFromContext(context) ?? undefined,
      groceryPlan: groceryPlanFromContext(context) ?? undefined,
      groceryPlanError: groceryPlanErrorFromContext(context) ? GROCERY_PLAN_FAILURE_MESSAGE : undefined,
      pantryCompletionPlan: pantryCompletionPlanFromContext(context) ?? undefined,
      pantryCompletionError: pantryCompletionErrorFromContext(context) ? PANTRY_COMPLETION_FAILURE_MESSAGE : undefined,
      pantryCompletionClarification: pantryCompletionClarificationFromContext(context) ?? undefined,
      organizationPlan: organizationPlanFromContext(context) ?? undefined,
      visualEvidence: isQueryVisualEvidence(values.visualEvidence) ? values.visualEvidence : [],
      dietaryRestrictions: Array.isArray(values.dietaryRestrictions) ? values.dietaryRestrictions : [],
      dietaryPreferences: Array.isArray(values.dietaryPreferences) ? values.dietaryPreferences : [],
      activeGoals: Array.isArray(values.activeGoals) ? values.activeGoals : [],
      workspaceActions: workspaceActionsFromContext(context),
      agentEvents: [],
      retrievalAudit: RecipeRetrievalAuditSchema.safeParse(values.recipeRetrievalAudit).data,
    };
    return;
  }
  if (
    typeof values.fridgeId !== "string" ||
    typeof values.query !== "string" ||
    (values.imageId !== null && typeof values.imageId !== "string")
  ) {
    throw new Error(`Query thread ${input.threadId} has an invalid checkpoint state`);
  }

  for await (const event of streamQueryForFridgeImage({
    userId: typeof values.userId === "string" ? values.userId : DEFAULT_USER_ID,
    fridgeId: values.fridgeId,
    imageId: values.imageId,
    query: values.query,
    threadId: input.threadId,
  }, { ...deps, promptBundle }, undefined, true)) {
    yield event;
  }
}

export async function* resumeQueryForFridgeImage(
  input: { threadId: string; resume: QueryResume },
  deps: QueryGraphDependencies = {},
) {
  // streamQueryForFridgeImage loads the prompt bundle when deps omit one.
  for await (const event of streamQueryForFridgeImage({
    fridgeId: "resume",
    imageId: null,
    query: "resume",
    threadId: input.threadId,
  }, deps, input.resume)) {
    yield event;
  }
}
