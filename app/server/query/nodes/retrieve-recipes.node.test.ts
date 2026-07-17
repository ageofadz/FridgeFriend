import { describe, expect, it } from "vitest";

import type { Recipe } from "../../recipes/types";
import type { Inventory } from "../../scan/schemas/inventory";
import {
  createRetrieveRecipesNode,
  mergeRecipeCandidateSources,
} from "./retrieve-recipes.node";
import type { FridgeQueryStateValue } from "../state";

function baseState(): FridgeQueryStateValue {
  return {
    userId: "default-user",
    fridgeId: "fridge-1",
    imageId: "image-1",
    query: "What can I cook?",
    threadId: "thread-1",
    intent: "recipe",
    recipeSearch: {
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
    },
    recipeSearchError: null,
    lastRecipeSearch: null,
    recipeSearchSession: null,
    recipeClarification: null,
    shownRecipeIds: [],
    recipeRetrievalAttempt: 0,
    recipeRewriteCount: 0,
    recipeRetrievalGrade: null,
    tournamentCandidates: [],
    tournamentCandidate: null,
    tournamentEvaluations: [],
    memoryCandidates: [],
    memoryValidations: [],
    memoryWriteResults: [],
    externalInventory: [],
    dietaryRestrictions: [],
    dietaryPreferences: [],
    activeGoals: [],
    semanticMemories: [],
    visualEvidence: [],
    context: {},
    answer: null,
  };
}

function stateWithInventory(): FridgeQueryStateValue {
  return {
    ...baseState(),
  };
}

function inventoryWithIngredients(ingredients: string[]): Inventory {
  return {
    id: "inventory-1",
    fridgeId: "fridge-1",
    scanId: "scan-1",
    source: "mocked-vision",
    model: "test-model",
    createdAt: "2026-07-16T00:00:00.000Z",
    items: ingredients.map((ingredient, index) => ({
      id: `item-${index + 1}`,
      label: ingredient,
      name: ingredient,
      cat: ingredient === "chicken" ? "meat" : "other",
      subcat: null,
      qty: {
        amount: 1,
        unit: "package",
        precision: "estimated",
        fillLevel: null,
      },
      pack: "tray",
      loc: {
        status: "matched",
        zoneType: "shelf",
        zoneId: "zone-1",
        observations: [],
        confidence: 0.9,
      },
      attrs: {
        brand: null,
        variant: null,
        opened: null,
        expirationDate: null,
      },
      conf: 0.9,
      src: [],
      review: "inferred",
    })),
    zones: [],
  };
}

function inventoryWithRecipeItems(items: Array<{
  name: string;
  subcat: string | null;
  cat?: Inventory["items"][number]["cat"];
  pack?: Inventory["items"][number]["pack"];
}>): Inventory {
  return {
    id: "inventory-1",
    fridgeId: "fridge-1",
    scanId: "scan-1",
    source: "mocked-vision",
    model: "test-model",
    createdAt: "2026-07-16T00:00:00.000Z",
    items: items.map((item, index) => ({
      id: `item-${index + 1}`,
      label: item.name,
      name: item.name,
      cat: item.cat ?? "other",
      subcat: item.subcat,
      qty: {
        amount: 1,
        unit: "package",
        precision: "estimated",
        fillLevel: null,
      },
      pack: item.pack ?? "unknown",
      loc: {
        status: "matched",
        zoneType: "shelf",
        zoneId: "zone-1",
        observations: [],
        confidence: 0.9,
      },
      attrs: {
        brand: null,
        variant: null,
        opened: null,
        expirationDate: null,
      },
      conf: 0.9,
      src: [],
      review: "inferred",
    })),
    zones: [],
  };
}

const chickenRecipe: Recipe = {
  id: "recipe-1",
  name: "Chicken Rice Bowl",
  description: "A quick chicken dinner.",
  ingredients: [
    { rawName: "chicken", canonicalName: "chicken" },
    { rawName: "rice", canonicalName: "rice" },
    { rawName: "soy sauce", canonicalName: "soy sauce" },
  ],
  tags: ["dinner"],
  steps: ["Cook chicken."],
  minutes: 20,
  stepCount: 1,
  ingredientCount: 3,
  nutrition: {
    calories: 400,
    totalFatDailyValue: null,
    sugarDailyValue: null,
    sodiumDailyValue: null,
    proteinDailyValue: 30,
    saturatedFatDailyValue: null,
    carbohydratesDailyValue: null,
  },
  rating: { average: 4.5, count: 50 },
};

describe("retrieve recipes node", () => {
  it("preserves semantic, tag, and ingredient evidence when merging candidates", () => {
    expect(mergeRecipeCandidateSources([
      [{ recipeId: "one", semanticScore: 0.8 }],
      [{ recipeId: "one", semanticScore: 0, tagScore: 1, matchedTags: ["inexpensive"] }],
      [{ recipeId: "one", semanticScore: 0, ingredientScore: 0.5, matchedInventoryIngredients: ["egg"] }],
    ])).toEqual([{
      recipeId: "one",
      semanticScore: 0.8,
      tagScore: 1,
      ingredientScore: 0.5,
      matchedTags: ["inexpensive"],
      matchedInventoryIngredients: ["egg"],
    }]);
  });

  it("loads local canonical recipes and attaches deterministic Food.com ranking", async () => {
    const node = createRetrieveRecipesNode({
      loadInventoryForImage: () => inventoryWithIngredients(["chicken"]),
      searchRecipeCandidates: async () => [{
        recipeId: "recipe-1",
        semanticScore: 0.9,
      }],
      getRecipesByIds: () => [chickenRecipe],
    });

    const result = await node(stateWithInventory());

    expect(result.context.recipeRetrieval).toMatchObject({
      source: "food_com",
      inputIngredients: ["chicken"],
      semanticQuery: "quick chicken dinner",
      noMatches: false,
      recipes: [
        {
          id: "recipe-1",
          matchedIngredients: ["chicken"],
          missingIngredients: ["rice", "soy sauce"],
        },
      ],
    });
  });

  it("returns a structured result when recipe-search extraction was invalid", async () => {
    const node = createRetrieveRecipesNode({
      loadInventoryForImage: () => inventoryWithIngredients(["chicken"]),
    });
    const result = await node({
      ...baseState(),
      recipeSearch: null,
      recipeSearchError: "Recipe search extraction returned invalid output: semanticQuery is required",
    });

    expect(result.context.recipeRetrieval).toMatchObject({
      source: "food_com",
      noMatches: true,
      reason: "Recipe search extraction returned invalid output: semanticQuery is required",
    });
  });

  it("uses one prompt-first semantic query for inventory-only requests", async () => {
    const queries: string[] = [];
    const node = createRetrieveRecipesNode({
      loadInventoryForImage: () => inventoryWithIngredients(["chicken"]),
      searchRecipeCandidates: async ({ query }) => {
        queries.push(query);
        return [{ recipeId: "recipe-1", semanticScore: 0.9 }];
      },
      getRecipesByIds: () => [
        {
          ...chickenRecipe,
          ingredients: [
            { rawName: "chicken", canonicalName: "chicken" },
            { rawName: "eggs", canonicalName: "egg" },
          ],
        },
      ],
    });

    await node({
      ...stateWithInventory(),
      recipeSearch: {
        semanticQuery: "recipes using available fridge ingredients",
        useAvailableIngredients: true,
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
      },
      externalInventory: [
        {
          id: "external-1",
          fridgeId: "fridge-1",
          name: "Eggs",
          canonicalName: "egg",
          storageLocation: "pantry",
          quantity: null,
          status: "available",
          confidence: 1,
          source: "user_explicit",
          notes: null,
          lastConfirmedAt: "2026-07-17T00:00:00.000Z",
          createdAt: "2026-07-17T00:00:00.000Z",
          updatedAt: "2026-07-17T00:00:00.000Z",
        },
      ],
    });

    expect(queries).toEqual(["recipes using available fridge ingredients"]);
  });

  it("uses general recipe ingredients instead of raw package labels", async () => {
    let searchedIngredients: string[] = [];
    const lemonRecipe: Recipe = {
      ...chickenRecipe,
      id: "recipe-generalized",
      name: "Lemon Cream Cheese Muffins",
      ingredients: [
        { rawName: "butter", canonicalName: "butter" },
        { rawName: "cream cheese", canonicalName: "cream cheese" },
        { rawName: "eggs", canonicalName: "egg" },
        { rawName: "lemon", canonicalName: "lemon" },
        { rawName: "lemon juice", canonicalName: "lemon juice" },
        { rawName: "flour", canonicalName: "flour" },
        { rawName: "sugar", canonicalName: "sugar" },
        { rawName: "baking powder", canonicalName: "baking powder" },
        { rawName: "milk", canonicalName: "milk" },
        { rawName: "vanilla", canonicalName: "vanilla" },
      ],
    };
    const node = createRetrieveRecipesNode({
      loadInventoryForImage: () => inventoryWithRecipeItems([
        { name: "mt olive pickle jar", subcat: "pickle", cat: "condiment", pack: "jar" },
        { name: "yogurt cup", subcat: "yogurt", cat: "dairy", pack: "container" },
        { name: "egg carton", subcat: "egg", cat: "eggs", pack: "carton" },
        { name: "cream cheese container", subcat: "cream cheese", cat: "dairy", pack: "container" },
        { name: "butter package", subcat: "butter", cat: "dairy" },
        { name: "lemon", subcat: "lemon", cat: "produce", pack: "loose" },
        { name: "tortilla package", subcat: "tortilla" },
        { name: "green bottle", subcat: null, pack: "bottle" },
      ]),
      searchRecipeCandidates: async () => [],
      getRecipeCandidatesByTags: () => [],
      getRecipeCandidatesByIngredients: (input) => {
        searchedIngredients = input.ingredients;
        return [{
          recipeId: "recipe-generalized",
          matchedIngredients: ["butter", "cream cheese", "egg", "lemon"],
          ingredientScore: 4 / input.ingredients.length,
        }];
      },
      getRecipesByIds: () => [lemonRecipe],
    });

    const result = await node({
      ...stateWithInventory(),
      recipeSearch: {
        semanticQuery: "recipes using available fridge ingredients",
        useAvailableIngredients: true,
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
      },
    });

    expect(searchedIngredients).toEqual([
      "pickle",
      "yogurt",
      "egg",
      "cream cheese",
      "butter",
      "lemon",
      "tortilla",
    ]);
    expect(searchedIngredients).not.toContain("mt olive pickle jar");
    expect(searchedIngredients).not.toContain("yogurt cup");
    expect(searchedIngredients).not.toContain("green bottle");
    expect(result.context.recipeRetrieval).toMatchObject({
      noMatches: false,
      inputIngredients: searchedIngredients,
      recipes: [{ id: "recipe-generalized" }],
    });
  });

  it("searches exact recipe ingredients requested by the user", async () => {
    let searchedIngredients: string[] = [];
    const blackberryJamRecipe: Recipe = {
      ...chickenRecipe,
      id: "blackberry-jam-bars",
      name: "Blackberry Jam Bars",
      ingredients: [
        { rawName: "blackberry jam", canonicalName: "blackberry jam" },
        { rawName: "butter", canonicalName: "butter" },
        { rawName: "flour", canonicalName: "flour" },
      ],
    };
    const node = createRetrieveRecipesNode({
      loadInventoryForImage: () => inventoryWithIngredients(["egg", "tortilla"]),
      searchRecipeCandidates: async () => [{ recipeId: "blackberry-jam-bars", semanticScore: 0.7 }],
      getRecipeCandidatesByTags: () => [],
      getRecipeCandidatesByIngredients: (input) => {
        searchedIngredients = input.ingredients;
        return [{
          recipeId: "blackberry-jam-bars",
          matchedIngredients: ["blackberry jam"],
          ingredientScore: 1 / input.ingredients.length,
        }];
      },
      getRecipesByIds: () => [blackberryJamRecipe],
    });

    const result = await node({
      ...stateWithInventory(),
      query: "Show me recipes that use the blackberry jam",
      recipeSearch: {
        semanticQuery: "recipes that use blackberry jam",
        useAvailableIngredients: false,
        excludedIngredients: [],
        dietaryRestrictions: [],
        maxMinutes: null,
        maxCalories: null,
        minProteinDailyValue: null,
        preferredIngredients: ["blackberry jam"],
        requiredTags: [],
        preferredTags: [],
        excludedTags: [],
        memoryPreferredTags: [],
        memoryExcludedTags: [],
        memoryGoalTags: [],
        continuation: false,
      },
    });

    expect(searchedIngredients).toContain("blackberry jam");
    expect(result.context.recipeRetrieval).toMatchObject({
      noMatches: false,
      recipes: [{
        id: "blackberry-jam-bars",
        missingIngredients: ["blackberry jam", "butter", "flour"],
      }],
    });
  });

  it("excludes recipes already shown when the user asks for other recipes", async () => {
    const candidateLimits: number[] = [];
    const loadedRecipeIds: string[][] = [];
    const node = createRetrieveRecipesNode({
      loadInventoryForImage: () => inventoryWithIngredients(["chicken"]),
      searchRecipeCandidates: async ({ limit }) => {
        candidateLimits.push(limit);
        return [
          { recipeId: "shown-recipe", semanticScore: 0.95 },
          { recipeId: "new-recipe", semanticScore: 0.8 },
        ];
      },
      getRecipeCandidatesByTags: () => [],
      getRecipeCandidatesByIngredients: () => [],
      getRecipesByIds: (recipeIds) => {
        loadedRecipeIds.push(recipeIds);
        return [{
          ...chickenRecipe,
          id: "new-recipe",
          ingredients: [
            { rawName: "chicken", canonicalName: "chicken" },
            { rawName: "eggs", canonicalName: "egg" },
          ],
        }];
      },
    });

    const result = await node({
      ...stateWithInventory(),
      query: "What other recipes can I make from the items in my fridge?",
      shownRecipeIds: ["shown-recipe"],
      recipeSearch: {
        semanticQuery: "recipes using available fridge ingredients",
        useAvailableIngredients: true,
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
        continuation: true,
      },
      externalInventory: [
        {
          id: "external-egg",
          fridgeId: "fridge-1",
          name: "Eggs",
          canonicalName: "egg",
          storageLocation: "pantry",
          quantity: null,
          status: "available",
          confidence: 1,
          source: "user_explicit",
          notes: null,
          lastConfirmedAt: "2026-07-17T00:00:00.000Z",
          createdAt: "2026-07-17T00:00:00.000Z",
          updatedAt: "2026-07-17T00:00:00.000Z",
        },
      ],
    });

    expect(candidateLimits).toEqual([51]);
    expect(loadedRecipeIds).toEqual([["new-recipe"]]);
    expect(result.context.recipeRetrieval).toMatchObject({
      recipes: [{ id: "new-recipe" }],
    });
    expect(result.tournamentCandidates.map((recipe) => recipe.id)).toEqual(["new-recipe"]);
  });
});
