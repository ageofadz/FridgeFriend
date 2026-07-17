import { describe, expect, it } from "vitest";

import { routeExpiryPlan, routeInventoryFollowup, routeRecipeRetrievalGrade } from "./query-routing";
import type { FridgeQueryStateValue } from "../state";

function state(overrides: Record<string, unknown> = {}) {
  return {
    tournamentCandidates: Array.from({ length: 20 }, (_, index) => ({ id: String(index) })),
    recipeRetrievalGrade: { relevant: true, reason: "relevant" },
    recipeRewriteCount: 0,
    query: "quick dinner",
    recipeSearch: null,
    dietaryRestrictions: [],
    dietaryPreferences: [],
    activeGoals: [],
    ...overrides,
  } as unknown as FridgeQueryStateValue;
}

describe("recipe retrieval correction routing", () => {
  it("fans out one tournament worker for every eligible candidate", () => {
    const route = routeRecipeRetrievalGrade(state());

    expect(Array.isArray(route)).toBe(true);
    expect(route).toHaveLength(20);
  });

  it("allows exactly one query rewrite before ending the retrieval", () => {
    expect(routeRecipeRetrievalGrade(state({ recipeRetrievalGrade: { relevant: false, reason: "miss" } }))).toBe("rewrite_recipe_query");
    expect(routeRecipeRetrievalGrade(state({
      recipeRetrievalGrade: { relevant: false, reason: "miss" },
      recipeRewriteCount: 1,
    }))).toBe("plan_workspace_actions");
  });
});

describe("expiry routing", () => {
  it("runs expiry planning after inventory and searches recipes only when priorities exist", () => {
    expect(routeInventoryFollowup(state({ intent: "expiry" }))).toBe("plan_expiry");
    expect(routeExpiryPlan(state({ context: { expiryPlan: { priorityItems: [{ id: "milk" }] } } }))).toBe("build_recipe_search");
    expect(routeExpiryPlan(state({ context: { expiryPlan: { priorityItems: [] } } }))).toBe("plan_workspace_actions");
  });
});
