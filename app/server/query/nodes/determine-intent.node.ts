import { promptMessages } from "../../scan/services/prompt-messages.server";
import type { QueryGraphDependencies } from "../schemas/query";
import {
  IntentResponseProviderSchema,
  IntentResponseSchema,
  type EnrichmentRequirement,
} from "../schemas/query";
import { conversationContextFromState } from "../services/conversation-context.server";
import {
  CHAT_PROVIDER,
  createIntentRoutingModel,
  GENERAL_MODEL,
  INTENT_ROUTING_TIMEOUT_MS,
} from "../services/query-model.server";
import type { FridgeQueryStateValue } from "../state";

const SELECTED_DETAIL_ENRICHMENT_FIELDS = [
  "identity",
  "quantity",
  "fill_level",
  "opened",
  "expiration_date",
] as const;

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

function selectedItemDetailEnrichment(state: FridgeQueryStateValue, query: string): EnrichmentRequirement | null {
  const normalizedQuery = query.toLowerCase().replace(/\s+/g, " ").trim();

  if (
    normalizedQuery !== "get more detail about this." &&
    normalizedQuery !== "get more detail about this"
  ) {
    return null;
  }

  const seededItems = conversationContextFromState(state).seededItems;

  if (seededItems.length === 0) {
    return null;
  }

  return {
    itemNames: [...new Set(seededItems.map((item) => item.itemId))],
    fields: [...SELECTED_DETAIL_ENRICHMENT_FIELDS],
  };
}

function seededBoundingBoxCount(state: FridgeQueryStateValue) {
  return conversationContextFromState(state).seededBoundingBoxes.length;
}

async function intentRoutingMessages(state: FridgeQueryStateValue, query: string, deps: QueryGraphDependencies) {
  const priorRecipeSearch = state.recipeSearchSession
    ? {
      semanticQuery: state.recipeSearchSession.profile.semanticQuery,
      useAvailableIngredients: state.recipeSearchSession.profile.useAvailableIngredients,
      shownRecipeCount: state.recipeSearchSession.shownRecipeIds.length,
      // recipeSearchExhausted persists across turns via the checkpointer, unlike
      // context.recipeRetrieval, which is rebuilt from scratch every turn.
      exhausted: state.recipeSearchExhausted,
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
    seededBoundingBoxCount: seededBoundingBoxCount(state),
  };

  const loadedPrompt = deps.promptBundle?.intentRouting;
  if (!loadedPrompt) throw new Error("Intent routing prompt is unavailable.");
  return promptMessages(loadedPrompt, { intent_routing_context_json: JSON.stringify(routingContext) });
}

export function createDetermineIntentNode(deps: QueryGraphDependencies) {
  return async function determineIntentNode(state: FridgeQueryStateValue) {
    const query = state.query.trim();

    if (query.length === 0) {
      return {
        intent: "clarification" as const,
      };
    }

    if (state.context.recipeContinuationRequested === true && state.recipeSearchSession) {
      return {
        intent: "recipe" as const,
        context: {
          ...state.context,
          intentRouting: {
            recipeContinuation: true,
            shoppingMode: "direct",
            enrichment: { itemNames: [], fields: [] },
            memoryUpdateRequested: false,
          },
        },
      };
    }

    const model = deps.intentModel ?? createIntentRoutingModel();
    const structuredModel = model.withStructuredOutput(IntentResponseProviderSchema, {
      name: "FridgeQueryIntent",
    });
    let result: unknown;

    try {
      result = await structuredModel.invoke(
        await intentRoutingMessages(state, query, deps),
        {
          tags: ["query", "determine_intent"],
          metadata: {
            userId: state.userId,
            fridgeId: state.fridgeId,
            imageId: state.imageId,
            provider: CHAT_PROVIDER,
            model: GENERAL_MODEL,
          },
          timeout: INTENT_ROUTING_TIMEOUT_MS,
        },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Intent routing failed for query "${query}" after ${INTENT_ROUTING_TIMEOUT_MS}ms: ${message}`);
    }
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

    const selectedDetailEnrichment = selectedItemDetailEnrichment(state, query);

    return {
      intent: selectedDetailEnrichment ? "inventory" as const : parsed.data.intent,
      context: {
        ...state.context,
        intentRouting: {
          recipeContinuation: parsed.data.recipeContinuation,
          shoppingMode: parsed.data.shoppingMode,
          enrichment: selectedDetailEnrichment ?? parsed.data.enrichment,
          memoryUpdateRequested: parsed.data.memoryUpdateRequested,
        },
      },
    };
  };
}
