import { describe, expect, it } from "vitest";

import type { Recipe } from "../../recipes/types";
import { rankRecipeCandidates } from "./recipe-retrieval.server";

function recipe(input: Partial<Recipe> & Pick<Recipe, "id" | "name">): Recipe {
  return {
    id: input.id,
    name: input.name,
    description: input.description ?? null,
    ingredients: input.ingredients ?? [],
    tags: input.tags ?? [],
    steps: input.steps ?? [],
    minutes: input.minutes ?? 20,
    stepCount: input.stepCount ?? 1,
    ingredientCount: input.ingredientCount ?? input.ingredients?.length ?? 0,
    nutrition: input.nutrition ?? {
      calories: 300,
      totalFatDailyValue: null,
      sugarDailyValue: null,
      sodiumDailyValue: null,
      proteinDailyValue: 25,
      saturatedFatDailyValue: null,
      carbohydratesDailyValue: null,
    },
    rating: input.rating ?? { average: 4, count: 20 },
  };
}

const search = {
  semanticQuery: "quick chicken dinner",
  useAvailableIngredients: false,
  excludedIngredients: [],
  dietaryRestrictions: [],
  maxMinutes: null,
  maxCalories: null,
  minProteinDailyValue: null,
  preferredIngredients: [],
  requiredTags: [],
  preferredTags: [],
  excludedTags: [],
  memoryPreferredTags: [],
  memoryExcludedTags: [],
  memoryGoalTags: [],
  continuation: false,
};

describe("rankRecipeCandidates", () => {
  it("hard-filters excluded ingredients and ranks available ingredients", () => {
    const chickenRice = recipe({
      id: "1",
      name: "Chicken Rice",
      ingredients: [
        { rawName: "chicken breast", canonicalName: "chicken breast" },
        { rawName: "rice", canonicalName: "rice" },
      ],
      tags: ["30-minutes-or-less"],
    });
    const peanutNoodles = recipe({
      id: "2",
      name: "Peanut Noodles",
      ingredients: [
        { rawName: "peanut butter", canonicalName: "peanut butter" },
        { rawName: "noodles", canonicalName: "noodle" },
      ],
    });

    const result = rankRecipeCandidates({
      candidates: [
        { recipeId: "1", semanticScore: 0.8 },
        { recipeId: "2", semanticScore: 0.95 },
      ],
      recipes: [chickenRice, peanutNoodles],
      search: {
        ...search,
        excludedIngredients: ["peanut"],
      },
      availableIngredients: [
        { name: "Chicken breast", expirationDate: "2026-07-20" },
        { name: "rice", expirationDate: null },
      ],
      dietaryRestrictions: [],
      dietaryPreferences: [],
      activeGoals: [],
      now: new Date("2026-07-17T00:00:00.000Z"),
    });

    expect(result).toMatchObject({
      source: "food_com",
      noMatches: false,
      inputIngredients: ["chicken breast", "rice"],
    });
    expect(result.recipes).toHaveLength(1);
    expect(result.recipes[0]).toMatchObject({
      id: "1",
      matchedIngredients: ["chicken breast", "rice"],
      missingIngredients: [],
      ingredientCoverage: 1,
      expiringCoverage: 1,
    });
  });

  it("enforces time, calories, protein, and dietary-tag constraints", () => {
    const allowed = recipe({
      id: "1",
      name: "Fast Vegan Bowl",
      minutes: 25,
      tags: ["vegan"],
      nutrition: {
        calories: 400,
        totalFatDailyValue: null,
        sugarDailyValue: null,
        sodiumDailyValue: null,
        proteinDailyValue: 30,
        saturatedFatDailyValue: null,
        carbohydratesDailyValue: null,
      },
    });
    const excluded = recipe({
      id: "2",
      name: "Slow Vegan Bowl",
      minutes: 45,
      tags: ["vegan"],
    });

    const result = rankRecipeCandidates({
      candidates: [
        { recipeId: "1", semanticScore: 0.5 },
        { recipeId: "2", semanticScore: 0.9 },
      ],
      recipes: [allowed, excluded],
      search: {
        ...search,
        dietaryRestrictions: ["vegan"],
        maxMinutes: 30,
        maxCalories: 500,
        minProteinDailyValue: 25,
      },
      availableIngredients: [],
      dietaryRestrictions: [],
      dietaryPreferences: [],
      activeGoals: [],
    });

    expect(result.recipes.map((candidate) => candidate.id)).toEqual(["1"]);
  });

  it("requires explicitly requested recipe ingredients", () => {
    const blackberryJamRecipe = recipe({
      id: "jam",
      name: "Blackberry Jam Bars",
      ingredients: [
        { rawName: "blackberry jam", canonicalName: "blackberry jam" },
        { rawName: "flour", canonicalName: "flour" },
        { rawName: "butter", canonicalName: "butter" },
      ],
    });
    const blackberryRecipe = recipe({
      id: "berry",
      name: "Blackberry Sauce",
      ingredients: [
        { rawName: "blackberries", canonicalName: "blackberry" },
        { rawName: "sugar", canonicalName: "sugar" },
      ],
    });
    const unrelatedRecipe = recipe({
      id: "eggs",
      name: "Tortillas and Eggs",
      ingredients: [
        { rawName: "eggs", canonicalName: "egg" },
        { rawName: "tortillas", canonicalName: "tortilla" },
      ],
    });

    const result = rankRecipeCandidates({
      candidates: [
        { recipeId: "jam", semanticScore: 0.5, ingredientScore: 1, matchedInventoryIngredients: ["blackberry jam"] },
        { recipeId: "berry", semanticScore: 0.99 },
        { recipeId: "eggs", semanticScore: 0.98 },
      ],
      recipes: [blackberryJamRecipe, blackberryRecipe, unrelatedRecipe],
      search: {
        ...search,
        semanticQuery: "recipes that use blackberry jam",
        preferredIngredients: ["blackberry jam"],
      },
      availableIngredients: [{ name: "blackberry jam", expirationDate: null }],
      dietaryRestrictions: [],
      dietaryPreferences: [],
      activeGoals: [],
    });

    expect(result.noMatches).toBe(false);
    expect(result.recipes.map((candidate) => candidate.id)).toEqual(["jam"]);
    expect(result.recipes[0]).toMatchObject({
      matchedIngredients: ["blackberry jam"],
      missingIngredients: ["flour", "butter"],
    });
  });
});

describe("inventory recipe ranking", () => {
  it("uses the relaxed band only after strict practical matches", () => {
    const strict = recipe({
      id: "strict",
      name: "Egg Cheese Toast",
      ingredients: [
        { rawName: "eggs", canonicalName: "egg" },
        { rawName: "cheese", canonicalName: "cheese" },
        { rawName: "bread", canonicalName: "bread" },
      ],
    });
    const relaxed = recipe({
      id: "relaxed",
      name: "Egg Vegetable Skillet",
      ingredients: [
        { rawName: "eggs", canonicalName: "egg" },
        { rawName: "cheese", canonicalName: "cheese" },
        { rawName: "spinach", canonicalName: "spinach" },
        { rawName: "onion", canonicalName: "onion" },
        { rawName: "tomatoes", canonicalName: "tomato" },
      ],
    });
    const result = rankRecipeCandidates({
      candidates: [
        { recipeId: "strict", semanticScore: 0.4 },
        { recipeId: "relaxed", semanticScore: 0.95 },
      ],
      recipes: [strict, relaxed],
      search: { ...search, useAvailableIngredients: true },
      availableIngredients: [
        { name: "egg", expirationDate: null },
        { name: "cheese", expirationDate: null },
        { name: "bread", expirationDate: null },
      ],
      dietaryRestrictions: [],
    });

    expect(result.recipes.map((candidate) => candidate.id)).toEqual(["strict", "relaxed"]);
    expect(result.recipes.map((candidate) => candidate.eligibilityBand)).toEqual(["strict", "relaxed"]);
    expect(result.exhausted).toBe(true);
  });

  it("keeps practical recipes and excludes recipes that only share an incidental term", () => {
    const practical = recipe({
      id: "practical",
      name: "Strawberry Greek Yogurt Bowl",
      ingredients: [
        { rawName: "Greek yogurt", canonicalName: "greek yogurt" },
        { rawName: "strawberries", canonicalName: "strawberry" },
        { rawName: "honey", canonicalName: "honey" },
        { rawName: "walnuts", canonicalName: "walnut" },
      ],
    });
    const incidental = recipe({
      id: "incidental",
      name: "Greek Lemon Egg Soup",
      ingredients: [
        { rawName: "eggs", canonicalName: "egg" },
        { rawName: "carrots", canonicalName: "carrot" },
        { rawName: "chicken broth", canonicalName: "chicken broth" },
        { rawName: "celery", canonicalName: "celery" },
        { rawName: "onion", canonicalName: "onion" },
        { rawName: "rice", canonicalName: "rice" },
        { rawName: "lemon juice", canonicalName: "lemon juice" },
      ],
    });

    const result = rankRecipeCandidates({
      candidates: [
        { recipeId: "practical", semanticScore: 0.3 },
        { recipeId: "incidental", semanticScore: 0.98 },
      ],
      recipes: [practical, incidental],
      search: {
        ...search,
        semanticQuery: "recipes using available fridge ingredients",
        useAvailableIngredients: true,
      },
      availableIngredients: [
        { name: "Greek Gods Greek Yogurt", brand: "Greek Gods", expirationDate: null },
        { name: "strawberries", expirationDate: null },
        { name: "carrots", expirationDate: null },
        { name: "eggs", expirationDate: null },
      ],
      dietaryRestrictions: [],
      dietaryPreferences: [],
      activeGoals: [],
    });

    expect(result.recipes).toHaveLength(1);
    expect(result.recipes[0]).toMatchObject({
      id: "practical",
      matchedIngredients: ["greek yogurt", "strawberry"],
      missingIngredients: ["honey", "walnut"],
    });
  });

  it("does not fabricate affordability from ingredient count", () => {
    const compact = recipe({
      id: "compact",
      name: "Egg and Cheese Toast",
      ingredients: [
        { rawName: "eggs", canonicalName: "egg" },
        { rawName: "bread", canonicalName: "bread" },
        { rawName: "cheese", canonicalName: "cheese" },
      ],
    });
    const elaborate = recipe({
      id: "elaborate",
      name: "Loaded Egg Toast",
      ingredients: [
        { rawName: "eggs", canonicalName: "egg" },
        { rawName: "bread", canonicalName: "bread" },
        { rawName: "cheese", canonicalName: "cheese" },
        { rawName: "tomatoes", canonicalName: "tomato" },
        { rawName: "onion", canonicalName: "onion" },
        { rawName: "spinach", canonicalName: "spinach" },
        { rawName: "beans", canonicalName: "bean" },
        { rawName: "avocado", canonicalName: "avocado" },
        { rawName: "cilantro", canonicalName: "cilantro" },
        { rawName: "lime", canonicalName: "lime" },
      ],
    });

    const result = rankRecipeCandidates({
      candidates: [
        { recipeId: "compact", semanticScore: 0.7 },
        { recipeId: "elaborate", semanticScore: 0.95 },
      ],
      recipes: [compact, elaborate],
      search,
      availableIngredients: [
        { name: "eggs", expirationDate: null },
        { name: "bread", expirationDate: null },
        { name: "cheese", expirationDate: null },
        { name: "tomatoes", expirationDate: null },
        { name: "onion", expirationDate: null },
        { name: "spinach", expirationDate: null },
        { name: "beans", expirationDate: null },
        { name: "avocado", expirationDate: null },
        { name: "cilantro", expirationDate: null },
        { name: "lime", expirationDate: null },
      ],
      dietaryRestrictions: [],
      dietaryPreferences: [],
      activeGoals: [],
    });

    expect(result.recipes.map((recipe) => recipe.id)).toEqual(["elaborate", "compact"]);
  });

  it("ranks recipes that use urgent ingredients above stronger semantic matches", () => {
    const urgent = recipe({
      id: "urgent",
      name: "Use the Spinach",
      ingredients: [{ rawName: "spinach", canonicalName: "spinach" }, { rawName: "egg", canonicalName: "egg" }],
    });
    const semantic = recipe({
      id: "semantic",
      name: "Egg Toast",
      ingredients: [
        { rawName: "egg", canonicalName: "egg" },
        { rawName: "bread", canonicalName: "bread" },
      ],
    });

    const result = rankRecipeCandidates({
      candidates: [
        { recipeId: "urgent", semanticScore: 0.5 },
        { recipeId: "semantic", semanticScore: 0.98 },
      ],
      recipes: [urgent, semantic],
      search: { ...search, useAvailableIngredients: true },
      availableIngredients: [
        { name: "spinach", expirationDate: null, wasteScore: 1 },
        { name: "egg", expirationDate: null, wasteScore: 0 },
        { name: "bread", expirationDate: null, wasteScore: 0 },
      ],
      dietaryRestrictions: [],
    });

    expect(result.recipes.map((candidate) => candidate.id)).toEqual(["urgent", "semantic"]);
    expect(result.recipes[0]).toMatchObject({
      usesSoonIngredients: ["spinach"],
      wasteReductionScore: 1,
    });
  });
});
