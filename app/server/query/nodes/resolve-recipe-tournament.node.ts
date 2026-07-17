import type { QueryGraphDependencies } from "../schemas/query";
import {
  RECIPE_TOURNAMENT_DISPLAY_LIMIT,
  resolveRecipeTournament,
} from "../services/recipe-tournament.server";
import type { FridgeQueryStateValue } from "../state";
import { recipeInventoryFingerprint } from "./build-recipe-search.node";

export function createResolveRecipeTournamentNode(_deps: QueryGraphDependencies = {}) {
  return async function resolveRecipeTournamentNode(state: FridgeQueryStateValue) {
    const tournament = resolveRecipeTournament(state.tournamentCandidates, state.tournamentEvaluations);
    const previousRetrieval = state.context.recipeRetrieval;
    const retrieval = previousRetrieval && typeof previousRetrieval === "object"
      ? previousRetrieval as Record<string, unknown>
      : {};
    const reason = tournament.error;
    const recipeRetrieval = {
      ...retrieval,
      recipes: tournament.recipes,
      noMatches: tournament.recipes.length === 0,
      exhausted: tournament.recipes.length < RECIPE_TOURNAMENT_DISPLAY_LIMIT,
      reason,
      tournament: { winnerId: tournament.recipes[0]?.id ?? null },
    };
    const shownRecipeIds = [...new Set([...state.shownRecipeIds, ...tournament.recipes.map((recipe) => recipe.id)])];
    const ingredientNames = Array.isArray(retrieval.inputIngredients)
      ? retrieval.inputIngredients.filter((value): value is string => typeof value === "string")
      : [];

    return {
      context: { ...state.context, recipeRetrieval },
      lastRecipeSearch: state.recipeSearch ? { ...state.recipeSearch, continuation: false } : null,
      recipeSearchSession: state.recipeSearch ? {
        profile: { ...state.recipeSearch, continuation: false },
        inventoryFingerprint: recipeInventoryFingerprint(ingredientNames),
        shownRecipeIds,
      } : null,
      shownRecipeIds,
    };
  };
}
