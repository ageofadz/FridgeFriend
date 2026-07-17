import { HumanMessage } from "@langchain/core/messages";
import { getWriter, type LangGraphRunnableConfig } from "@langchain/langgraph";

import { promptMessages } from "../../scan/services/prompt-messages.server";
import type { QueryGraphDependencies } from "../schemas/query";
import { conversationContextFromState } from "../services/conversation-context.server";
import { QUERY_VISIBLE_RESPONSE_TAG } from "../schemas/query";
import {
  buildFocusedVisualCrops,
  focusedVisualCropMetadata,
  type FocusedVisualCrop,
} from "../services/focused-visual-context.server";
import { loadInventoryContext } from "../services/inventory-context.server";
import {
  groceryPlanErrorFromContext,
  pantryCompletionClarificationFromContext,
  pantryCompletionErrorFromContext,
} from "../services/grocery-planner.server";
import {
  CHAT_PROVIDER,
  createQueryModel,
  extractMessageText,
  GENERAL_MODEL,
} from "../services/query-model.server";
import type { FridgeQueryStateValue } from "../state";

// Errors swallowed by upstream nodes that should soften the final answer
// instead of silently disappearing. Values are surfaced to the response model
// as context (never dumped verbatim to the user) and to LangSmith as metadata.
function upstreamNodeErrors(state: FridgeQueryStateValue): Record<string, string> {
  const candidates: Record<string, unknown> = {
    recipeSearchError: state.recipeSearchError,
    intentRoutingError: state.context.intentRoutingError,
    memoryExtractionError: state.context.memoryExtractionError,
    memoryWriteVerificationError: state.context.memoryWriteVerificationError,
    seededInventoryAssertionError: state.context.seededInventoryAssertionError,
    inventorySplitError: state.context.inventorySplitError,
  };

  return Object.fromEntries(
    Object.entries(candidates).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === "string" && entry[1].trim().length > 0,
    ),
  );
}

function recipeRetrievalTraceMetadata(state: FridgeQueryStateValue): Record<string, string | number> {
  const retrieval = state.context.recipeRetrieval;
  if (typeof retrieval !== "object" || retrieval === null) return {};
  const sourceCounts = "candidateSourceCounts" in retrieval &&
    typeof retrieval.candidateSourceCounts === "object" &&
    retrieval.candidateSourceCounts !== null
    ? retrieval.candidateSourceCounts
    : null;
  const selectedIntentTier = "selectedIntentTier" in retrieval &&
    typeof retrieval.selectedIntentTier === "string"
    ? retrieval.selectedIntentTier
    : null;
  const audit = "audit" in retrieval &&
    typeof retrieval.audit === "object" &&
    retrieval.audit !== null
    ? retrieval.audit
    : null;

  return {
    ...(sourceCounts && "primary" in sourceCounts && typeof sourceCounts.primary === "number"
      ? { recipeCandidateSourcePrimary: sourceCounts.primary }
      : {}),
    ...(sourceCounts && "related" in sourceCounts && typeof sourceCounts.related === "number"
      ? { recipeCandidateSourceRelated: sourceCounts.related }
      : {}),
    ...(sourceCounts && "coverage" in sourceCounts && typeof sourceCounts.coverage === "number"
      ? { recipeCandidateSourceCoverage: sourceCounts.coverage }
      : {}),
    ...(selectedIntentTier ? { recipeSelectedIntentTier: selectedIntentTier } : {}),
    ...(audit && "vectorCandidates" in audit && typeof audit.vectorCandidates === "number"
      ? { recipeVectorCandidates: audit.vectorCandidates }
      : {}),
    ...(audit && "tagSqlCandidates" in audit && typeof audit.tagSqlCandidates === "number"
      ? { recipeTagSqlCandidates: audit.tagSqlCandidates }
      : {}),
    ...(audit && "ingredientSqlCandidates" in audit && typeof audit.ingredientSqlCandidates === "number"
      ? { recipeIngredientSqlCandidates: audit.ingredientSqlCandidates }
      : {}),
    ...(audit && "deduplicatedCandidateIds" in audit && typeof audit.deduplicatedCandidateIds === "number"
      ? { recipeDeduplicatedCandidates: audit.deduplicatedCandidateIds }
      : {}),
    ...(audit && "canonicalHydrationCount" in audit && typeof audit.canonicalHydrationCount === "number"
      ? { recipeCanonicalHydrationCount: audit.canonicalHydrationCount }
      : {}),
    ...(audit && "hardFilterRejections" in audit && typeof audit.hardFilterRejections === "number"
      ? { recipeHardFilterRejections: audit.hardFilterRejections }
      : {}),
    ...(audit && "coverageRankedCandidates" in audit && typeof audit.coverageRankedCandidates === "number"
      ? { recipeCoverageRankedCandidates: audit.coverageRankedCandidates }
      : {}),
    ...(audit && "tournamentCandidates" in audit && typeof audit.tournamentCandidates === "number"
      ? { recipeTournamentCandidates: audit.tournamentCandidates }
      : {}),
    ...(audit && "terminalReason" in audit && typeof audit.terminalReason === "string"
      ? { recipeRetrievalTerminalReason: audit.terminalReason }
      : {}),
  };
}

function createHumanMessageContent(input: {
  query: string;
  state: FridgeQueryStateValue;
  inventory: Awaited<ReturnType<typeof loadInventoryContext>> | null;
  focusedVisualCrops: FocusedVisualCrop[];
}) {
  const cropMetadata = focusedVisualCropMetadata(input.focusedVisualCrops);
  const inventoryQuery = typeof input.state.context.inventoryQuery === "object" &&
    input.state.context.inventoryQuery !== null
    ? input.state.context.inventoryQuery
    : null;
  const payload = {
    query: input.query,
    intent: input.state.intent,
    context: {
      conversationContext: input.state.context.conversationContext,
      intentRouting: input.state.context.intentRouting,
      queryMode: input.state.context.queryMode ?? input.state.intent,
      inventoryQuery,
      inventory: input.inventory,
      recipeRetrieval: input.state.context.recipeRetrieval,
      expiryPlan: input.state.context.expiryPlan,
      groceryPlan: input.state.context.groceryPlan,
      groceryPlanError: input.state.context.groceryPlanError,
      pantryCompletionPlan: input.state.context.pantryCompletionPlan,
      pantryCompletionError: input.state.context.pantryCompletionError,
      pantryCompletionClarification: input.state.context.pantryCompletionClarification,
      inventoryEnrichment: input.state.context.inventoryEnrichment,
      inventorySplitProposal: input.state.context.inventorySplitProposal,
      seededInventoryAssertions: input.state.context.seededInventoryAssertions,
      memoryWriteResults: input.state.context.memoryWriteResults,
      memoryWriteVerification: input.state.context.memoryWriteVerification,
      memoryWriteVerificationError: input.state.context.memoryWriteVerificationError,
      externalInventory: input.state.externalInventory,
      dietaryRestrictions: input.state.dietaryRestrictions,
      dietaryPreferences: input.state.dietaryPreferences,
      activeGoals: input.state.activeGoals,
      semanticMemories: input.state.semanticMemories,
      focusedVisualCrops: cropMetadata,
    },
  } as Record<string, unknown>;
  const upstreamErrors = upstreamNodeErrors(input.state);

  if (Object.keys(upstreamErrors).length > 0) {
    payload.degradedSteps = {
      note: "Some background steps failed this turn. Answer with what is available, briefly and honestly acknowledge any capability the failures removed, and never quote these raw errors.",
      errors: upstreamErrors,
    };
  }
  const text = JSON.stringify(payload);

  if (input.focusedVisualCrops.length === 0) {
    return text;
  }

  return [
    {
      type: "text",
      text,
    },
    ...input.focusedVisualCrops.map((crop) => ({
      type: "image_url",
      image_url: {
        url: crop.dataUrl,
      },
    })),
  ];
}

function focusedInventoryItemIds(state: FridgeQueryStateValue) {
  const inventoryQueryIds = (state.context.inventoryQuery as { focusedItemIds?: unknown } | undefined)
    ?.focusedItemIds;

  if (Array.isArray(inventoryQueryIds)) {
    const itemIds = inventoryQueryIds.filter((itemId): itemId is string => typeof itemId === "string");

    if (itemIds.length > 0) {
      return itemIds;
    }
  }

  return conversationContextFromState(state).seededItems.map((item) => item.itemId);
}

function seededItems(state: FridgeQueryStateValue) {
  return conversationContextFromState(state).seededItems;
}

function seededBoundingBoxes(state: FridgeQueryStateValue) {
  return conversationContextFromState(state).seededBoundingBoxes;
}

function selectedZoneIds(state: FridgeQueryStateValue) {
  return conversationContextFromState(state).selectedZoneIds;
}

function scopedVisualItemIds(
  state: FridgeQueryStateValue,
  inventory: Awaited<ReturnType<typeof loadInventoryContext>> | null,
) {
  const zoneIds = selectedZoneIds(state);
  if (zoneIds.length === 0 || !inventory) return focusedInventoryItemIds(state);
  const selected = new Set(zoneIds);
  return inventory.items
    .filter((item) => item.location.zoneId !== null && selected.has(item.location.zoneId))
    .map((item) => item.id);
}

function scopedSeededItems(
  state: FridgeQueryStateValue,
  inventory: Awaited<ReturnType<typeof loadInventoryContext>> | null,
) {
  const seeds = seededItems(state);
  const zoneIds = selectedZoneIds(state);
  if (zoneIds.length === 0 || !inventory) return seeds;
  const selected = new Set(zoneIds);
  const allowedItemIds = new Set(inventory.items
    .filter((item) => item.location.zoneId !== null && selected.has(item.location.zoneId))
    .map((item) => item.id));
  return seeds.filter((seed) => allowedItemIds.has(seed.itemId));
}

function inventoryFromQueryState(state: FridgeQueryStateValue) {
  const inventoryQuery = state.context.inventoryQuery;

  if (
    typeof inventoryQuery === "object" &&
    inventoryQuery !== null &&
    "scannedInventory" in inventoryQuery
  ) {
    const inventory = inventoryQuery.scannedInventory;

    if (typeof inventory === "object" || inventory === null) {
      return inventory as Awaited<ReturnType<typeof loadInventoryContext>>;
    }
  }

  return undefined;
}

function inventoryWasEnriched(state: FridgeQueryStateValue) {
  const enrichment = state.context.inventoryEnrichment;
  return typeof enrichment === "object" &&
    enrichment !== null &&
    "attempts" in enrichment &&
    typeof enrichment.attempts === "number" &&
    enrichment.attempts > 0;
}

async function createResponseMessages(input: {
  query: string;
  state: FridgeQueryStateValue;
  inventory: Awaited<ReturnType<typeof loadInventoryContext>> | null;
  focusedVisualCrops: FocusedVisualCrop[];
  loadedPrompt: NonNullable<QueryGraphDependencies["promptBundle"]>["queryResponse"];
}) {
  const content = createHumanMessageContent(input);

  if (typeof content === "string") {
    return promptMessages(input.loadedPrompt, {
      query_context_json: content,
    });
  }

  const queryContextJson = "text" in content[0] ? content[0].text : "";
  const renderedMessages = await promptMessages(input.loadedPrompt, {
    query_context_json: queryContextJson,
  });
  const lastMessage = renderedMessages.at(-1);

  if (!lastMessage) {
    throw new Error(`Prompt Hub prompt ${input.loadedPrompt.ref} rendered no messages`);
  }

  return [
    ...renderedMessages.slice(0, -1),
    new HumanMessage(content),
  ];
}

export function createRespondNode(deps: QueryGraphDependencies) {
  return async function respondNode(
    state: FridgeQueryStateValue,
    config?: LangGraphRunnableConfig,
  ) {
    const writer = config ? getWriter(config) : undefined;
    if (state.answer) {
      return {
        answer: state.answer,
      };
    }

    const query = state.query.trim();
    const shouldLoadInventory = state.intent !== "general_chat" &&
      (state.intent !== "recipe" || !state.context.recipeRetrieval);
    const inventory = (inventoryWasEnriched(state) ? undefined : inventoryFromQueryState(state)) ??
      (shouldLoadInventory ? await loadInventoryContext(state, deps) : null);

    const groceryPlanError = groceryPlanErrorFromContext(state.context);
    const pantryCompletionError = pantryCompletionErrorFromContext(state.context);
    const pantryCompletionClarification = pantryCompletionClarificationFromContext(state.context);
    const organizationPlanError = typeof state.context.organizationPlanError === "string"
      ? state.context.organizationPlanError
      : null;
    const organizationPlan = state.context.organizationPlan;

    if (groceryPlanError) {
      return { answer: groceryPlanError };
    }

    if (pantryCompletionError) {
      return { answer: pantryCompletionError };
    }

    if (pantryCompletionClarification) {
      return { answer: pantryCompletionClarification };
    }

    if (organizationPlanError) {
      return { answer: organizationPlanError };
    }

    if (
      state.intent === "organization" &&
      typeof organizationPlan === "object" &&
      organizationPlan !== null &&
      "summary" in organizationPlan &&
      typeof organizationPlan.summary === "string"
    ) {
      return { answer: organizationPlan.summary };
    }

    const model = deps.responseModel ?? createQueryModel();
    const loadedPrompt = deps.promptBundle?.queryResponse;

    if (!loadedPrompt) {
      throw new Error("Missing query response prompt in query graph dependencies");
    }

    const seededContextItems = scopedSeededItems(state, inventory);
    const seededContextBoxes = seededBoundingBoxes(state);
    const focusedVisualCrops = seededContextItems.length > 0 || seededContextBoxes.length > 0
      ? await buildFocusedVisualCrops({
        imageId: state.imageId,
        inventory,
        itemIds: scopedVisualItemIds(state, inventory),
        seededItems: seededContextItems,
        seededBoundingBoxes: seededContextBoxes,
        loadImageDataUrlForQuery: deps.loadImageDataUrlForQuery,
      })
      : [];
    const messages = await createResponseMessages({
      query,
      state,
      inventory,
      focusedVisualCrops,
      loadedPrompt,
    });
    const response = await model.invoke(
      messages,
      {
        tags: ["query", "respond", QUERY_VISIBLE_RESPONSE_TAG],
        metadata: {
          fridgeId: state.fridgeId,
          imageId: state.imageId,
          intent: state.intent,
          langsmithPromptName: loadedPrompt.name,
          langsmithPromptRef: loadedPrompt.ref,
          provider: CHAT_PROVIDER,
          model: GENERAL_MODEL,
          ...recipeRetrievalTraceMetadata(state),
          // Operator-facing trace of swallowed upstream node errors.
          ...(Object.keys(upstreamNodeErrors(state)).length > 0
            ? { upstreamErrorKeys: Object.keys(upstreamNodeErrors(state)).join(",") }
            : {}),
        },
      },
    );

    const answer = extractMessageText(response);

    return {
      answer,
      visualEvidence: focusedVisualCrops.map((crop) => ({
        cropId: crop.cropId,
        itemId: crop.itemId,
        displayName: crop.displayName,
        imageId: crop.imageId,
      })),
    };
  };
}
