import type { QueryGraphDependencies } from "../schemas/query";
import {
  RECIPE_TOURNAMENT_DISPLAY_LIMIT,
  resolveRecipeTournament,
} from "../services/recipe-tournament.server";
import type { FridgeQueryStateValue } from "../state";
import { recipeInventoryFingerprint } from "./build-recipe-search.node";
import { isGroceryPlannerRequest } from "../services/grocery-planner.server";

export function createResolveRecipeTournamentNode(_deps: QueryGraphDependencies = {}) {
  return async function resolveRecipeTournamentNode(state: FridgeQueryStateValue) {
    const tournament = resolveRecipeTournament(
      state.tournamentCandidates,
      state.tournamentEvaluations,
      isGroceryPlannerRequest(state) ? 6 : RECIPE_TOURNAMENT_DISPLAY_LIMIT,
    );
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
    };
    const audit = state.recipeRetrievalAudit
      ? {
        ...state.recipeRetrievalAudit,
        tournamentCandidates: state.tournamentCandidates.length,
        terminalReason: tournament.recipes.length > 0 ? "tournament_complete" as const : "tournament_empty" as const,
      }
      : null;
    const recipeRetrievalWithAudit = audit
      ? { ...recipeRetrieval, audit }
      : recipeRetrieval;
    const shownRecipeIds = [...new Set([...state.shownRecipeIds, ...tournament.recipes.map((recipe) => recipe.id)])];
    const ingredientNames = Array.isArray(retrieval.inputIngredients)
      ? retrieval.inputIngredients.filter((value): value is string => typeof value === "string")
      : [];

    return {
      context: { ...state.context, recipeRetrieval: recipeRetrievalWithAudit },
      recipeRetrievalAudit: audit,
      recipeSearchExhausted: recipeRetrieval.exhausted,
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
