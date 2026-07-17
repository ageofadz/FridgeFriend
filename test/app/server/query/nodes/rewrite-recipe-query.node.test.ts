import { describe, expect, it } from "vitest";

import { createRewriteRecipeQueryNode } from "../../../../../app/server/query/nodes/rewrite-recipe-query.node";
import type { FridgeQueryStateValue } from "../../../../../app/server/query/state";

function state(): FridgeQueryStateValue {
  return {
    userId: "user-1",
    fridgeId: "fridge-1",
    imageId: "image-1",
    query: "Find a quick dairy-free dinner.",
    recipeSearch: {
      semanticQuery: "recipe quick dairy free using yogurt lime",
      semanticQueryWithoutInventory: "recipe quick dairy free",
      vectorCandidateLimit: 50,
      correctiveAttempt: false,
      plan: {
        userFacets: [{ kind: "method", text: "quick" }],
        userTags: ["dairy free"],
        memoryTags: [],
        inventoryIngredients: ["yogurt", "lime"],
      },
      intent: { specific: true, relatedSemanticQuery: null },
      useAvailableIngredients: false,
      excludedIngredients: ["milk"],
      dietaryRestrictions: ["dairy-free"],
      maxMinutes: 30,
      maxCalories: 450,
      minProteinDailyValue: 20,
      preferredIngredients: [],
      requiredTags: ["dairy free"],
      preferredTags: ["30 minutes or less"],
      excludedTags: ["dairy"],
      memoryPreferredTags: [],
      memoryExcludedTags: [],
      memoryGoalTags: [],
      continuation: false,
    },
    recipeRewriteCount: 0,
    recipeRetrievalGrade: { relevant: false, reason: "Need a broader relevant category." },
  } as unknown as FridgeQueryStateValue;
}

describe("rewrite recipe query node", () => {
  it("uses one deterministic corrective attempt without adding vocabulary", async () => {
    const result = await createRewriteRecipeQueryNode()(state());

    expect(result.recipeSearch).toMatchObject({
      semanticQuery: "recipe quick dairy free",
      semanticQueryWithoutInventory: "recipe quick dairy free",
      vectorCandidateLimit: 120,
      correctiveAttempt: true,
      intent: { specific: true, relatedSemanticQuery: null },
      excludedIngredients: ["milk"],
      dietaryRestrictions: ["dairy-free"],
      maxMinutes: 30,
      maxCalories: 450,
      minProteinDailyValue: 20,
      requiredTags: ["dairy free"],
      excludedTags: ["dairy"],
    });
  });
});
