import { HumanMessage, SystemMessage } from "@langchain/core/messages";

import { VISION_MODEL } from "../../scan/schemas/inventory";
import type { QueryGraphDependencies } from "../schemas/query";
import {
  IntentResponseProviderSchema,
  IntentResponseSchema,
} from "../schemas/query";
import { createQueryModel } from "../services/query-model.server";
import type { FridgeQueryStateValue } from "../state";

function selectedRecipeIdFromContext(context: FridgeQueryStateValue["context"]) {
  const value = context.conversationContext;

  if (
    typeof value === "object" &&
    value !== null &&
    "selectedRecipeId" in value &&
    (typeof value.selectedRecipeId === "string" || value.selectedRecipeId === null)
  ) {
    return value.selectedRecipeId;
  }

  return null;
}

function intentRoutingMessages(state: FridgeQueryStateValue, query: string) {
  const priorRecipeSearch = state.recipeSearchSession
    ? {
      semanticQuery: state.recipeSearchSession.profile.semanticQuery,
      useAvailableIngredients: state.recipeSearchSession.profile.useAvailableIngredients,
      shownRecipeCount: state.recipeSearchSession.shownRecipeIds.length,
      exhausted: Boolean(
        typeof state.context.recipeRetrieval === "object" &&
        state.context.recipeRetrieval !== null &&
        "exhausted" in state.context.recipeRetrieval &&
        state.context.recipeRetrieval.exhausted,
      ),
    }
    : null;
  const routingContext = {
    query,
    priorRecipeSearch,
    lastRecipeSearch: state.lastRecipeSearch
      ? {
        semanticQuery: state.lastRecipeSearch.semanticQuery,
        useAvailableIngredients: state.lastRecipeSearch.useAvailableIngredients,
      }
      : null,
    selectedRecipeId: selectedRecipeIdFromContext(state.context),
  };

  return [
    new SystemMessage(
      [
        "Route a FridgeFriend request to exactly one intent.",
        "inventory: current recorded food inventory, quantities, locations, or visible item facts.",
        "expiry: requests to use food before it expires, reduce food waste, identify what to use soon, or plan meals around freshness.",
        "recipe: cooking ideas, meal planning, recipe recommendations, recipe details, or additional options from a previous recipe result set.",
        "shopping: groceries, restocking, replacements, missing ingredients, or buy lists.",
        "space: physical storage fit, shelf capacity, placement, or organization.",
        "food_knowledge: safety, freshness, nutrition, allergens, or general food facts when the user is not asking for recipes.",
        "clarification: empty, incoherent, or genuinely ambiguous requests.",
        "Set recipeContinuation to true only when a prior recipe search exists and the request asks for more, other options, alternatives, similar choices, or continuation from the current recipe results.",
        "Use priorRecipeSearch, lastRecipeSearch, and selectedRecipeId as conversation state. When recipeContinuation is true, choose recipe even if the message mentions a list or current items.",
        "Do not choose inventory merely because a recipe continuation refers to the current list, previous results, or available ingredients.",
        "Set enrichment.itemNames and enrichment.fields only when a missing inventory detail could materially change the answer. Fields are identity, quantity, fill_level, expiration_date, and opened. Leave both arrays empty when the coarse inventory is sufficient.",
      ].join("\n"),
    ),
    new HumanMessage(JSON.stringify(routingContext)),
  ];
}

export function createDetermineIntentNode(deps: QueryGraphDependencies) {
  return async function determineIntentNode(state: FridgeQueryStateValue) {
    const query = state.query.trim();

    if (query.length === 0) {
      return {
        intent: "clarification" as const,
      };
    }

    const model = deps.intentModel ?? createQueryModel();
    const structuredModel = model.withStructuredOutput(IntentResponseProviderSchema, {
      name: "FridgeQueryIntent",
    });
    const result = await structuredModel.invoke(
      intentRoutingMessages(state, query),
      {
        tags: ["query", "determine_intent"],
        metadata: {
          userId: state.userId,
          fridgeId: state.fridgeId,
          imageId: state.imageId,
          model: VISION_MODEL,
        },
      },
    );
    const parsed = IntentResponseSchema.safeParse(result);

    if (!parsed.success) {
      return {
        intent: "clarification" as const,
        context: {
          ...state.context,
          intentRoutingError: `Intent routing returned invalid output: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
        },
      };
    }

    return {
      intent: parsed.data.intent,
      context: {
        ...state.context,
        intentRouting: {
          recipeContinuation: parsed.data.recipeContinuation,
          enrichment: parsed.data.enrichment,
        },
      },
    };
  };
}
