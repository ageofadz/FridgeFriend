import { promptMessages } from "../../scan/services/prompt-messages.server";
import type { QueryGraphDependencies } from "../schemas/query";
import {
  IntentResponseProviderSchema,
  IntentResponseSchema,
  IntentRoutingChoiceSchema,
  type EnrichmentRequirement,
  type IntentEmbeddingRoutingResult,
  type IntentRoutingChoice,
  type QueryIntent,
} from "../schemas/query";
import { conversationContextFromState } from "../services/conversation-context.server";
import {
  CHAT_PROVIDER,
  createIntentRoutingModel,
  GENERAL_MODEL,
  INTENT_ROUTING_TIMEOUT_MS,
} from "../services/query-model.server";
import { routeIntentCandidatesByEmbedding } from "../services/intent-embedding-router.server";
import type { FridgeQueryStateValue } from "../state";

const SELECTED_DETAIL_ENRICHMENT_FIELDS = [
  "identity",
  "quantity",
  "fill_level",
  "opened",
  "expiration_date",
] as const;

const INTENT_ROUTING_CHOICE_PROMPTS: Record<QueryIntent, string> = {
  inventory: "inventory: current recorded food inventory, quantities, locations, or visible item facts.",
  expiry: "expiry: requests to use food before it expires, reduce food waste, identify what to use soon, or plan meals around freshness.",
  recipe: "recipe: cooking ideas, meal planning, recipe recommendations/ details, or options from a previous recipe set.",
  shopping: "shopping: groceries, restocking, replacements, missing ingredients.",
  space: "space: physical storage fit or shelf capacity, whether items fit, how much room remains, or capacity limits.",
  organization: "organization: arranging, reorganizing, improving storage efficiency, grouping, moving inventory.",
  placement_correction: "placement_correction: user correction that a visible scanned inventory item is in the wrong shelf, side, zone, spot, place, or position and should move.",
  food_knowledge: "food_knowledge: safety, freshness, nutrition, allergens, or general food facts when the user is not asking for recipes.",
  general_chat: "general_chat: conversational messages, user preferences, household facts, or open-ended chat that fits no other tool. Use general_chat rather than clarification for ordinary conversation or preferences",
  clarification: "clarification: empty, incoherent, or genuinely ambiguous requests.",
};

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

async function intentRoutingMessagesForChoices(
  state: FridgeQueryStateValue,
  query: string,
  choices: IntentRoutingChoice[],
  deps: QueryGraphDependencies,
) {
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
  const [firstChoice, secondChoice, thirdChoice] = choices;
  if (!firstChoice) throw new Error("Intent routing choices are unavailable.");
  return promptMessages(loadedPrompt, {
    intent_routing_context_json: JSON.stringify(routingContext),
    intent_routing_choice_1: INTENT_ROUTING_CHOICE_PROMPTS[firstChoice.intent],
    intent_routing_choice_2: secondChoice ? INTENT_ROUTING_CHOICE_PROMPTS[secondChoice.intent] : "",
    intent_routing_choice_3: thirdChoice ? INTENT_ROUTING_CHOICE_PROMPTS[thirdChoice.intent] : "",
  });
}

function parseEmbeddingRoutingResult(result: Awaited<ReturnType<NonNullable<QueryGraphDependencies["intentEmbeddingRouter"]>>>): {
  data: IntentEmbeddingRoutingResult | null;
  error: string | null;
} {
  if (result === null) {
    return { data: null, error: null };
  }

  const parsedAcceptedOnly = IntentResponseSchema.safeParse(result);

  if (parsedAcceptedOnly.success) {
    return {
      data: { accepted: parsedAcceptedOnly.data, candidates: [] },
      error: null,
    };
  }

  if (
    typeof result === "object" &&
    result !== null &&
    "accepted" in result &&
    "candidates" in result &&
    Array.isArray(result.candidates)
  ) {
    const accepted = result.accepted === null
      ? null
      : IntentResponseSchema.safeParse(result.accepted);

    if (accepted !== null && !accepted.success) {
      return {
        data: null,
        error: `Intent embedding routing returned invalid output: ${accepted.error.issues.map((issue) => issue.message).join("; ")}`,
      };
    }

    const candidates = IntentRoutingChoiceSchema.array().safeParse(result.candidates);

    if (!candidates.success) {
      return {
        data: null,
        error: `Intent embedding routing returned invalid candidates: ${candidates.error.issues.map((issue) => issue.message).join("; ")}`,
      };
    }

    return {
      data: {
        accepted: accepted?.data ?? null,
        candidates: candidates.data,
      },
      error: null,
    };
  }

  return {
    data: null,
    error: `Intent embedding routing returned invalid output: ${parsedAcceptedOnly.error.issues.map((issue) => issue.message).join("; ")}`,
  };
}

function intentResponseProviderSchemaForChoices(choices: IntentRoutingChoice[]) {
  const intents = [...new Set(choices.map((choice) => choice.intent))];
  if (intents.length === 0) throw new Error("Intent routing choices are unavailable.");

  return {
    ...IntentResponseProviderSchema,
    properties: {
      ...IntentResponseProviderSchema.properties,
      intent: {
        ...IntentResponseProviderSchema.properties.intent,
        enum: intents,
      },
    },
  };
}

function routeAllowedByChoices(intent: QueryIntent, choices: IntentRoutingChoice[]) {
  return choices.some((choice) => choice.intent === intent);
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

    const selectedDetailEnrichment = selectedItemDetailEnrichment(state, query);

    if (selectedDetailEnrichment) {
      return {
        intent: "inventory" as const,
        context: {
          ...state.context,
          intentRouting: {
            recipeContinuation: false,
            shoppingMode: "direct",
            enrichment: selectedDetailEnrichment,
            memoryUpdateRequested: false,
          },
        },
      };
    }

    const embeddingRouter = deps.intentEmbeddingRouter ?? routeIntentCandidatesByEmbedding;
    const embeddingResult = parseEmbeddingRoutingResult(await embeddingRouter({ query }));

    if (embeddingResult.error) {
      return {
        intent: "clarification" as const,
        context: {
          ...state.context,
          intentRoutingError: embeddingResult.error,
        },
      };
    }

    if (embeddingResult.data?.accepted) {
      return {
        intent: embeddingResult.data.accepted.intent,
        context: {
          ...state.context,
          intentRouting: {
            recipeContinuation: embeddingResult.data.accepted.recipeContinuation,
            shoppingMode: embeddingResult.data.accepted.shoppingMode,
            enrichment: embeddingResult.data.accepted.enrichment,
            memoryUpdateRequested: embeddingResult.data.accepted.memoryUpdateRequested,
          },
        },
      };
    }

    const intentChoices = embeddingResult.data?.candidates ?? [];
    const model = deps.intentModel ?? createIntentRoutingModel();
    const structuredModel = model.withStructuredOutput(intentResponseProviderSchemaForChoices(intentChoices), {
      name: "FridgeQueryIntent",
    });
    let result: unknown;

    try {
      result = await structuredModel.invoke(
        await intentRoutingMessagesForChoices(state, query, intentChoices, deps),
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

    if (!routeAllowedByChoices(parsed.data.intent, intentChoices)) {
      return {
        intent: "clarification" as const,
        context: {
          ...state.context,
          intentRoutingError: `Intent routing returned an unlisted choice: ${parsed.data.intent}`,
        },
      };
    }

    return {
      intent: parsed.data.intent,
      context: {
        ...state.context,
        intentRouting: {
          recipeContinuation: parsed.data.recipeContinuation,
          shoppingMode: parsed.data.shoppingMode,
          enrichment: parsed.data.enrichment,
          memoryUpdateRequested: parsed.data.memoryUpdateRequested,
        },
      },
    };
  };
}
