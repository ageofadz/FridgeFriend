import { describe, expect, it } from "vitest";

import { mergePantryCompletionItems } from "../../../app/components/AgentWorkspace";

describe("smart pantry completion grocery-list merge", () => {
  it("merges duplicate ingredients while preserving an existing grocery-list aisle and edits", () => {
    const merged = mergePantryCompletionItems({
      recipes: [],
      items: [{
        ingredient: "Garlic",
        aisle: "dry_goods",
        recipeIds: ["existing"],
        recipeNames: ["Existing recipe"],
      }],
    }, [{
      ingredient: "garlic",
      aisle: "produce",
      recipeIds: ["one", "existing"],
      recipeNames: ["Recipe one", "Existing recipe"],
      supportingRecipeCount: 2,
    }, {
      ingredient: "ginger",
      aisle: "produce",
      recipeIds: ["two"],
      recipeNames: ["Recipe two"],
      supportingRecipeCount: 1,
    }]);

    expect(merged.items).toEqual([
      {
        ingredient: "Garlic",
        aisle: "dry_goods",
        recipeIds: ["existing", "one"],
        recipeNames: ["Existing recipe", "Recipe one"],
      },
      {
        ingredient: "ginger",
        aisle: "produce",
        recipeIds: ["two"],
        recipeNames: ["Recipe two"],
      },
    ]);
  });
});
