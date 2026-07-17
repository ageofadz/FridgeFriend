import { compileCorrectiveRecipeSearch } from "../services/recipe-search-plan.server";
import type { QueryGraphDependencies } from "../schemas/query";
import type { FridgeQueryStateValue } from "../state";

export function createRewriteRecipeQueryNode(_deps: QueryGraphDependencies = {}) {
  return async function rewriteRecipeQueryNode(state: FridgeQueryStateValue) {
    if (!state.recipeSearch) {
      return {
        recipeSearchError: "Recipe corrective retrieval could not run because the validated recipe search plan is unavailable.",
        recipeRewriteCount: state.recipeRewriteCount + 1,
      };
    }

    if (state.recipeSearch.correctiveAttempt) {
      return {
        recipeSearchError: "Recipe corrective retrieval was already used for this validated search plan.",
        recipeRewriteCount: state.recipeRewriteCount + 1,
      };
    }

    return {
      recipeSearch: compileCorrectiveRecipeSearch(state.recipeSearch),
      recipeRewriteCount: state.recipeRewriteCount + 1,
      recipeSearchError: null,
    };
  };
}
