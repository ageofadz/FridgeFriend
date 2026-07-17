import { describe, expect, it } from "vitest";

import {
  coverageForDemoRecipe,
  selectDemoRecipeCorpus,
} from "../../../../app/server/recipes/demo-corpus.server";
import type { Recipe } from "../../../../app/server/recipes/types";

function recipe(input: {
  id: string;
  name?: string;
  minutes?: number;
  tags?: string[];
  ingredients?: string[];
  steps?: string[];
}): Recipe {
  return {
    id: input.id,
    name: input.name ?? `Recipe ${input.id}`,
    description: "A complete recipe description.",
    ingredients: (input.ingredients ?? ["chicken breast", "spinach", "pasta"]).map((canonicalName) => ({
      rawName: canonicalName,
      canonicalName,
    })),
    tags: input.tags ?? ["main dish"],
    steps: input.steps ?? ["Saute ingredients.", "Simmer until ready."],
    minutes: input.minutes ?? 30,
    stepCount: 2,
    ingredientCount: input.ingredients?.length ?? 3,
    nutrition: {
      calories: 500,
      totalFatDailyValue: 5,
      sugarDailyValue: 2,
      sodiumDailyValue: 3,
      proteinDailyValue: 20,
      saturatedFatDailyValue: 1,
      carbohydratesDailyValue: 30,
    },
    rating: { average: 4.5, count: 10 },
  };
}

describe("demo recipe corpus", () => {
  it("derives inspectable coverage labels from recipe fields", () => {
    expect(coverageForDemoRecipe(recipe({
      id: "1",
      minutes: 15,
      tags: ["Breakfast", "Mexican", "Vegetarian", "Gluten-Free"],
      ingredients: ["chickpea", "tomato", "rice"],
      steps: ["Boil the rice.", "Saute the chickpeas."],
    }))).toEqual({
      course: ["breakfast"],
      cuisine: ["mexican"],
      dietary: ["gluten_free", "vegetarian"],
      ingredient: ["legume", "pasta_grain"],
      method: ["boil", "saute"],
      time: ["under_15"],
    });
  });

  it("selects a stable title-unique corpus and records coverage targets", () => {
    const recipes = [
      recipe({ id: "1", name: "Quick Pasta", tags: ["main dish", "Italian"], ingredients: ["pasta", "tomato", "chicken breast"] }),
      recipe({ id: "2", name: "Quick Pasta", tags: ["main dish", "Italian"], ingredients: ["pasta", "tomato", "chicken breast"] }),
      recipe({ id: "3", name: "Morning Beans", minutes: 15, tags: ["breakfast", "Mexican", "vegetarian"], ingredients: ["chickpea", "tomato", "rice"] }),
      recipe({ id: "4", name: "Thai Shrimp", minutes: 25, tags: ["main dish", "Thai"], ingredients: ["shrimp", "rice", "spinach"] }),
      recipe({ id: "5", name: "Greek Salad", minutes: 20, tags: ["salad", "Greek", "vegetarian"], ingredients: ["tomato", "olive", "chickpea"] }),
    ];

    const first = selectDemoRecipeCorpus(recipes, { count: 4, seed: "fixed" });
    const second = selectDemoRecipeCorpus(recipes, { count: 4, seed: "fixed" });

    expect(first).toEqual(second);
    expect(first.recipes.map((entry) => entry.recipe.name)).toHaveLength(new Set(first.recipes.map((entry) => entry.recipe.name)).size);
    expect(first.coverage.every((record) => record.selected >= record.target)).toBe(true);
  });

  it("fails when the requested corpus cannot contain enough unique recipe titles", () => {
    expect(() => selectDemoRecipeCorpus([
      recipe({ id: "1", name: "Repeated title" }),
      recipe({ id: "2", name: "Repeated title" }),
    ], { count: 2 })).toThrow("selected 1 unique recipe titles; requested 2");
  });
});
