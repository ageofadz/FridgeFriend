import { getWriter, type LangGraphRunnableConfig } from "@langchain/langgraph";

import { normalizeIngredientName } from "../../recipes/normalization";
import {
  getRecipeCandidatesByIngredients,
  getRecipeCandidatesByTags,
  getRecipesByIds,
} from "../../recipes/repository.server";
import { MAX_RECIPE_CANDIDATE_LIMIT, searchRecipeCandidates } from "../../recipes/vector-store.server";
import type { RecipeCandidate } from "../../recipes/types";
import { rankRecipeCandidates } from "../services/recipe-retrieval.server";
import type { QueryGraphDependencies } from "../schemas/query";
import type { FridgeQueryStateValue } from "../state";
import { availableRecipeIngredients } from "../services/available-recipe-ingredients.server";

const SEMANTIC_CANDIDATE_LIMIT = 50;
const EXACT_CANDIDATE_LIMIT = 250;
const MAX_RECIPE_IDS_PER_LOOKUP = 450;
const TOURNAMENT_CANDIDATE_LIMIT = 20;

function mergeCandidates(lists: RecipeCandidate[][]) {
  const merged = new Map<string, RecipeCandidate>();
  for (const list of lists) {
    for (const candidate of list) {
      const previous = merged.get(candidate.recipeId);
      merged.set(candidate.recipeId, {
        recipeId: candidate.recipeId,
        semanticScore: Math.max(previous?.semanticScore ?? 0, candidate.semanticScore),
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
      (right.ingredientScore ?? 0) - (left.ingredientScore ?? 0) ||
      (right.tagScore ?? 0) - (left.tagScore ?? 0) ||
      right.semanticScore - left.semanticScore ||
      left.recipeId.localeCompare(right.recipeId))
    .slice(0, MAX_RECIPE_IDS_PER_LOOKUP);
}

function semanticQuery(state: FridgeQueryStateValue) {
  const search = state.recipeSearch;
  if (!search) return state.query;
  const memory = [
    ...search.memoryPreferredTags.map((tag) => `prefers ${tag}`),
    ...search.memoryGoalTags.map((tag) => `goal ${tag}`),
    ...state.semanticMemories.map((memory) => memory.content),
  ];
  return [search.semanticQuery, ...memory].filter(Boolean).join("\n");
}

function semanticCandidateLimit(shownRecipeIds: string[], continuation: boolean) {
  if (!continuation) {
    return SEMANTIC_CANDIDATE_LIMIT;
  }

  return Math.min(MAX_RECIPE_CANDIDATE_LIMIT, SEMANTIC_CANDIDATE_LIMIT + shownRecipeIds.length);
}

function recipeSearchIngredientNames(state: FridgeQueryStateValue, ingredientNames: string[]) {
  const search = state.recipeSearch;
  const requestedIngredients = search?.useAvailableIngredients ? [] : search?.preferredIngredients ?? [];

  return [...new Set([...ingredientNames, ...requestedIngredients]
    .map(normalizeIngredientName)
    .filter(Boolean))];
}

export function mergeRecipeCandidateSources(lists: RecipeCandidate[][]) {
  return mergeCandidates(lists);
}

export function createRetrieveRecipesNode(deps: QueryGraphDependencies = {}) {
  return async function retrieveRecipesNode(state: FridgeQueryStateValue, config?: LangGraphRunnableConfig) {
    const writer = config ? getWriter(config) : undefined;
    const ingredients = await availableRecipeIngredients(state, deps);
    if (!state.recipeSearch) {
      const reason = state.recipeSearchError ?? "Recipe search request was unavailable.";
      writer?.({ type: "tool", name: "food_com_recipes", status: "finished", message: reason });
      return { context: { ...state.context, queryMode: "recipe", recipeRetrieval: {
        source: "food_com", inputIngredients: ingredients.map((ingredient) => ingredient.name), semanticQuery: null,
        recipes: [], noMatches: true, exhausted: false, reason,
      } }, tournamentCandidates: [] };
    }

    writer?.({ type: "tool", name: "food_com_recipes", status: "started", message: "Searching the local Food.com recipe index." });
    const search = state.recipeSearch;
    const previousShownIds = search.continuation
      ? state.recipeSearchSession?.shownRecipeIds ?? state.shownRecipeIds
      : [];
    const vectorSearch = deps.searchRecipeCandidates ?? searchRecipeCandidates;
    const ingredientNames = ingredients.map((ingredient) => ingredient.name);
    const recipeSearchIngredients = recipeSearchIngredientNames(state, ingredientNames);
    const [semanticCandidates, tagCandidates, ingredientCandidates] = await Promise.all([
      vectorSearch({
        query: semanticQuery(state),
        limit: semanticCandidateLimit(previousShownIds, search.continuation),
      }),
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
      Promise.resolve((deps.getRecipeCandidatesByIngredients ?? getRecipeCandidatesByIngredients)({
        ingredients: recipeSearchIngredients,
        limit: EXACT_CANDIDATE_LIMIT,
      })).then((candidates) => candidates.map((candidate) => ({
        recipeId: candidate.recipeId,
        semanticScore: 0,
        ingredientScore: candidate.ingredientScore,
        matchedInventoryIngredients: candidate.matchedIngredients,
      } satisfies RecipeCandidate))),
    ]);
    const candidates = mergeCandidates([semanticCandidates, tagCandidates, ingredientCandidates]);
    const recipes = await (deps.getRecipesByIds ?? getRecipesByIds)(candidates
      .filter((candidate) => !previousShownIds.includes(candidate.recipeId))
      .map((candidate) => candidate.recipeId));
    const retrieval = rankRecipeCandidates({
      candidates, recipes, search, availableIngredients: ingredients,
      dietaryRestrictions: state.dietaryRestrictions,
      dietaryPreferences: state.dietaryPreferences,
      activeGoals: state.activeGoals,
      excludedRecipeIds: previousShownIds,
      limit: TOURNAMENT_CANDIDATE_LIMIT,
    });
    writer?.({
      type: "tool", name: "food_com_recipes", status: "finished",
      message: retrieval.noMatches
        ? retrieval.reason ?? "The local Food.com index found no matching recipes."
        : `Retrieved ${retrieval.recipes.length} eligible local Food.com tournament candidates.`,
    });

    return {
      context: { ...state.context, queryMode: "recipe", recipeRetrieval: retrieval },
      tournamentCandidates: retrieval.recipes,
      recipeRetrievalAttempt: state.recipeRetrievalAttempt + 1,
      recipeRetrievalGrade: null,
    };
  };
}
