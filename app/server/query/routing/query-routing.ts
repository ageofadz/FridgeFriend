import { shouldExtractMemoryCandidates } from "../nodes/extract-memory-candidates.node";
import type { QueryIntent } from "../schemas/query";
import type { FridgeQueryStateValue } from "../state";
import { Send } from "@langchain/langgraph";
import { routeInventoryEnrichment } from "../nodes/enrich-inventory.node";

export function routeRecipeSearch(state: FridgeQueryStateValue) {
  return state.recipeClarification ? "clarification" : "retrieve_recipes";
}

export function routeIntent(state: FridgeQueryStateValue): QueryIntent {
  return state.intent ?? "clarification";
}

export function routeIntentOrMemory(
  state: FridgeQueryStateValue,
): QueryIntent | "memory_update" {
  if (shouldExtractMemoryCandidates(state.query)) {
    return "memory_update";
  }

  return routeIntent(state);
}

export function routeInventoryFollowup(
  state: FridgeQueryStateValue,
): "respond" | "retrieve_recipes" | "calculate_space" | "plan_expiry" {
  if (state.intent === "expiry") {
    return "plan_expiry";
  }
  if (state.intent === "recipe") {
    return "retrieve_recipes";
  }

  if (state.intent === "shopping") {
    const query = state.query.toLowerCase();

    if (/\b(space|fit|room|capacity|shelf|drawer|organize|where|store)\b/.test(query)) {
      return "calculate_space";
    }

    if (/\b(recipe|meal|cook|ingredient|unlock|maximi[sz]e|add|buy|grocery|groceries|shop|shopping|restock)\b/.test(query)) {
      return "retrieve_recipes";
    }

    return "calculate_space";
  }

  return "respond";
}

export function routeExpiryPlan(state: FridgeQueryStateValue) {
  const expiryPlan = state.context.expiryPlan;
  if (typeof expiryPlan !== "object" || expiryPlan === null || !("priorityItems" in expiryPlan)) {
    return "plan_workspace_actions";
  }

  return Array.isArray(expiryPlan.priorityItems) && expiryPlan.priorityItems.length > 0
    ? "build_recipe_search"
    : "plan_workspace_actions";
}

export function routeAfterInventoryEnrichment(state: FridgeQueryStateValue) {
  const route = routeInventoryEnrichment(state);
  if (route !== "continue") return route;
  return routeInventoryFollowup(state);
}

export function routeRecipeRetrievalGrade(state: FridgeQueryStateValue) {
  if (state.tournamentCandidates.length === 0) {
    return "plan_workspace_actions";
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

  return "plan_workspace_actions";
}

export function routeRecipeQueryRewrite(state: FridgeQueryStateValue) {
  return state.recipeSearchError ? "plan_workspace_actions" : "retrieve_recipes";
}
