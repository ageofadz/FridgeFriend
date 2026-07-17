import { Command, END, START, Overwrite, StateGraph, type RetryPolicy } from "@langchain/langgraph";

import { checkpointer } from "../checkpointer.server";
import { assertLangSmithTracingEnabled } from "../langsmith.server";
import { loadPromptBundle } from "../prompts/registry.server";
import { createCalculateSpaceNode } from "./nodes/calculate-space.node";
import { createDetermineIntentNode } from "./nodes/determine-intent.node";
import { createApplySeededInventoryAssertionsNode } from "./nodes/apply-seeded-inventory-assertions.node";
import { createBuildRecipeSearchNode } from "./nodes/build-recipe-search.node";
import { createExtractMemoryCandidatesNode } from "./nodes/extract-memory-candidates.node";
import { createLoadFridgeContextNode } from "./nodes/load-fridge-context.node";
import { createPersistMemoryNode } from "./nodes/persist-memory.node";
import { createPlanWorkspaceActionsNode } from "./nodes/plan-workspace-actions.node";
import { createPlanExpiryNode } from "./nodes/plan-expiry.node";
import { createQueryInventoryNode } from "./nodes/query-inventory.node";
import { createProposeDrawerSplitNode, reviewDrawerSplitNode, routeDrawerSplitReview } from "./nodes/propose-drawer-split.node";
import {
  createAssessInventoryEnrichmentNode,
  createRequestInventoryClarificationNode,
  createRunFocusedInventoryEnrichmentNode,
} from "./nodes/enrich-inventory.node";
import { requestClarificationNode } from "./nodes/request-clarification.node";
import { createRespondNode } from "./nodes/respond.node";
import { retrieveKnowledgeNode } from "./nodes/retrieve-knowledge.node";
import { createRetrieveRecipesNode } from "./nodes/retrieve-recipes.node";
import { createGradeRecipeRetrievalNode } from "./nodes/grade-recipe-retrieval.node";
import { createRewriteRecipeQueryNode } from "./nodes/rewrite-recipe-query.node";
import { createEvaluateRecipeNode } from "./nodes/evaluate-recipe.node";
import { createResolveRecipeTournamentNode } from "./nodes/resolve-recipe-tournament.node";
import { validateMemoryCandidatesNode } from "./nodes/validate-memory-candidates.node";
import {
  routeIntent,
  routeIntentOrMemory,
  routeInventoryFollowup,
  routeAfterInventoryEnrichment,
  routeRecipeRetrievalGrade,
  routeRecipeQueryRewrite,
  routeRecipeSearch,
  routeExpiryPlan,
} from "./routing/query-routing";
import type {
  QueryGraphDependencies,
  QueryGraphInput,
  ExpiryPlan,
  QueryResume,
  QueryIntent,
  RecipeCard,
  QueryVisualEvidence,
  QueryStreamEvent,
} from "./schemas/query";
import { QUERY_VISIBLE_RESPONSE_TAG } from "./schemas/query";
import { FridgeQueryState } from "./state";
import { DEFAULT_USER_ID } from "../sqlite.server";
import {
  AgentActivityEventSchema,
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

function normalizeQueryInput(input: QueryGraphInput) {
  const threadId = queryThreadId(input);

  return {
    ...input,
    userId: input.userId?.trim() || DEFAULT_USER_ID,
    threadId,
    answer: null,
    visualEvidence: [],
    recipeRetrievalAttempt: 0,
    recipeRewriteCount: 0,
    recipeRetrievalGrade: null,
    tournamentCandidates: [],
    tournamentCandidate: null,
    tournamentEvaluations: new Overwrite([]),
    context: {
      conversationContext: input.conversationContext ?? {
        selectedItemIds: [],
        selectedZoneIds: [],
        selectedRecipeId: null,
      },
      workspaceActions: [],
    },
  };
}

export function createQueryGraph(deps: QueryGraphDependencies = {}) {
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
    .addNode("validate_memory_candidates", validateMemoryCandidatesNode)
    .addNode("persist_memory", createPersistMemoryNode(deps))
    .addNode("determine_intent", createDetermineIntentNode(deps), {
      retryPolicy: queryGraphModelRetryPolicy,
    })
    .addNode("build_recipe_search", createBuildRecipeSearchNode(deps), {
      retryPolicy: queryGraphModelRetryPolicy,
    })
    .addNode("query_inventory", createQueryInventoryNode(deps))
    .addNode("propose_drawer_split", createProposeDrawerSplitNode(deps), {
      retryPolicy: queryGraphModelRetryPolicy,
    })
    .addNode("review_drawer_split", reviewDrawerSplitNode)
    .addNode("plan_expiry", createPlanExpiryNode(deps))
    .addNode("assess_inventory_enrichment", createAssessInventoryEnrichmentNode(deps))
    .addNode("run_focused_inventory_enrichment", createRunFocusedInventoryEnrichmentNode(deps), {
      retryPolicy: queryGraphModelRetryPolicy,
    })
    .addNode("request_inventory_clarification", createRequestInventoryClarificationNode(deps))
    .addNode("retrieve_knowledge", retrieveKnowledgeNode)
    .addNode("retrieve_recipes", createRetrieveRecipesNode(deps))
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
    .addEdge("apply_seeded_inventory_assertions", "determine_intent")
    .addConditionalEdges("determine_intent", routeIntentOrMemory, {
      inventory: "query_inventory",
      expiry: "query_inventory",
      food_knowledge: "retrieve_knowledge",
      recipe: "query_inventory",
      shopping: "query_inventory",
      space: "calculate_space",
      clarification: "request_clarification",
      memory_update: "extract_memory_candidates",
    })
    .addEdge("extract_memory_candidates", "validate_memory_candidates")
    .addEdge("validate_memory_candidates", "persist_memory")
    .addConditionalEdges("persist_memory", routeIntent, {
      inventory: "query_inventory",
      expiry: "query_inventory",
      food_knowledge: "retrieve_knowledge",
      recipe: "query_inventory",
      shopping: "query_inventory",
      space: "calculate_space",
      clarification: "request_clarification",
    })
    .addEdge("query_inventory", "propose_drawer_split")
    .addEdge("propose_drawer_split", "assess_inventory_enrichment")
    .addConditionalEdges("assess_inventory_enrichment", routeAfterInventoryEnrichment, {
      focused_vlm: "run_focused_inventory_enrichment",
      ask_user: "request_inventory_clarification",
      respond: "plan_workspace_actions",
      retrieve_recipes: "build_recipe_search",
      calculate_space: "calculate_space",
      plan_expiry: "plan_expiry",
    })
    .addEdge("run_focused_inventory_enrichment", "assess_inventory_enrichment")
    .addEdge("request_inventory_clarification", "assess_inventory_enrichment")
    .addConditionalEdges("plan_expiry", routeExpiryPlan, {
      build_recipe_search: "build_recipe_search",
      plan_workspace_actions: "plan_workspace_actions",
    })
    .addConditionalEdges("build_recipe_search", routeRecipeSearch, {
      retrieve_recipes: "retrieve_recipes",
      clarification: "request_clarification",
    })
    .addEdge("retrieve_knowledge", "plan_workspace_actions")
    .addEdge("retrieve_recipes", "grade_recipe_retrieval")
    .addConditionalEdges("grade_recipe_retrieval", routeRecipeRetrievalGrade, {
      rewrite_recipe_query: "rewrite_recipe_query",
      plan_workspace_actions: "plan_workspace_actions",
      evaluate_recipe: "evaluate_recipe",
    })
    .addConditionalEdges("rewrite_recipe_query", routeRecipeQueryRewrite, {
      retrieve_recipes: "retrieve_recipes",
      plan_workspace_actions: "plan_workspace_actions",
    })
    .addEdge("evaluate_recipe", "resolve_recipe_tournament")
    .addEdge("resolve_recipe_tournament", "plan_workspace_actions")
    .addEdge("calculate_space", "plan_workspace_actions")
    .addEdge("request_clarification", END)
    .addEdge("plan_workspace_actions", "respond")
    .addConditionalEdges("respond", routeDrawerSplitReview, {
      review: "review_drawer_split",
      end: END,
    })
    .addEdge("review_drawer_split", END)
    .compile({
      checkpointer,
    });
}

export async function runQueryForFridgeImage(
  input: QueryGraphInput,
  deps: QueryGraphDependencies = {},
) {
  const langsmith = assertLangSmithTracingEnabled();
  const promptBundle = deps.promptBundle ?? await loadPromptBundle();
  const graph = createQueryGraph({ ...deps, promptBundle });
  const normalizedInput = normalizeQueryInput(input);
  const result = await graph.invoke(normalizedInput, {
    runName: "query_fridge_inventory",
    tags: ["fridgefriend", "query_graph", "chat"],
    metadata: {
      userId: normalizedInput.userId,
      fridgeId: normalizedInput.fridgeId,
      imageId: normalizedInput.imageId,
      thread_id: normalizedInput.threadId,
      langsmithProject: langsmith.project,
      langsmithPromptEnvironment: langsmith.promptEnvironment,
    },
    configurable: {
      thread_id: normalizedInput.threadId,
    },
  });

  if (!result.answer) {
    throw new Error("Query graph completed without an answer");
  }

  return {
    answer: result.answer,
    intent: result.intent,
    visualEvidence: result.visualEvidence,
    workspaceActions: workspaceActionsFromContext(result.context),
  };
}

function streamConfig(input: QueryGraphInput) {
  const langsmith = assertLangSmithTracingEnabled();
  const normalizedInput = normalizeQueryInput(input);

  return {
    runName: "query_fridge_inventory",
    tags: ["fridgefriend", "query_graph", "chat"],
    metadata: {
      userId: normalizedInput.userId,
      fridgeId: normalizedInput.fridgeId,
      imageId: normalizedInput.imageId,
      thread_id: normalizedInput.threadId,
      langsmithProject: langsmith.project,
      langsmithPromptEnvironment: langsmith.promptEnvironment,
    },
    configurable: {
      thread_id: normalizedInput.threadId,
    },
  };
}

function nodeStatusMessage(node: string) {
  const messages: Record<string, string> = {
    load_context: "Loaded query context.",
    apply_seeded_inventory_assertions: "Applied selected inventory assertions.",
    extract_memory_candidates: "Checked for durable memory updates.",
    validate_memory_candidates: "Validated memory updates.",
    persist_memory: "Saved durable memory updates.",
    determine_intent: "Understood the request.",
    query_inventory: "Prepared inventory lookup.",
    propose_drawer_split: "Checked the selected drawer for separate inventory items.",
    review_drawer_split: "Prepared the inventory split for review.",
    plan_expiry: "Assessed freshness and food-waste priorities.",
    assess_inventory_enrichment: "Checked whether more inventory detail is needed.",
    run_focused_inventory_enrichment: "Inspected relevant inventory details.",
    request_inventory_clarification: "Requested inventory clarification.",
    build_recipe_search: "Built the local recipe search.",
    retrieve_knowledge: "Retrieved food context.",
    retrieve_recipes: "Retrieved local recipe options.",
    grade_recipe_retrieval: "Checked recipe retrieval relevance.",
    rewrite_recipe_query: "Refined the recipe search.",
    evaluate_recipe: "Scored a recipe tournament candidate.",
    resolve_recipe_tournament: "Selected recipe tournament finalists.",
    calculate_space: "Calculated fridge space.",
    request_clarification: "Prepared a clarification.",
    plan_workspace_actions: "Prepared visual workspace updates.",
    respond: "Drafting the answer.",
  };

  return messages[node] ?? `Finished ${node}.`;
}

function nodeActiveStatusMessage(node: string) {
  const messages: Record<string, string> = {
    load_context: "Loading query context.",
    extract_memory_candidates: "Checking for durable memory updates.",
    validate_memory_candidates: "Validating memory updates.",
    persist_memory: "Saving durable memory updates.",
    determine_intent: "Understanding the request.",
    query_inventory: "Preparing inventory lookup.",
    propose_drawer_split: "Checking the selected drawer for separate inventory items.",
    review_drawer_split: "Preparing the inventory split for review.",
    plan_expiry: "Assessing freshness and food-waste priorities.",
    assess_inventory_enrichment: "Checking whether more inventory detail is needed.",
    run_focused_inventory_enrichment: "Inspecting relevant inventory details.",
    request_inventory_clarification: "Requesting inventory clarification.",
    build_recipe_search: "Building the local recipe search.",
    retrieve_knowledge: "Retrieving food context.",
    retrieve_recipes: "Retrieving local recipe options.",
    grade_recipe_retrieval: "Checking recipe retrieval relevance.",
    rewrite_recipe_query: "Refining the recipe search.",
    evaluate_recipe: "Scoring recipe tournament candidates.",
    resolve_recipe_tournament: "Selecting recipe tournament finalists.",
    calculate_space: "Calculating fridge space.",
    request_clarification: "Preparing a clarification.",
    plan_workspace_actions: "Preparing visual workspace updates.",
    respond: "Drafting the answer.",
  };

  return messages[node] ?? `Running ${node}.`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isQueryIntent(value: unknown): value is QueryIntent {
  return (
    value === "inventory" ||
    value === "expiry" ||
    value === "food_knowledge" ||
    value === "recipe" ||
    value === "shopping" ||
    value === "space" ||
    value === "clarification"
  );
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
  if (!isRecord(value) || typeof value.type !== "string") {
    return false;
  }

  if (value.type === "status") {
    return typeof value.message === "string";
  }

  if (value.type === "tool") {
    return (
      typeof value.name === "string" &&
      typeof value.message === "string" &&
      (value.status === "started" ||
        value.status === "progress" ||
        value.status === "finished")
    );
  }

  if (value.type === "token") {
    return typeof value.text === "string";
  }

  if (value.type === "recipe_tournament_started") {
    return (
      typeof value.candidateCount === "number" &&
      Number.isInteger(value.candidateCount) &&
      value.candidateCount > 0 &&
      typeof value.displaySlotCount === "number" &&
      Number.isInteger(value.displaySlotCount) &&
      value.displaySlotCount > 0
    );
  }

  if (value.type === "recipe_tournament_update") {
    return (
      Array.isArray(value.recipes) &&
      value.recipes.every((recipe) => isRecord(recipe) && recipeCardFromRecord(recipe) !== null) &&
      typeof value.evaluatedCount === "number" &&
      Number.isInteger(value.evaluatedCount) &&
      typeof value.totalCount === "number" &&
      Number.isInteger(value.totalCount) &&
      Array.isArray(value.droppedRecipeIds) &&
      value.droppedRecipeIds.every((recipeId) => typeof recipeId === "string")
    );
  }

  if (value.type === "recipe_tournament_finished") {
    return (
      Array.isArray(value.recipes) &&
      value.recipes.every((recipe) => isRecord(recipe) && recipeCardFromRecord(recipe) !== null)
    );
  }

  if (value.type === "clarification") {
    return Array.isArray(value.questions) && value.questions.every((question) =>
      isRecord(question) &&
      typeof question.itemId === "string" &&
      typeof question.field === "string" &&
      typeof question.question === "string"
    );
  }

  if (value.type === "final") {
    return typeof value.answer === "string" && Array.isArray(value.visualEvidence);
  }

  if (value.type === "workspace_action") {
    return WorkspaceActionSchema.safeParse(value.action).success;
  }

  if (value.type === "agent_event") {
    return AgentActivityEventSchema.safeParse(value.event).success;
  }

  if (value.type === "error") {
    return typeof value.error === "string";
  }

  return false;
}

function isQueryVisualEvidence(value: unknown): value is QueryVisualEvidence[] {
  return Array.isArray(value) && value.every(
    (entry) =>
      isRecord(entry) &&
      typeof entry.itemId === "string" &&
      typeof entry.displayName === "string" &&
      typeof entry.dataUrl === "string",
  );
}

function workspaceActionsFromContext(value: unknown): WorkspaceAction[] {
  if (!isRecord(value)) return [];
  const parsed = z.array(WorkspaceActionSchema).safeParse(value.workspaceActions);
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
  if (
    typeof recipe.id !== "string" ||
    typeof recipe.name !== "string" ||
    typeof recipe.minutes !== "number" ||
    !Array.isArray(recipe.matchedIngredients) ||
    !Array.isArray(recipe.missingIngredients) ||
    recipe.matchedIngredients.some((ingredient) => typeof ingredient !== "string") ||
    recipe.missingIngredients.some((ingredient) => typeof ingredient !== "string") ||
    (Array.isArray(recipe.matchedTags) &&
      recipe.matchedTags.some((tag) => typeof tag !== "string")) ||
    (Array.isArray(recipe.matchBadges) &&
      recipe.matchBadges.some((badge) => typeof badge !== "string"))
  ) {
    return null;
  }

  return {
    id: recipe.id,
    name: recipe.name,
    description: typeof recipe.description === "string" ? recipe.description : null,
    minutes: recipe.minutes,
    matchedIngredients: recipe.matchedIngredients,
    missingIngredients: recipe.missingIngredients,
    matchedTags: Array.isArray(recipe.matchedTags) && recipe.matchedTags.every((tag) => typeof tag === "string")
      ? recipe.matchedTags
      : [],
    matchBadges: Array.isArray(recipe.matchBadges) && recipe.matchBadges.every((badge) => typeof badge === "string")
      ? recipe.matchBadges
      : [],
    usesSoonIngredients: Array.isArray(recipe.usesSoonIngredients) && recipe.usesSoonIngredients.every((ingredient) => typeof ingredient === "string")
      ? recipe.usesSoonIngredients
      : undefined,
    tournamentPlacement: recipe.tournamentPlacement === "winner" || recipe.tournamentPlacement === "finalist"
      ? recipe.tournamentPlacement
      : undefined,
  };
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
    tournamentPlacement: recipe.tournamentPlacement,
  };
}

function recipeCardsFromUpdate(update: Record<string, unknown>): RecipeCard[] {
  if (!isRecord(update.context) || !isRecord(update.context.recipeRetrieval)) {
    return [];
  }

  const recipes = update.context.recipeRetrieval.recipes;

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

function expiryPlanFromContext(value: unknown): ExpiryPlan | null {
  if (!isRecord(value) || !isRecord(value.expiryPlan)) return null;
  const plan = value.expiryPlan;
  if (!Array.isArray(plan.items) || !Array.isArray(plan.priorityItems) || !Array.isArray(plan.expiredItems)) return null;
  const validItem = (item: unknown) => isRecord(item) &&
    typeof item.id === "string" &&
    (typeof item.visibleItemId === "string" || item.visibleItemId === null) &&
    typeof item.name === "string" && typeof item.ingredientName === "string" &&
    typeof item.storageLocation === "string" && typeof item.date === "string" &&
    typeof item.label === "string" && typeof item.wasteScore === "number" &&
    Number.isFinite(item.wasteScore) &&
    (item.urgency === "fresh" || item.urgency === "use_soon" || item.urgency === "urgent" || item.urgency === "expired" || item.urgency === "unknown") &&
    (item.source === "user_date" || item.source === "observed_date" || item.source === "recorded_date" || item.source === "estimated") &&
    (item.confidence === "high" || item.confidence === "medium" || item.confidence === "low") &&
    (typeof item.dateIssue === "string" || item.dateIssue === null);
  if (!plan.items.every(validItem) || !plan.priorityItems.every(validItem) || !plan.expiredItems.every(validItem)) return null;
  return plan as unknown as ExpiryPlan;
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
  let tournamentCandidates: RankedRecipe[] = [];
  let tournamentEvaluations: RecipeTournamentEvaluation[] = [];
  let displayedTournamentRecipeIds: string[] = [];

  yield {
    type: "status",
    node: "load_context",
    message: nodeActiveStatusMessage("load_context"),
  };

  const stream = await graph.stream(
    resume ? new Command({ resume }) : normalizedInput,
    {
    ...config,
    streamMode: ["updates", "messages", "custom"],
    },
  );
  let interrupted = false;

  for await (const streamedChunk of stream) {
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
            typeof entry.value.zoneId === "string" &&
            typeof entry.value.summary === "string" &&
            Array.isArray(entry.value.items) &&
            entry.value.items.every((item) => isRecord(item) && typeof item.label === "string" && typeof item.name === "string")
          ) {
            interrupted = true;
            yield {
              type: "inventory_split_review",
              zoneId: entry.value.zoneId,
              summary: entry.value.summary,
              items: entry.value.items as Array<{ label: string; name: string }>,
            };
          }
        }
      }
      for (const [node, update] of updateEntries(chunk)) {
        yield {
          type: "status",
          node,
          message: nodeStatusMessage(node),
        };

        if (typeof update.answer === "string") {
          finalAnswer = update.answer;
        }

        if (isQueryIntent(update.intent)) {
          finalIntent = update.intent;
        }

        if (isQueryVisualEvidence(update.visualEvidence)) {
          finalVisualEvidence = update.visualEvidence;
        }

        const workspaceActions = workspaceActionsFromContext(update.context);
        if (workspaceActions.length > 0) {
          finalWorkspaceActions = workspaceActions;
          for (const action of workspaceActions) {
            yield { type: "workspace_action", action };
          }
        }

        const expiryPlan = expiryPlanFromContext(update.context);
        if (expiryPlan) {
          finalExpiryPlan = expiryPlan;
          yield { type: "expiry_plan", plan: expiryPlan };
        }

        const recipeCards = recipeCardsFromUpdate(update);

        if (recipeCards.length > 0) {
          finalRecipeCards = recipeCards;
        }

        if (node === "retrieve_recipes") {
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

        if (node === "evaluate_recipe" && tournamentCandidates.length > 0) {
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

        if (node === "resolve_recipe_tournament" && recipeCards.length > 0) {
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
        visualEvidence: finalVisualEvidence,
        workspaceActions: finalWorkspaceActions,
        agentEvents: [],
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
    visualEvidence: finalVisualEvidence,
    workspaceActions: finalWorkspaceActions,
    agentEvents: [],
  };
}

export async function* resumeQueryForFridgeImage(
  input: { threadId: string; resume: QueryResume },
  deps: QueryGraphDependencies = {},
) {
  for await (const event of streamQueryForFridgeImage({
    fridgeId: "resume",
    imageId: null,
    query: "resume",
    threadId: input.threadId,
  }, { ...deps, promptBundle: deps.promptBundle ?? await loadPromptBundle() }, input.resume)) {
    yield event;
  }
}
