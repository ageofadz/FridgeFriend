import { getWriter, Overwrite, type LangGraphRunnableConfig } from "@langchain/langgraph";

import { normalizeIngredientName } from "../../recipes/normalization";
import { UNIVERSAL_BASIC_INGREDIENTS } from "../../recipes/pantry-basics";
import {
  getPantryCompletionRecipeCandidates,
  getRecipeCandidatesByIngredients,
  getRecipeCandidatesByTags,
  getRecipesByIds,
} from "../../recipes/repository.server";
import { MAX_RECIPE_CANDIDATE_LIMIT, searchRecipeCandidates } from "../../recipes/vector-store.server";
import type { RecipeCandidate } from "../../recipes/types";
import { isGroceryPlannerRequest, isPantryCompletionRequest } from "../services/grocery-planner.server";
import { rankRecipeCandidates, type RankedRecipe } from "../services/recipe-retrieval.server";
import type { QueryGraphDependencies, RecipeRetrievalAudit } from "../schemas/query";
import type { FridgeQueryStateValue } from "../state";
import { availableRecipeIngredients } from "../services/available-recipe-ingredients.server";

const EXACT_CANDIDATE_LIMIT = 450;
const MAX_RECIPE_IDS_PER_LOOKUP = 450;
const TOURNAMENT_CANDIDATE_LIMIT = 20;

function intentTierRank(tier: RecipeCandidate["intentTier"]) {
  if (tier === "primary") return 0;
  if (tier === "related") return 1;
  return 2;
}

function mergeCandidates(lists: RecipeCandidate[][]) {
  const merged = new Map<string, RecipeCandidate>();
  for (const list of lists) {
    for (const candidate of list) {
      const previous = merged.get(candidate.recipeId);
      const previousTier = previous?.intentTier;
      const candidateTier = candidate.intentTier;
      const intentTier = intentTierRank(candidateTier) < intentTierRank(previousTier)
        ? candidateTier
        : previousTier ?? candidateTier;
      merged.set(candidate.recipeId, {
        recipeId: candidate.recipeId,
        semanticScore: Math.max(previous?.semanticScore ?? 0, candidate.semanticScore),
        ...(intentTier ? { intentTier } : {}),
        tagScore: Math.max(previous?.tagScore ?? 0, candidate.tagScore ?? 0),
        ingredientScore: Math.max(previous?.ingredientScore ?? 0, candidate.ingredientScore ?? 0),
        matchedTags: [...new Set([...(previous?.matchedTags ?? []), ...(candidate.matchedTags ?? [])])].sort(),
        matchedInventoryIngredients: [...new Set([
          ...(previous?.matchedInventoryIngredients ?? []),
          ...(candidate.matchedInventoryIngredients ?? []),
        ])].sort(),
      });
    }
  }

  return [...merged.values()]
    .sort((left, right) =>
      intentTierRank(left.intentTier) - intentTierRank(right.intentTier) ||
      (right.ingredientScore ?? 0) - (left.ingredientScore ?? 0) ||
      (right.tagScore ?? 0) - (left.tagScore ?? 0) ||
      right.semanticScore - left.semanticScore ||
      left.recipeId.localeCompare(right.recipeId))
    .slice(0, MAX_RECIPE_IDS_PER_LOOKUP);
}

function semanticCandidateLimit(input: {
  shownRecipeIds: string[];
  continuation: boolean;
  vectorCandidateLimit: number;
}) {
  if (!input.continuation) {
    return input.vectorCandidateLimit;
  }

  return Math.min(
    MAX_RECIPE_CANDIDATE_LIMIT,
    input.vectorCandidateLimit + input.shownRecipeIds.length,
  );
}

function recipeSearchIngredientNames(state: FridgeQueryStateValue, ingredientNames: string[]) {
  const requestedIngredients = state.recipeSearch?.preferredIngredients ?? [];

  return [...new Set([...ingredientNames, ...requestedIngredients]
    .map(normalizeIngredientName)
    .filter(Boolean))];
}

function minimumIntentResultCount(state: FridgeQueryStateValue) {
  return isPantryCompletionRequest(state) || isGroceryPlannerRequest(state) ? 3 : 1;
}

function candidateSourceCounts(candidates: RecipeCandidate[]) {
  return {
    primary: candidates.filter((candidate) => candidate.intentTier === "primary").length,
    related: candidates.filter((candidate) => candidate.intentTier === "related").length,
    coverage: candidates.filter((candidate) => candidate.intentTier === "coverage").length,
  };
}

function recordRecipeRetrievalMetadata(
  config: LangGraphRunnableConfig | undefined,
  sourceCounts: ReturnType<typeof candidateSourceCounts>,
  selectedIntentTier: "primary" | "related" | "coverage" | null,
  audit: RecipeRetrievalAudit,
) {
  const metadata = {
    recipeCandidateSourcePrimary: sourceCounts.primary,
    recipeCandidateSourceRelated: sourceCounts.related,
    recipeCandidateSourceCoverage: sourceCounts.coverage,
    recipeSelectedIntentTier: selectedIntentTier,
    recipeVectorCandidates: audit.vectorCandidates,
    recipeTagSqlCandidates: audit.tagSqlCandidates,
    recipeIngredientSqlCandidates: audit.ingredientSqlCandidates,
    recipeDeduplicatedCandidates: audit.deduplicatedCandidateIds,
    recipeCanonicalHydrationCount: audit.canonicalHydrationCount,
    recipeHardFilterRejections: audit.hardFilterRejections,
    recipeCoverageRankedCandidates: audit.coverageRankedCandidates,
    recipeTournamentCandidates: audit.tournamentCandidates,
    recipeRetrievalTerminalReason: audit.terminalReason,
  };
  if (config?.metadata) {
    Object.assign(config.metadata, metadata);
  }
  const callbacks = config?.callbacks;
  if (!callbacks || Array.isArray(callbacks)) return;
  const callbackManager = callbacks as { addMetadata?: (value: Record<string, unknown>) => void };
  if (typeof callbackManager.addMetadata === "function") {
    callbackManager.addMetadata(metadata);
  }
}

export function mergeRecipeCandidateSources(lists: RecipeCandidate[][]) {
  return mergeCandidates(lists);
}

export function createRetrieveRecipeCandidatesNode(deps: QueryGraphDependencies = {}) {
  return async function retrieveRecipesNode(state: FridgeQueryStateValue, config?: LangGraphRunnableConfig) {
    const writer = config ? getWriter(config) : undefined;
    const ingredients = await availableRecipeIngredients(state, deps);
    if (!state.recipeSearch) {
      const reason = state.recipeSearchError ?? "Recipe search request was unavailable.";
      const audit: RecipeRetrievalAudit = {
        vectorCandidates: 0,
        tagSqlCandidates: 0,
        ingredientSqlCandidates: 0,
        deduplicatedCandidateIds: 0,
        canonicalHydrationCount: 0,
        hardFilterRejections: 0,
        coverageRankedCandidates: 0,
        tournamentCandidates: 0,
        terminalReason: "search_unavailable",
      };
      writer?.({ type: "tool", name: "food_com_recipes", status: "finished", message: reason });
      return {
        context: {
          ...state.context,
          queryMode: "recipe",
          recipeRetrieval: {
            source: "food_com",
            inputIngredients: ingredients.map((ingredient) => ingredient.name),
            semanticQuery: null,
            recipes: [],
            noMatches: true,
            exhausted: false,
            reason,
            audit,
          },
        },
        recipeRetrievalAudit: audit,
        tournamentCandidates: [],
        tournamentEvaluations: new Overwrite([]),
        recipeSearchExhausted: false,
      };
    }

    writer?.({ type: "tool", name: "food_com_recipes", status: "started", message: "Searching retrieved recipe candidates." });
    const search = state.recipeSearch;
    const previousShownIds = search.continuation
      ? state.recipeSearchSession?.shownRecipeIds ?? state.shownRecipeIds
      : [];
    const vectorSearch = deps.searchRecipeCandidates ?? searchRecipeCandidates;
    const ingredientNames = ingredients.map((ingredient) => ingredient.name);
    const recipeSearchIngredients = recipeSearchIngredientNames(state, ingredientNames);
    const ingredientCandidatesPromise = isPantryCompletionRequest(state)
      ? Promise.resolve((deps.getPantryCompletionRecipeCandidates ?? getPantryCompletionRecipeCandidates)({
        ingredients: recipeSearchIngredients,
        universalIngredients: UNIVERSAL_BASIC_INGREDIENTS,
        minMissingIngredients: 1,
        maxMissingIngredients: 3,
        limit: EXACT_CANDIDATE_LIMIT,
      }))
      : Promise.resolve((deps.getRecipeCandidatesByIngredients ?? getRecipeCandidatesByIngredients)({
        ingredients: recipeSearchIngredients,
        limit: EXACT_CANDIDATE_LIMIT,
      }));
    const [primaryCandidates, tagCandidates, ingredientCandidates] = await Promise.all([
      vectorSearch({
        query: search.semanticQuery,
        limit: semanticCandidateLimit({
          shownRecipeIds: previousShownIds,
          continuation: search.continuation,
          vectorCandidateLimit: search.vectorCandidateLimit,
        }),
        maxMinutes: search.maxMinutes,
        maxCalories: search.maxCalories,
        minProteinDailyValue: search.minProteinDailyValue,
      }).then((candidates) => candidates.map((candidate) => ({
        ...candidate,
        intentTier: "primary" as const,
      }))),
      Promise.resolve((deps.getRecipeCandidatesByTags ?? getRecipeCandidatesByTags)({
        requiredTags: search.requiredTags,
        preferredTags: search.preferredTags,
        excludedTags: search.excludedTags,
        limit: EXACT_CANDIDATE_LIMIT,
      })).then((candidates) => candidates.map((candidate) => ({
        recipeId: candidate.recipeId,
        semanticScore: 0,
        tagScore: candidate.tagScore,
        matchedTags: candidate.matchedTags,
      } satisfies RecipeCandidate))),
      ingredientCandidatesPromise.then((candidates) => candidates.map((candidate) => ({
        recipeId: candidate.recipeId,
        semanticScore: 0,
        intentTier: "coverage" as const,
        ingredientScore: candidate.ingredientScore,
        matchedInventoryIngredients: candidate.matchedIngredients,
      } satisfies RecipeCandidate))),
    ]);
    const candidates = mergeCandidates([primaryCandidates, tagCandidates, ingredientCandidates]);
    const audit: RecipeRetrievalAudit = {
      vectorCandidates: primaryCandidates.length,
      tagSqlCandidates: tagCandidates.length,
      ingredientSqlCandidates: ingredientCandidates.length,
      deduplicatedCandidateIds: candidates.length,
      canonicalHydrationCount: 0,
      hardFilterRejections: 0,
      coverageRankedCandidates: 0,
      tournamentCandidates: 0,
      terminalReason: candidates.length === 0
        ? primaryCandidates.length === 0
          ? "vector_empty"
          : "candidate_sources_empty"
        : "ready",
    };
    return {
      recipeCandidates: candidates,
      recipeInputIngredients: ingredientNames,
      recipeRetrievalGrade: null,
      recipeRetrievalAudit: audit,
      tournamentEvaluations: new Overwrite([]),
      context: {
        ...state.context,
        queryMode: "recipe",
        recipeCandidateSourceCounts: candidateSourceCounts(candidates),
      },
    };
  };
}

export function createRankRetrievedRecipesNode(deps: QueryGraphDependencies = {}) {
  return async function rankRetrievedRecipesNode(state: FridgeQueryStateValue, config?: LangGraphRunnableConfig) {
    const writer = config ? getWriter(config) : undefined;
    const search = state.recipeSearch;
    if (!search) {
      return {};
    }
    const previousShownIds = search.continuation
      ? state.recipeSearchSession?.shownRecipeIds ?? state.shownRecipeIds
      : [];
    const availableIngredients = await availableRecipeIngredients(state, deps);
    const minimumPrimaryIntentResults = minimumIntentResultCount(state);
    const rank = async (candidates: RecipeCandidate[]) => {
      const recipes = await (deps.getRecipesByIds ?? getRecipesByIds)(candidates
        .filter((candidate) => !previousShownIds.includes(candidate.recipeId))
        .map((candidate) => candidate.recipeId));
      return {
        retrieval: rankRecipeCandidates({
        candidates,
        recipes,
        search,
        availableIngredients,
        dietaryRestrictions: state.dietaryRestrictions,
        dietaryPreferences: state.dietaryPreferences,
        activeGoals: state.activeGoals,
        excludedRecipeIds: previousShownIds,
        limit: TOURNAMENT_CANDIDATE_LIMIT,
        minimumPrimaryIntentResults,
        ...(isPantryCompletionRequest(state)
          ? {
            minMissingIngredients: 1,
            maxMissingIngredients: 3,
            excludeUniversalBasics: true,
          }
          : {}),
        }),
        canonicalHydrationCount: recipes.length,
      };
    };
    const candidates = state.recipeCandidates;
    const ranked = await rank(candidates);
    const retrieval = ranked.retrieval;

    const semanticQuery = search.semanticQuery;
    const sourceCounts = candidateSourceCounts(candidates);
    const selectedIntentTier = retrieval.recipes.length === 0
      ? null
      : retrieval.recipes.some((recipe) => recipe.intentTier === "primary")
        ? "primary"
        : retrieval.recipes.some((recipe) => recipe.intentTier === "related")
          ? "related"
          : "coverage";
    const preliminaryAudit = state.recipeRetrievalAudit;
    const audit: RecipeRetrievalAudit = {
      vectorCandidates: preliminaryAudit?.vectorCandidates ?? 0,
      tagSqlCandidates: preliminaryAudit?.tagSqlCandidates ?? 0,
      ingredientSqlCandidates: preliminaryAudit?.ingredientSqlCandidates ?? 0,
      deduplicatedCandidateIds: candidates.length,
      canonicalHydrationCount: ranked.canonicalHydrationCount,
      hardFilterRejections: retrieval.audit.hardFilterRejections,
      coverageRankedCandidates: retrieval.audit.coverageRankedCandidates,
      tournamentCandidates: retrieval.audit.tournamentCandidates,
      terminalReason: candidates.length === 0
        ? preliminaryAudit?.terminalReason === "vector_empty"
          ? "vector_empty"
          : "candidate_sources_empty"
        : ranked.canonicalHydrationCount === 0
          ? "canonical_hydration_empty"
          : retrieval.audit.terminalReason,
    };
    recordRecipeRetrievalMetadata(config, sourceCounts, selectedIntentTier, audit);
    writer?.({
      type: "tool",
      name: "food_com_recipes",
      status: "finished",
      message: retrieval.noMatches
        ? `Recipe retrieval produced no tournament candidates: ${audit.terminalReason}.`
        : `Retrieved ${retrieval.recipes.length} tournament candidates.`,
    });

    return {
      recipeCandidates: candidates,
      context: {
        ...state.context,
        queryMode: "recipe",
        recipeRetrieval: {
          ...retrieval,
          semanticQuery,
          candidateSourceCounts: sourceCounts,
          selectedIntentTier,
          audit,
        },
      },
      recipeRetrievalAudit: audit,
      tournamentCandidates: retrieval.recipes,
      recipeRetrievalGrade: null,
      recipeSearchExhausted: Boolean(retrieval.exhausted),
    };
  };
}

export function createRetrieveRecipesNode(deps: QueryGraphDependencies = {}) {
  const retrieveCandidates = createRetrieveRecipeCandidatesNode(deps);
  const rankRetrievedRecipes = createRankRetrievedRecipesNode(deps);

  return async function retrieveRecipesNode(
    state: FridgeQueryStateValue,
    config?: LangGraphRunnableConfig,
  ): Promise<{
    context: Record<string, unknown>;
    tournamentCandidates: RankedRecipe[];
    tournamentEvaluations: unknown;
    recipeRetrievalGrade: null;
    recipeSearchExhausted?: boolean;
  }> {
    const retrievalUpdate = await retrieveCandidates(state, config);
    const { tournamentEvaluations: evaluationsReset, ...retrievalStateUpdate } = retrievalUpdate;
    const nextState = { ...state, ...retrievalStateUpdate };
    if (!nextState.recipeSearch) {
      return {
        context: retrievalUpdate.context ?? state.context,
        tournamentCandidates: [],
        tournamentEvaluations: evaluationsReset ?? new Overwrite([]),
        recipeRetrievalGrade: null,
      };
    }
    const rankedUpdate = await rankRetrievedRecipes(nextState, config);

    return {
      context: rankedUpdate.context ?? nextState.context,
      tournamentCandidates: rankedUpdate.tournamentCandidates ?? [],
      tournamentEvaluations: evaluationsReset ?? new Overwrite([]),
      recipeRetrievalGrade: null,
      ...("recipeSearchExhausted" in rankedUpdate
        ? { recipeSearchExhausted: rankedUpdate.recipeSearchExhausted }
        : {}),
    };
  };
}
