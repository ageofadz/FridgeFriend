import { describe, expect, it } from "vitest";

import type { Recipe } from "../../../../../app/server/recipes/types";
import { rankRecipeCandidates } from "../../../../../app/server/query/services/recipe-retrieval.server";

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
  semanticQueryWithoutInventory: "quick chicken dinner",
  vectorCandidateLimit: 50,
  correctiveAttempt: false,
  plan: { userFacets: [], userTags: [], memoryTags: [], inventoryIngredients: [] },
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

  it("orders primary intent candidates before related-category candidates when both are required", () => {
    const primaryOne = recipe({
      id: "primary-one",
      name: "Snack One",
      ingredients: [{ rawName: "egg", canonicalName: "egg" }, { rawName: "cocoa", canonicalName: "cocoa" }],
    });
    const primaryTwo = recipe({
      id: "primary-two",
      name: "Snack Two",
      ingredients: [{ rawName: "egg", canonicalName: "egg" }, { rawName: "sugar", canonicalName: "sugar" }],
    });
    const related = recipe({
      id: "related",
      name: "Chocolate Dessert",
      ingredients: [{ rawName: "egg", canonicalName: "egg" }, { rawName: "flour", canonicalName: "flour" }],
    });

    const result = rankRecipeCandidates({
      candidates: [
        { recipeId: "primary-one", semanticScore: 0.4, intentTier: "primary" },
        { recipeId: "primary-two", semanticScore: 0.3, intentTier: "primary" },
        { recipeId: "related", semanticScore: 0.99, intentTier: "related" },
      ],
      recipes: [primaryOne, primaryTwo, related],
      search: {
        ...search,
        intent: { specific: true, relatedSemanticQuery: "chocolate desserts" },
      },
      availableIngredients: [{ name: "egg", expirationDate: null }],
      dietaryRestrictions: [],
      minimumPrimaryIntentResults: 3,
      minMissingIngredients: 1,
      maxMissingIngredients: 3,
    });

    expect(result.recipes.map((candidate) => candidate.id)).toEqual(["primary-one", "primary-two", "related"]);
    expect(result.recipes.map((candidate) => candidate.intentTier)).toEqual(["primary", "primary", "related"]);
  });

  it("uses explicitly mentioned ingredients as ranking signals instead of hard filters", () => {
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
    expect(result.recipes.map((candidate) => candidate.id)).toEqual(["jam", "eggs", "berry"]);
    expect(result.recipes[0]).toMatchObject({
      matchedIngredients: ["blackberry jam"],
      missingIngredients: ["flour", "butter"],
    });
  });

  it("ranks one of several requested ingredient options above unrelated candidates", () => {
    const eggDessert = recipe({
      id: "egg-dessert",
      name: "Easy Chocolate Dessert",
      ingredients: [
        { rawName: "eggs", canonicalName: "egg" },
        { rawName: "cocoa powder", canonicalName: "cocoa" },
        { rawName: "sugar", canonicalName: "sugar" },
      ],
    });
    const unrelatedDessert = recipe({
      id: "unrelated-dessert",
      name: "Chocolate Candy",
      ingredients: [
        { rawName: "chocolate chips", canonicalName: "chocolate chip" },
        { rawName: "condensed milk", canonicalName: "condensed milk" },
      ],
    });

    const result = rankRecipeCandidates({
      candidates: [
        { recipeId: "egg-dessert", semanticScore: 0.8, ingredientScore: 0.25, matchedInventoryIngredients: ["egg"] },
        { recipeId: "unrelated-dessert", semanticScore: 0.99 },
      ],
      recipes: [eggDessert, unrelatedDessert],
      search: {
        ...search,
        semanticQuery: "easy dessert recipes using egg lemon yogurt or whipped topping",
        preferredIngredients: ["egg", "lemon", "yogurt", "whipped topping"],
      },
      availableIngredients: [
        { name: "egg", expirationDate: null },
        { name: "lemon", expirationDate: null },
        { name: "yogurt", expirationDate: null },
        { name: "whipped topping", expirationDate: null },
      ],
      dietaryRestrictions: [],
      dietaryPreferences: [],
      activeGoals: [],
    });

    expect(result.noMatches).toBe(false);
    expect(result.recipes.map((candidate) => candidate.id)).toEqual(["egg-dessert", "unrelated-dessert"]);
  });

  it("keeps low-coverage named dish recipes and discloses their gaps", () => {
    const snackBites = recipe({
      id: "snack-bites",
      name: "Oat Snack Bites",
      ingredients: [
        { rawName: "cake mix", canonicalName: "cake mix" },
        { rawName: "vegetable oil", canonicalName: "vegetable oil" },
        { rawName: "eggs", canonicalName: "egg" },
        { rawName: "confectioners sugar", canonicalName: "confectioner sugar" },
      ],
    });
    const cocoaPudding = recipe({
      id: "cocoa-pudding",
      name: "Cocoa Pudding Cake",
      ingredients: [
        { rawName: "flour", canonicalName: "flour" },
        { rawName: "cocoa", canonicalName: "cocoa" },
        { rawName: "sugar", canonicalName: "sugar" },
        { rawName: "milk", canonicalName: "milk" },
        { rawName: "butter", canonicalName: "butter" },
        { rawName: "whipped topping", canonicalName: "whipped topping" },
      ],
    });

    const result = rankRecipeCandidates({
      candidates: [
        { recipeId: "snack-bites", semanticScore: 0.8, intentTier: "primary", ingredientScore: 1 / 7, matchedInventoryIngredients: ["egg"] },
        { recipeId: "cocoa-pudding", semanticScore: 0.95, intentTier: "primary", ingredientScore: 1 / 7, matchedInventoryIngredients: ["whipped topping"] },
      ],
      recipes: [snackBites, cocoaPudding],
      search: {
        ...search,
        semanticQuery: "easy snack recipes",
        intent: { specific: true, relatedSemanticQuery: null },
        useAvailableIngredients: false,
        preferredIngredients: [],
      },
      availableIngredients: [
        { name: "egg", expirationDate: null },
        { name: "yogurt", expirationDate: null },
        { name: "cheese", expirationDate: null },
        { name: "lemon", expirationDate: null },
        { name: "jam", expirationDate: null },
        { name: "whipped topping", expirationDate: null },
        { name: "fresh produce", expirationDate: null },
      ],
      dietaryRestrictions: [],
      dietaryPreferences: [],
      activeGoals: [],
    });

    expect(result.noMatches).toBe(false);
    expect(result.recipes.map((candidate) => candidate.id)).toEqual(["snack-bites", "cocoa-pudding"]);
    expect(result.recipes[0]).toMatchObject({
      matchedIngredients: ["egg"],
      missingIngredients: ["cake mix", "vegetable oil", "confectioner sugar"],
    });
    expect(result.recipes[1]).toMatchObject({
      matchedIngredients: ["whipped topping"],
      missingIngredients: ["flour", "cocoa", "sugar", "milk", "butter"],
    });
  });
});

describe("inventory recipe ranking", () => {
  it("admits low-coverage inventory matches into the tournament intake", () => {
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
    expect(result.recipes.map((candidate) => candidate.eligibilityBand)).toEqual(["strict", "strict"]);
    expect(result.exhausted).toBe(true);
  });

  it("admits one-match recipes and discloses their missing ingredients", () => {
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

    expect(result.recipes.map((candidate) => candidate.id)).toEqual(["incidental", "practical"]);
    expect(result.recipes.find((candidate) => candidate.id === "practical")).toMatchObject({
      matchedIngredients: ["greek yogurt", "strawberry"],
      missingIngredients: ["honey", "walnut"],
    });
    expect(result.recipes.find((candidate) => candidate.id === "incidental")).toMatchObject({
      matchedIngredients: ["egg", "carrot"],
      missingIngredients: ["chicken broth", "celery", "onion", "rice", "lemon juice"],
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

describe("recipe retrieval audit", () => {
  it("records hard-constraint rejections separately from retrieval misses", () => {
    const result = rankRecipeCandidates({
      candidates: [{ recipeId: "restricted", semanticScore: 0.9 }],
      recipes: [recipe({
        id: "restricted",
        name: "Standard Dinner",
        ingredients: [{ rawName: "chicken", canonicalName: "chicken" }],
        tags: [],
      })],
      search: { ...search, dietaryRestrictions: ["vegan"] },
      availableIngredients: [],
      dietaryRestrictions: [],
    });

    expect(result).toMatchObject({
      noMatches: true,
      audit: {
        hardFilterRejections: 1,
        coverageRankedCandidates: 0,
        tournamentCandidates: 0,
        terminalReason: "hard_constraints_rejected",
      },
    });
  });

  it("records an inventory coverage rejection when no verified ingredient matches", () => {
    const result = rankRecipeCandidates({
      candidates: [{ recipeId: "unmatched", semanticScore: 0.9 }],
      recipes: [recipe({
        id: "unmatched",
        name: "Unmatched Dinner",
        ingredients: [{ rawName: "fish", canonicalName: "fish" }],
      })],
      search: { ...search, useAvailableIngredients: true },
      availableIngredients: [{ name: "egg", expirationDate: null }],
      dietaryRestrictions: [],
    });

    expect(result).toMatchObject({
      noMatches: true,
      audit: {
        hardFilterRejections: 0,
        coverageRankedCandidates: 0,
        tournamentCandidates: 0,
        terminalReason: "coverage_rejected",
      },
    });
  });
});
