import type { QueryGraphDependencies } from "../../query/schemas/query";
import type { QueryFixtures } from "../schemas/query-eval-case";

/**
 * Pure in-memory recipe retrieval dependencies fed entirely from case
 * fixtures. Retrieval is read-only, so nothing is recorded on the
 * side-effect log. Mirrors the legacy eval wiring: semantic search returns
 * the fixture candidates, tag/ingredient lookups return the corresponding
 * candidate fixtures, and pantry completion candidates come from the
 * ingredient candidates that carry a missingIngredientCount.
 */
export function createFixtureRecipeAdapter(fixtures: {
  recipes: QueryFixtures["recipes"];
  recipeCandidates: QueryFixtures["recipeCandidates"];
  recipeTagCandidates: QueryFixtures["recipeTagCandidates"];
  recipeIngredientCandidates: QueryFixtures["recipeIngredientCandidates"];
}): Pick<
  QueryGraphDependencies,
  | "searchRecipeCandidates"
  | "getRecipesByIds"
  | "listFoodComTags"
  | "getRecipeCandidatesByTags"
  | "getRecipeCandidatesByIngredients"
  | "getPantryCompletionRecipeCandidates"
> {
  const tags = [
    ...new Set(
      fixtures.recipes.flatMap((recipe) =>
        Array.isArray(recipe.tags)
          ? recipe.tags.filter((tag): tag is string => typeof tag === "string")
          : [],
      ),
    ),
  ];

  return {
    searchRecipeCandidates: async () => fixtures.recipeCandidates as never,
    getRecipesByIds: (recipeIds) =>
      fixtures.recipes.filter((recipe) => recipeIds.includes(recipe.id)) as never,
    listFoodComTags: () => tags,
    getRecipeCandidatesByTags: () => fixtures.recipeTagCandidates as never,
    getRecipeCandidatesByIngredients: () => fixtures.recipeIngredientCandidates as never,
    getPantryCompletionRecipeCandidates: () =>
      fixtures.recipeIngredientCandidates.filter(
        (candidate) => typeof candidate.missingIngredientCount === "number",
      ) as never,
  };
}
