import { describe, expect, it } from "vitest";

import {
  buildRecipeSearchPlan,
  compileRecipeSearch,
} from "../../../../../app/server/query/services/recipe-search-plan.server";

describe("recipe search plan", () => {
  it("keeps every normalized inventory ingredient in a broad vector query", () => {
    const plan = buildRecipeSearchPlan({
      facets: [],
      userTags: [],
      memoryTags: [],
      availableIngredients: [
        "egg", "carrot", "rice", "bread", "feta", "gochujang", "chili crisp", "yogurt", "ketchup", "oil",
      ].map((name) => ({ name, expirationDate: null })),
    });

    const search = compileRecipeSearch({ plan, specific: false });

    expect(plan.inventoryIngredients).toEqual([
      "bread", "carrot", "chili crisp", "egg", "feta", "gochujang", "ketchup", "oil", "rice", "yogurt",
    ]);
    expect(search.semanticQuery).toBe(
      "recipe using bread carrot chili crisp egg feta gochujang ketchup oil rice yogurt",
    );
  });
});
