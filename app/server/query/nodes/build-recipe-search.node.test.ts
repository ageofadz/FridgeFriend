import type { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { describe, expect, it } from "vitest";

import { createBuildRecipeSearchNode } from "./build-recipe-search.node";
import type { FridgeQueryStateValue } from "../state";
import type { Inventory } from "../../scan/schemas/inventory";
import { PromptName } from "../../prompts/registry.server";

function state(): FridgeQueryStateValue {
  return {
    userId: "default-user",
    fridgeId: "fridge-1",
    imageId: "image-1",
    query: "Give me a fast high-protein dinner without peanuts",
    threadId: "thread-1",
    intent: "recipe",
    recipeSearch: null,
    lastRecipeSearch: null,
    recipeSearchSession: null,
    recipeSearchError: null,
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

function structuredModel(result: unknown) {
  return {
    withStructuredOutput: () => ({
      invoke: async () => result,
    }),
  } as unknown as ChatGoogleGenerativeAI;
}

function promptBundle() {
  return {
    queryRecipeSearch: {
      name: PromptName.QueryRecipeSearch,
      ref: "fridgefriend-query-recipe-search:latest",
      prompt: ChatPromptTemplate.fromMessages([
        ["human", "{{query}}"],
      ], { templateFormat: "mustache" }),
    },
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
      name: ingredient,
      label: ingredient,
      cat: "other",
      subcat: null,
      qty: {
        amount: 1,
        unit: "count",
        precision: "estimated",
        fillLevel: null,
      },
      pack: "unknown",
      loc: {
        status: "matched",
        zoneId: "zone-1",
        zoneType: "shelf",
        observations: [],
        confidence: 0.9,
      },
      conf: 0.9,
      src: [],
      attrs: {
        brand: null,
        variant: null,
        opened: null,
        expirationDate: null,
      },
      review: "inferred",
    })),
    zones: [],
  };
}

describe("build recipe search node", () => {
  it("stores parsed recipe constraints in graph state", async () => {
    const node = createBuildRecipeSearchNode({
      promptBundle: promptBundle() as never,
      listFoodComTags: () => ["30 minutes or less", "high protein"],
      recipeSearchModel: structuredModel({
        semanticQuery: "fast high-protein dinner",
        useAvailableIngredients: false,
        excludedIngredients: ["peanuts"],
        dietaryRestrictions: [],
        maxMinutes: 30,
        maxCalories: null,
        minProteinDailyValue: 25,
        preferredIngredients: [],
      }),
    });

    await expect(node(state())).resolves.toMatchObject({
      recipeSearch: {
        semanticQuery: "fast high-protein dinner",
        useAvailableIngredients: false,
        excludedIngredients: ["peanuts"],
        dietaryRestrictions: [],
        maxMinutes: 30,
        maxCalories: null,
        minProteinDailyValue: 25,
        preferredIngredients: [],
        preferredTags: ["30 minutes or less", "high protein"],
      },
      recipeSearchError: null,
    });
  });

  it("returns a structured state error for invalid model output", async () => {
    const node = createBuildRecipeSearchNode({
      promptBundle: promptBundle() as never,
      listFoodComTags: () => [],
      recipeSearchModel: structuredModel({
        semanticQuery: "",
      }),
    });

    const result = await node(state());

    expect(result.recipeSearch).toBeNull();
    expect(result.recipeSearchError).toContain(
      "Recipe search extraction returned invalid output",
    );
  });

  it("uses inventory-only retrieval for a generic fridge recipe request", async () => {
    const node = createBuildRecipeSearchNode({
      loadInventoryForImage: () => inventoryWithIngredients(["eggs", "tortillas"]),
      listFoodComTags: () => [],
    });
    const result = await node({
      ...state(),
      query: "What recipes can I make from the items in my fridge?",
    });

    expect(result).toMatchObject({
      recipeSearch: {
        semanticQuery: "What recipes can I make from the items in my fridge?\nAvailable ingredients: egg, tortilla",
        useAvailableIngredients: true,
        excludedIngredients: [],
        dietaryRestrictions: [],
        maxMinutes: null,
        maxCalories: null,
        minProteinDailyValue: null,
        preferredIngredients: ["egg", "tortilla"],
      },
      recipeSearchError: null,
    });
  });

  it("keeps an affordability request in the vector query", async () => {
    const node = createBuildRecipeSearchNode({
      loadInventoryForImage: () => inventoryWithIngredients(["eggs"]),
      listFoodComTags: () => ["inexpensive"],
    });
    const result = await node({
      ...state(),
      query: "Are there any affordable recipes I can make from the items in my fridge?",
    });

    expect(result.recipeSearch?.preferredTags).toEqual(["inexpensive"]);
  });

  it("reuses the active profile and excludes its shown recipes for a continuation", async () => {
    const prior = {
      semanticQuery: "weeknight dinners",
      useAvailableIngredients: true,
      excludedIngredients: [],
      dietaryRestrictions: [],
      maxMinutes: null,
      maxCalories: null,
      minProteinDailyValue: null,
      preferredIngredients: ["egg", "bread"],
      requiredTags: [],
      preferredTags: [],
      excludedTags: [],
      memoryPreferredTags: [],
      memoryExcludedTags: [],
      memoryGoalTags: [],
      continuation: false,
    };
    const node = createBuildRecipeSearchNode({
      loadInventoryForImage: () => inventoryWithIngredients(["egg", "bread"]),
    });
    const result = await node({
      ...state(),
      query: "more options please",
      context: {
        intentRouting: {
          recipeContinuation: true,
        },
      },
      recipeSearchSession: {
        profile: prior,
        inventoryFingerprint: "bread|egg",
        shownRecipeIds: ["shown-1", "shown-2"],
      },
    });

    expect(result).toMatchObject({
      recipeSearch: { ...prior, continuation: true },
      shownRecipeIds: ["shown-1", "shown-2"],
    });
  });
});
