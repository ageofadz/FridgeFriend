import { describe, expect, it } from "vitest";

import {
  categorizeInventoryForRecipes,
  generalRecipeIngredientName,
} from "../../../../app/server/recipes/inventory-generalization";

describe("generalRecipeIngredientName", () => {
  it("maps labels ending in a known ingredient to that general ingredient", () => {
    expect(generalRecipeIngredientName("Chobani Greek Yogurt")).toBe("greek yogurt");
    expect(generalRecipeIngredientName("carton of eggs")).toBe("egg");
    expect(generalRecipeIngredientName("Philadelphia Cream Cheese")).toBe("cream cheese");
  });

  it("strips packaging words before matching", () => {
    expect(generalRecipeIngredientName("milk carton")).toBe("milk");
    expect(generalRecipeIngredientName("jar of blackberry jam")).toBe("blackberry jam");
  });

  it("rejects labels made up entirely of packaging and color words", () => {
    expect(generalRecipeIngredientName("green bottle")).toBeNull();
    expect(generalRecipeIngredientName("red box")).toBeNull();
    expect(generalRecipeIngredientName("clear container")).toBeNull();
    expect(generalRecipeIngredientName("bag")).toBeNull();
    expect(generalRecipeIngredientName("")).toBeNull();
  });

  it("falls back to the packaging-stripped name for unknown real ingredients", () => {
    expect(generalRecipeIngredientName("orange juice bottle")).toBe("orange juice");
    expect(generalRecipeIngredientName("hot sauce")).toBe("hot sauce");
  });
});

describe("categorizeInventoryForRecipes", () => {
  it("categorizes recognized ingredients", () => {
    expect(categorizeInventoryForRecipes({ label: "Greek Yogurt cup", packaging: "container" })).toEqual({
      category: "dairy",
      recipeIngredient: "greek yogurt",
    });
  });

  it("returns no recipe ingredient for generic non-ingredient labels", () => {
    expect(categorizeInventoryForRecipes({ label: "green bottle", packaging: "bottle" })).toEqual({
      category: "other",
      recipeIngredient: null,
    });
  });
});
