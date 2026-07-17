import { shouldExtractMemoryCandidates } from "../nodes/extract-memory-candidates.node";
import type { QueryIntent } from "../schemas/query";
import type { FridgeQueryStateValue } from "../state";
import { Send } from "@langchain/langgraph";
import { routeInventoryEnrichment } from "../nodes/enrich-inventory.node";
import {
  isGroceryPlannerRequest,
  isPantryCompletionRequest,
  isShoppingPlanningRequest,
} from "../services/grocery-planner.server";

export function routeRecipeSearch(state: FridgeQueryStateValue) {
  return state.recipeClarification ? "clarification" : "retrieve_recipes";
}

export function routeIntent(state: FridgeQueryStateValue): QueryIntent {
  return state.intent ?? "clarification";
}

export function routeIntentOrMemory(
  state: FridgeQueryStateValue,
): QueryIntent | "memory_update" {
  if (shouldExtractMemoryCandidates(state)) {
    return "memory_update";
  }

  return routeIntent(state);
}

export function routeInventoryFollowup(
  state: FridgeQueryStateValue,
): "respond" | "build_recipe_search" | "plan_expiry" | "plan_organization" | "plan_placement_correction" {
  if (state.intent === "expiry") {
    return "plan_expiry";
  }
  if (state.intent === "recipe") {
    return "build_recipe_search";
  }

  if (state.intent === "shopping") {
    if (isShoppingPlanningRequest(state)) {
      return "build_recipe_search";
    }

    return "respond";
  }

  if (state.intent === "organization") return "plan_organization";
  if (state.intent === "placement_correction") return "plan_placement_correction";

  return "respond";
}

export function routeInventorySplitProposal(state: FridgeQueryStateValue) {
  return state.intent === "inventory"
    ? "propose_scoped_inventory_split"
    : "assess_inventory_enrichment";
}

export function routeExpiryPlan(state: FridgeQueryStateValue) {
  const expiryPlan = state.context.expiryPlan;
  if (typeof expiryPlan !== "object" || expiryPlan === null || !("priorityItems" in expiryPlan)) {
    return "respond";
  }

  return Array.isArray(expiryPlan.priorityItems) && expiryPlan.priorityItems.length > 0
    ? "build_recipe_search"
    : "respond";
}

export function routeAfterInventoryEnrichment(state: FridgeQueryStateValue) {
  const route = routeInventoryEnrichment(state);
  if (route !== "continue") return route;
  return routeInventoryFollowup(state);
}

export function routeRecipeRetrievalGrade(state: FridgeQueryStateValue) {
  if (state.tournamentCandidates.length === 0) {
    if (state.recipeRewriteCount < 1) return "rewrite_recipe_query";
    if (isPantryCompletionRequest(state)) return "plan_pantry_completion";
    return isGroceryPlannerRequest(state) ? "plan_groceries" : "respond";
  }

  if (isPantryCompletionRequest(state) && state.recipeRetrievalGrade?.relevant) {
    return "plan_pantry_completion";
  }

  if (state.recipeRetrievalGrade?.relevant) {
    return state.tournamentCandidates.map((candidate) => new Send("evaluate_recipe", {
      query: state.query,
      recipeSearch: state.recipeSearch,
      dietaryRestrictions: state.dietaryRestrictions,
      dietaryPreferences: state.dietaryPreferences,
      activeGoals: state.activeGoals,
      tournamentCandidate: candidate,
    }));
  }

  if (state.recipeRewriteCount < 1) {
    return "rewrite_recipe_query";
  }

  if (isPantryCompletionRequest(state)) return "plan_pantry_completion";
  return isGroceryPlannerRequest(state) ? "plan_groceries" : "respond";
}

export function routeRecipeQueryRewrite(state: FridgeQueryStateValue) {
  if (!state.recipeSearchError) return "retrieve_recipes";
  if (isPantryCompletionRequest(state)) return "plan_pantry_completion";
  return isGroceryPlannerRequest(state) ? "plan_groceries" : "respond";
}

export function routeRecipeTournamentResult(state: FridgeQueryStateValue) {
  if (isPantryCompletionRequest(state)) return "plan_pantry_completion";
  return isGroceryPlannerRequest(state) ? "plan_groceries" : "respond";
}
