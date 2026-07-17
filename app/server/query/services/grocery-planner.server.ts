import {
  GroceryPlanSchema,
  PantryCompletionPlanSchema,
  type PantryCompletionPlan,
  type GroceryPlan,
} from "../schemas/query";
import type { FridgeQueryStateValue } from "../state";

function shoppingModeFromState(state: FridgeQueryStateValue) {
  const routing = state.context.intentRouting;

  if (
    typeof routing === "object" &&
    routing !== null &&
    "shoppingMode" in routing &&
    (routing.shoppingMode === "grocery_planner" || routing.shoppingMode === "pantry_completion")
  ) {
    return routing.shoppingMode;
  }

  return "direct" as const;
}

export function isGroceryPlannerRequest(state: FridgeQueryStateValue) {
  return state.intent === "shopping" && shoppingModeFromState(state) === "grocery_planner";
}

export function isPantryCompletionRequest(state: FridgeQueryStateValue) {
  return state.intent === "shopping" && shoppingModeFromState(state) === "pantry_completion";
}

export function isShoppingPlanningRequest(state: FridgeQueryStateValue) {
  return isGroceryPlannerRequest(state) || isPantryCompletionRequest(state);
}

export function groceryPlanFromContext(context: FridgeQueryStateValue["context"]): GroceryPlan | null {
  const parsed = GroceryPlanSchema.safeParse(context.groceryPlan);
  return parsed.success ? parsed.data : null;
}

export function groceryPlanErrorFromContext(context: FridgeQueryStateValue["context"]) {
  return typeof context.groceryPlanError === "string" && context.groceryPlanError.trim().length > 0
    ? context.groceryPlanError
    : null;
}

export function pantryCompletionPlanFromContext(context: FridgeQueryStateValue["context"]): PantryCompletionPlan | null {
  const parsed = PantryCompletionPlanSchema.safeParse(context.pantryCompletionPlan);
  return parsed.success ? parsed.data : null;
}

export function pantryCompletionErrorFromContext(context: FridgeQueryStateValue["context"]) {
  return typeof context.pantryCompletionError === "string" && context.pantryCompletionError.trim().length > 0
    ? context.pantryCompletionError
    : null;
}

export function pantryCompletionClarificationFromContext(context: FridgeQueryStateValue["context"]) {
  return typeof context.pantryCompletionClarification === "string" && context.pantryCompletionClarification.trim().length > 0
    ? context.pantryCompletionClarification
    : null;
}
