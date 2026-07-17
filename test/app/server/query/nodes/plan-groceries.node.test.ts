import { ChatPromptTemplate } from "@langchain/core/prompts";
import type { FridgeFriendChatModel } from "../../../../../app/server/ai/chat-model.server";
import { describe, expect, it } from "vitest";

import { createPlanGroceriesNode } from "../../../../../app/server/query/nodes/plan-groceries.node";
import { PromptName } from "../../../../../app/server/prompts/registry.server";
import type { Recipe } from "../../../../../app/server/recipes/types";
import type { QueryGraphDependencies } from "../../../../../app/server/query/schemas/query";
import type { RankedRecipe } from "../../../../../app/server/query/services/recipe-retrieval.server";
import type { FridgeQueryStateValue } from "../../../../../app/server/query/state";

function model(result: unknown) {
  return {
    withStructuredOutput: () => ({ invoke: async () => result }),
  } as unknown as FridgeFriendChatModel;
}

function candidate(id: string, missingIngredients: string[]): RankedRecipe {
  return {
    id,
    name: `Recipe ${id}`,
    description: null,
    minutes: 20,
    calories: 400,
    proteinDailyValue: 20,
    ingredients: ["chicken", ...missingIngredients],
    matchedIngredients: ["chicken"],
    missingIngredients,
    matchedTags: ["dinner"],
    matchBadges: [],
    ingredientCoverage: 0.5,
    expiringCoverage: 0,
    wasteReductionScore: 0,
    usesSoonIngredients: [],
    semanticScore: 0.8,
    tagScore: 0,
    preferenceScore: 0,
    ratingScore: 0,
    eligibilityBand: "strict",
    score: 0.8,
  };
}

function recipe(id: string, ingredients: string[]): Recipe {
  return {
    id,
    name: `Recipe ${id}`,
    description: null,
    ingredients: ingredients.map((ingredient) => ({ rawName: ingredient, canonicalName: ingredient })),
    tags: ["dinner"],
    steps: [],
    minutes: 20,
    stepCount: 0,
    ingredientCount: ingredients.length,
    nutrition: {
      calories: 400,
      totalFatDailyValue: null,
      sugarDailyValue: null,
      sodiumDailyValue: null,
      proteinDailyValue: 20,
      saturatedFatDailyValue: null,
      carbohydratesDailyValue: null,
    },
    rating: null,
  };
}

function state(candidates: RankedRecipe[]): FridgeQueryStateValue {
  return {
    userId: "user-1",
    fridgeId: "fridge-1",
    imageId: null,
    query: "I am going grocery shopping tomorrow.",
    intent: "shopping",
    externalInventory: [{
      id: "external-chicken",
      name: "chicken",
      canonicalName: "chicken",
      storageLocation: "freezer",
      quantity: null,
      expirationDate: null,
      status: "available",
      confidence: 1,
      source: "user",
      notes: null,
      createdAt: "2026-07-17T00:00:00.000Z",
      updatedAt: "2026-07-17T00:00:00.000Z",
    }],
    dietaryRestrictions: [],
    dietaryPreferences: [],
    activeGoals: [],
    context: {
      intentRouting: { shoppingMode: "grocery_planner" },
      recipeRetrieval: { recipes: candidates },
    },
  } as unknown as FridgeQueryStateValue;
}

function deps(input: { selection: unknown; assignments: unknown; recipes: Recipe[] }): QueryGraphDependencies {
  return {
    promptBundle: {
      groceryRecipeSelection: {
        name: PromptName.GroceryRecipeSelection,
        ref: "bundled:grocery-recipe-selection",
        prompt: ChatPromptTemplate.fromMessages([["human", "{{grocery_recipe_selection_context_json}}"]], { templateFormat: "mustache" }),
      },
      groceryAisleAssignment: {
        name: PromptName.GroceryAisleAssignment,
        ref: "bundled:grocery-aisle-assignment",
        prompt: ChatPromptTemplate.fromMessages([["human", "{{grocery_aisle_assignment_context_json}}"]], { templateFormat: "mustache" }),
      },
    } as unknown as QueryGraphDependencies["promptBundle"],
    groceryRecipeSelectionModel: model(input.selection),
    groceryAisleAssignmentModel: model(input.assignments),
    getRecipesByIds: () => input.recipes,
  };
}

describe("grocery planner node", () => {
  it("deduplicates missing ingredients and preserves every recipe reference", async () => {
    const candidates = [
      candidate("one", ["garlic", "rice"]),
      candidate("two", ["garlic", "broccoli"]),
      candidate("three", ["rice", "lemon"]),
    ];
    const result = await createPlanGroceriesNode(deps({
      selection: { recipeIds: ["one", "two", "three"] },
      assignments: {
        assignments: [
          { ingredient: "garlic", aisle: "produce" },
          { ingredient: "rice", aisle: "dry_goods" },
          { ingredient: "broccoli", aisle: "produce" },
          { ingredient: "lemon", aisle: "produce" },
        ],
      },
      recipes: [
        recipe("one", ["chicken", "garlic", "rice"]),
        recipe("two", ["chicken", "garlic", "broccoli"]),
        recipe("three", ["chicken", "rice", "lemon"]),
      ],
    }))(state(candidates));

    const plan = result.context?.groceryPlan as { recipes: Array<{ id: string }>; items: Array<{ ingredient: string; recipeIds: string[] }> };
    expect(plan.recipes.map((entry) => entry.id)).toEqual(["one", "two", "three"]);
    expect(plan.items.find((item) => item.ingredient === "garlic")?.recipeIds).toEqual(["one", "two"]);
    expect(plan.items.find((item) => item.ingredient === "rice")?.recipeIds).toEqual(["one", "three"]);
    expect(plan.items.map((item) => item.ingredient)).toEqual(["broccoli", "garlic", "lemon", "rice"]);
  });

  it("reports an exact selection error instead of producing a grocery plan", async () => {
    const candidates = [candidate("one", ["garlic"]), candidate("two", ["rice"]), candidate("three", ["lemon"])];
    const result = await createPlanGroceriesNode(deps({
      selection: { recipeIds: ["one", "two", "unknown"] },
      assignments: { assignments: [] },
      recipes: [],
    }))(state(candidates));

    expect(result.context?.groceryPlan).toBeNull();
    expect(result.context?.groceryPlanError).toBe("Grocery Planner recipe selection returned recipe ids outside the eligible candidate set.");
  });
});
