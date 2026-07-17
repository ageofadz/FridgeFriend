import { describe, expect, it } from "vitest";

import { routeExpiryPlan, routeInventoryFollowup, routeInventorySplitProposal, routeRecipeRetrievalGrade, routeRecipeTournamentResult } from "../../../../../app/server/query/routing/query-routing";
import type { FridgeQueryStateValue } from "../../../../../app/server/query/state";

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
    }))).toBe("respond");
  });

  it("rewrites once when retrieval returns no tournament candidates", () => {
    expect(routeRecipeRetrievalGrade(state({
      tournamentCandidates: [],
      recipeRetrievalGrade: { relevant: false, reason: "miss" },
    }))).toBe("rewrite_recipe_query");
    expect(routeRecipeRetrievalGrade(state({
      tournamentCandidates: [],
      recipeRetrievalGrade: { relevant: false, reason: "miss" },
      recipeRewriteCount: 1,
    }))).toBe("respond");
  });
});

describe("expiry routing", () => {
  it("runs expiry planning after inventory and searches recipes only when priorities exist", () => {
    expect(routeInventoryFollowup(state({ intent: "expiry" }))).toBe("plan_expiry");
    expect(routeExpiryPlan(state({ context: { expiryPlan: { priorityItems: [{ id: "milk" }] } } }))).toBe("build_recipe_search");
    expect(routeExpiryPlan(state({ context: { expiryPlan: { priorityItems: [] } } }))).toBe("respond");
  });
});

describe("grocery planner routing", () => {
  it("builds a grocery recipe search only for planner-mode shopping", () => {
    expect(routeInventoryFollowup(state({
      intent: "shopping",
      context: { intentRouting: { shoppingMode: "grocery_planner" } },
    }))).toBe("build_recipe_search");
    expect(routeInventoryFollowup(state({
      intent: "shopping",
      context: { intentRouting: { shoppingMode: "direct" } },
    }))).toBe("respond");
    expect(routeInventoryFollowup(state({
      intent: "shopping",
      context: { intentRouting: { shoppingMode: "pantry_completion" } },
    }))).toBe("build_recipe_search");
  });

  it("sends only planner-mode tournament results to grocery planning", () => {
    expect(routeRecipeTournamentResult(state({
      intent: "shopping",
      context: { intentRouting: { shoppingMode: "grocery_planner" } },
    }))).toBe("plan_groceries");
    expect(routeRecipeTournamentResult(state({ intent: "recipe", context: {} }))).toBe("respond");
  });

  it("routes pantry completion directly to planning without a tournament fan-out", () => {
    expect(routeRecipeRetrievalGrade(state({
      intent: "shopping",
      context: { intentRouting: { shoppingMode: "pantry_completion" } },
    }))).toBe("plan_pantry_completion");
    expect(routeRecipeTournamentResult(state({
      intent: "shopping",
      context: { intentRouting: { shoppingMode: "pantry_completion" } },
    }))).toBe("plan_pantry_completion");
  });
});

describe("scoped inventory split routing", () => {
  it("runs the visual split proposal only for inventory questions", () => {
    expect(routeInventorySplitProposal(state({ intent: "inventory" }))).toBe("propose_scoped_inventory_split");
    expect(routeInventorySplitProposal(state({ intent: "recipe" }))).toBe("assess_inventory_enrichment");
    expect(routeInventorySplitProposal(state({ intent: "expiry" }))).toBe("assess_inventory_enrichment");
  });
});

describe("kitchen organization routing", () => {
  it("plans organization only after inventory context is available", () => {
    expect(routeInventoryFollowup(state({ intent: "organization" }))).toBe("plan_organization");
  });

  it("plans placement corrections after inventory context is available", () => {
    expect(routeInventoryFollowup(state({ intent: "placement_correction" }))).toBe("plan_placement_correction");
  });
});
