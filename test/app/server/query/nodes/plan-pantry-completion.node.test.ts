import { ChatPromptTemplate } from "@langchain/core/prompts";
import type { FridgeFriendChatModel } from "../../../../../app/server/ai/chat-model.server";
import { describe, expect, it } from "vitest";

import { createPlanPantryCompletionNode } from "../../../../../app/server/query/nodes/plan-pantry-completion.node";
import { PromptName } from "../../../../../app/server/prompts/registry.server";
import type { QueryGraphDependencies } from "../../../../../app/server/query/schemas/query";
import type { RankedRecipe } from "../../../../../app/server/query/services/recipe-retrieval.server";
import type { FridgeQueryStateValue } from "../../../../../app/server/query/state";

function model(result: unknown) {
  return {
    withStructuredOutput: () => ({ invoke: async () => result }),
  } as unknown as FridgeFriendChatModel;
}

function candidate(id: string, missingIngredients: string[], score: number): RankedRecipe {
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
    semanticScore: score,
    tagScore: 0,
    preferenceScore: 0,
    ratingScore: 0,
    eligibilityBand: "strict",
    score,
  };
}

function state(candidates: RankedRecipe[]): FridgeQueryStateValue {
  return {
    userId: "user-1",
    fridgeId: "fridge-1",
    imageId: null,
    query: "Which pantry staples unlock more recipes?",
    intent: "shopping",
    externalInventory: [],
    dietaryRestrictions: [],
    dietaryPreferences: [],
    activeGoals: [],
    context: {
      intentRouting: { shoppingMode: "pantry_completion" },
      recipeRetrieval: { recipes: candidates },
    },
  } as unknown as FridgeQueryStateValue;
}

function deps(assignments: unknown): QueryGraphDependencies {
  return {
    promptBundle: {
      groceryAisleAssignment: {
        name: PromptName.GroceryAisleAssignment,
        ref: "bundled:grocery-aisle-assignment",
        prompt: ChatPromptTemplate.fromMessages([["human", "{{grocery_aisle_assignment_context_json}}"]], { templateFormat: "mustache" }),
      },
    } as unknown as QueryGraphDependencies["promptBundle"],
    groceryAisleAssignmentModel: model(assignments),
  };
}

describe("smart pantry completion node", () => {
  it("builds a three-staple bundle and counts only recipes completed by that bundle", async () => {
    const result = await createPlanPantryCompletionNode(deps({
      assignments: [
        { ingredient: "garlic", aisle: "produce" },
        { ingredient: "ginger", aisle: "produce" },
        { ingredient: "sesame oil", aisle: "condiments_spices" },
      ],
    }))(state([
      candidate("one", ["garlic"], 0.8),
      candidate("two", ["garlic", "ginger"], 0.9),
      candidate("three", ["ginger"], 0.7),
      candidate("four", ["ginger", "sesame oil"], 0.5),
      candidate("excluded", ["garlic", "ginger", "sesame oil", "onion"], 1),
    ]));

    const plan = result.context?.pantryCompletionPlan as {
      eligibleRecipeCount: number;
      unlockedRecipeCount: number;
      suggestions: Array<{ ingredient: string; recipeIds: string[] }>;
      unlockedRecipes: Array<{ id: string; name: string; suggestedIngredients: string[] }>;
    };
    expect(plan.eligibleRecipeCount).toBe(5);
    expect(plan.unlockedRecipeCount).toBe(4);
    expect(plan.suggestions.map((suggestion) => suggestion.ingredient)).toEqual(["garlic", "ginger", "sesame oil"]);
    expect(plan.suggestions.find((suggestion) => suggestion.ingredient === "sesame oil")?.recipeIds).toEqual(["four"]);
    expect(plan.unlockedRecipes).toEqual([
      { id: "one", name: "Recipe one", suggestedIngredients: ["garlic"] },
      { id: "two", name: "Recipe two", suggestedIngredients: ["garlic", "ginger"] },
      { id: "three", name: "Recipe three", suggestedIngredients: ["ginger"] },
      { id: "four", name: "Recipe four", suggestedIngredients: ["ginger", "sesame oil"] },
    ]);
  });

  it("treats universal basics as already available instead of suggesting them", async () => {
    const result = await createPlanPantryCompletionNode(deps({
      assignments: [{ ingredient: "garlic", aisle: "produce" }],
    }))(state([
      candidate("one", ["water", "garlic"], 0.5),
      candidate("two", ["kosher salt", "garlic"], 0.5),
      candidate("three", ["black pepper", "garlic"], 0.5),
    ]));

    const plan = result.context?.pantryCompletionPlan as {
      unlockedRecipeCount: number;
      suggestions: Array<{ ingredient: string }>;
      unlockedRecipes: Array<{ suggestedIngredients: string[] }>;
    };
    expect(plan.unlockedRecipeCount).toBe(3);
    expect(plan.suggestions.map((suggestion) => suggestion.ingredient)).toEqual(["garlic"]);
    expect(plan.unlockedRecipes.map((recipe) => recipe.suggestedIngredients)).toEqual([
      ["garlic"],
      ["garlic"],
      ["garlic"],
    ]);
  });

  it("chooses the bundle that unlocks the most recipes instead of the most common single missing ingredient", async () => {
    const garlicDecoys = Array.from({ length: 10 }, (_entry, index) =>
      candidate(`garlic-decoy-${index}`, ["garlic", `specific item ${index}`], 0.9)
    );
    const sharedStapleRecipes = Array.from({ length: 4 }, (_entry, index) =>
      candidate(`shared-${index}`, ["ginger", "onion"], 0.5)
    );
    const result = await createPlanPantryCompletionNode(deps({
      assignments: [
        { ingredient: "ginger", aisle: "produce" },
        { ingredient: "onion", aisle: "produce" },
      ],
    }))(state([...garlicDecoys, ...sharedStapleRecipes]));

    const plan = result.context?.pantryCompletionPlan as {
      unlockedRecipeCount: number;
      suggestions: Array<{ ingredient: string }>;
    };
    expect(plan.unlockedRecipeCount).toBe(4);
    expect(plan.suggestions.map((suggestion) => suggestion.ingredient)).toEqual(["ginger", "onion"]);
  });

  it("returns actionable clarification when fewer than three relevant recipes share a pantry bundle", async () => {
    const result = await createPlanPantryCompletionNode(deps({ assignments: [] }))(state([
      candidate("one", ["garlic"], 0.8),
      ...Array.from({ length: 19 }, (_entry, index) =>
        candidate(`wide-${index}`, [`wide a ${index}`, `wide b ${index}`, `wide c ${index}`, `wide d ${index}`], 0.5)
      ),
    ]));

    expect(result.context?.pantryCompletionPlan).toBeNull();
    expect(result.context?.pantryCompletionError).toBeNull();
    expect(result.context?.pantryCompletionClarification).toBe("I found fewer than three relevant recipes for one pantry bundle. Try broadening the recipe category or adding more pantry items.");
    expect(result.context?.pantryCompletionFailureReason).toBe("The best pantry bundle unlocked 1 of 1 structurally eligible recipes.");
  });

  it("returns actionable clarification when no relevant recipe needs one to three additions", async () => {
    const result = await createPlanPantryCompletionNode(deps({ assignments: [] }))(state([
      candidate("four-missing", ["garlic", "ginger", "sesame oil", "onion"], 1),
    ]));

    expect(result.context?.pantryCompletionPlan).toBeNull();
    expect(result.context?.pantryCompletionError).toBeNull();
    expect(result.context?.pantryCompletionClarification).toBe("I could not find three relevant recipes that your current ingredients can complete with up to three additions. Try broadening the recipe category or adding more pantry items.");
    expect(result.context?.pantryCompletionFailureReason).toBe("No retrieved recipe had one to three non-basic missing ingredients among 1 relevant candidates.");
  });

  it("reports a specific error when aisle assignment does not cover each staple exactly once", async () => {
    const result = await createPlanPantryCompletionNode(deps({
      assignments: [{ ingredient: "garlic", aisle: "produce" }],
    }))(state([
      candidate("one", ["garlic"], 0.8),
      candidate("two", ["ginger"], 0.7),
      candidate("three", ["garlic", "ginger"], 0.6),
    ]));

    expect(result.context?.pantryCompletionPlan).toBeNull();
    expect(result.context?.pantryCompletionError).toBe("Smart Pantry Completion aisle assignment did not cover every suggested ingredient exactly once.");
  });
});
