import type { FridgeFriendChatModel } from "../../../../../app/server/ai/chat-model.server";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { describe, expect, it } from "vitest";

import { createBuildRecipeSearchNode } from "../../../../../app/server/query/nodes/build-recipe-search.node";
import { PromptName } from "../../../../../app/server/prompts/registry.server";
import type { Inventory } from "../../../../../app/server/scan/schemas/inventory";
import type { FridgeQueryStateValue } from "../../../../../app/server/query/state";

function state(): FridgeQueryStateValue {
  return {
    userId: "default-user",
    fridgeId: "fridge-1",
    imageId: "image-1",
    query: "Give me a 30 minute high-protein dinner without peanuts",
    threadId: "thread-1",
    requestId: "",
    intent: "recipe",
    recipeSearch: null,
    lastRecipeSearch: null,
    recipeSearchSession: null,
    recipeSearchError: null,
    recipeClarification: null,
    shownRecipeIds: [],
    recipeSearchExhausted: false,
    recipeRewriteCount: 0,
    recipeRetrievalGrade: null,
    recipeRetrievalAudit: null,
    recipeCandidates: [],
    recipeInputIngredients: [],
    tournamentCandidates: [],
    tournamentCandidate: null,
    tournamentEvaluations: [],
    memoryCandidates: [],
    memoryValidations: [],
    memoryWriteResults: [],
    pendingSemanticMemories: [],
    indexedSemanticMemoryIds: [],
    completedOperationKeys: [],
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
  } as unknown as FridgeFriendChatModel;
}

function promptBundle() {
  return {
    queryRecipeSearch: {
      name: PromptName.QueryRecipeSearch,
      ref: "fridgefriend-query-recipe-search:pinned",
      prompt: ChatPromptTemplate.fromMessages([["human", "{{query}}"]], { templateFormat: "mustache" }),
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
      qty: { amount: 1, unit: "count", precision: "estimated", fillLevel: null },
      pack: "unknown",
      loc: { status: "matched", zoneId: "zone-1", zoneType: "shelf", observations: [], confidence: 0.9 },
      conf: 0.9,
      src: [],
      attrs: { brand: null, variant: null, opened: null, expirationDate: null },
      review: "inferred",
    })),
    zones: [],
  };
}

function interpretation(overrides: Record<string, unknown> = {}) {
  return {
    facets: [
      { kind: "meal", text: "dinner" },
      { kind: "flavor", text: "high-protein" },
    ],
    intent: { specific: true },
    useAvailableIngredients: false,
    excludedIngredients: ["peanuts"],
    dietaryRestrictions: [],
    maxMinutes: 30,
    maxCalories: null,
    minProteinDailyValue: null,
    preferredIngredients: [],
    requiredTags: [],
    preferredTags: ["high-protein"],
    excludedTags: [],
    ...overrides,
  };
}

describe("build recipe search node", () => {
  it("compiles grounded user spans and canonical inventory into a deterministic plan", async () => {
    const node = createBuildRecipeSearchNode({
      loadInventoryForImage: () => inventoryWithIngredients(["eggs", "tortillas"]),
      promptBundle: promptBundle() as never,
      listFoodComTags: () => ["30 minutes or less", "high protein"],
      recipeSearchModel: structuredModel(interpretation()),
    });

    await expect(node(state())).resolves.toMatchObject({
      recipeSearch: {
        semanticQuery: "recipe dinner high protein using egg tortilla",
        semanticQueryWithoutInventory: "recipe dinner high protein",
        vectorCandidateLimit: 50,
        correctiveAttempt: false,
        intent: { specific: true, relatedSemanticQuery: null },
        excludedIngredients: ["peanut"],
        maxMinutes: 30,
        requiredTags: [],
        preferredTags: ["high protein"],
        plan: {
          userTags: ["high protein"],
          inventoryIngredients: ["egg", "tortilla"],
        },
      },
      recipeSearchError: null,
    });
  });

  it("rejects model vocabulary that is not copied from the user request before retrieval", async () => {
    const node = createBuildRecipeSearchNode({
      promptBundle: promptBundle() as never,
      listFoodComTags: () => [],
      recipeSearchModel: structuredModel(interpretation({
        facets: [{ kind: "dish", text: "invented theme" }],
      })),
    });

    const result = await node(state());

    expect(result.recipeSearch).toBeNull();
    expect(result.recipeSearchError).toContain("not present in the user request");
    expect(result.recipeClarification).toContain("couldn't safely interpret");
  });

  it("uses generic inventory and saved taste tags as soft deterministic retrieval signals", async () => {
    const node = createBuildRecipeSearchNode({
      loadInventoryForImage: () => inventoryWithIngredients(["eggs", "tortillas"]),
      listFoodComTags: () => ["bright acidic"],
    });
    const result = await node({
      ...state(),
      query: "I like bright, acidic flavors. What can I make with the ingredients in my fridge?",
    });

    expect(result.recipeSearch).toMatchObject({
      semanticQuery: "recipe bright acidic using egg tortilla",
      requiredTags: [],
      preferredTags: ["bright acidic"],
      useAvailableIngredients: true,
    });
  });

  it("keeps a preference soft but applies an explicitly required indexed category as a hard constraint", async () => {
    const node = createBuildRecipeSearchNode({
      promptBundle: promptBundle() as never,
      listFoodComTags: () => ["healthy"],
      recipeSearchModel: structuredModel(interpretation({
        facets: [{ kind: "flavor", text: "healthy" }],
        excludedIngredients: [],
        maxMinutes: null,
        preferredTags: ["healthy"],
        requiredTags: ["healthy"],
      })),
    });
    const soft = await node({ ...state(), query: "Find healthy recipes." });
    const hard = await node({ ...state(), query: "Find recipes that must be healthy." });

    expect(soft.recipeSearch?.requiredTags).toEqual([]);
    expect(soft.recipeSearch?.preferredTags).toEqual(["healthy"]);
    expect(hard.recipeSearch?.requiredTags).toEqual(["healthy"]);
  });

  it("reuses a compiled profile for a continuation when inventory is unchanged", async () => {
    const prior = {
      semanticQuery: "recipe using bread egg",
      semanticQueryWithoutInventory: "recipe",
      vectorCandidateLimit: 50,
      correctiveAttempt: false,
      plan: { userFacets: [], userTags: [], memoryTags: [], inventoryIngredients: ["bread", "egg"] },
      intent: { specific: false, relatedSemanticQuery: null },
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
    };
    const node = createBuildRecipeSearchNode({
      loadInventoryForImage: () => inventoryWithIngredients(["egg", "bread"]),
    });
    const result = await node({
      ...state(),
      query: "more options please",
      context: { intentRouting: { recipeContinuation: true } },
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
