import { HumanMessage } from "@langchain/core/messages";
import { getWriter, type LangGraphRunnableConfig } from "@langchain/langgraph";

import { VISION_MODEL } from "../../scan/schemas/inventory";
import { promptMessages } from "../../scan/services/prompt-messages.server";
import { ConversationContextSchema } from "../../../workspace/contracts";
import type { QueryGraphDependencies } from "../schemas/query";
import { QUERY_VISIBLE_RESPONSE_TAG } from "../schemas/query";
import {
  buildFocusedVisualCrops,
  focusedVisualCropMetadata,
  type FocusedVisualCrop,
} from "../services/focused-visual-context.server";
import { loadInventoryContext } from "../services/inventory-context.server";
import {
  createQueryModel,
  extractMessageText,
} from "../services/query-model.server";
import type { FridgeQueryStateValue } from "../state";

type NoMatchRecipeRetrieval = {
  noMatches: true;
  inputIngredients?: unknown;
};

function createHumanMessageContent(input: {
  query: string;
  state: FridgeQueryStateValue;
  inventory: Awaited<ReturnType<typeof loadInventoryContext>> | null;
  focusedVisualCrops: FocusedVisualCrop[];
}) {
  const cropMetadata = focusedVisualCropMetadata(input.focusedVisualCrops);
  const payload = {
    query: input.query,
    intent: input.state.intent,
    context: {
      ...input.state.context,
      inventory: input.inventory,
      focusedVisualCrops: cropMetadata,
    },
  };
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

function isNoMatchRecipeRetrieval(value: unknown): value is NoMatchRecipeRetrieval {
  return (
    typeof value === "object" &&
    value !== null &&
    "noMatches" in value &&
    value.noMatches === true
  );
}

function noMatchRecipeAnswer(retrieval: NoMatchRecipeRetrieval) {
  const ingredients = Array.isArray(retrieval.inputIngredients)
    ? retrieval.inputIngredients.filter((ingredient): ingredient is string =>
        typeof ingredient === "string" && ingredient.trim().length > 0
      )
    : [];

  if (ingredients.length === 0) {
    return "The local Food.com index found no matching recipes for the searched ingredients.";
  }

  return `The local Food.com index found no matching recipes for the searched ingredients: ${ingredients.join(", ")}.`;
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

  return ConversationContextSchema.catch({
    selectedItemIds: [],
    selectedZoneIds: [],
    selectedRecipeId: null,
    seededItems: [],
  })
    .parse(state.context.conversationContext)
    .seededItems.map((item) => item.itemId);
}

function seededItems(state: FridgeQueryStateValue) {
  return ConversationContextSchema.catch({
    selectedItemIds: [],
    selectedZoneIds: [],
    selectedRecipeId: null,
    seededItems: [],
  })
    .parse(state.context.conversationContext)
    .seededItems;
}

function selectedZoneIds(state: FridgeQueryStateValue) {
  return ConversationContextSchema.catch({
    selectedItemIds: [],
    selectedZoneIds: [],
    selectedRecipeId: null,
    seededItems: [],
  }).parse(state.context.conversationContext).selectedZoneIds;
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
    const shouldLoadInventory = state.intent !== "recipe" ||
      !state.context.recipeRetrieval;
    const inventory = inventoryFromQueryState(state) ??
      (shouldLoadInventory ? await loadInventoryContext(state, deps) : null);

    const recipeRetrieval = state.context.recipeRetrieval;

    if (isNoMatchRecipeRetrieval(recipeRetrieval)) {
      return {
        answer: noMatchRecipeAnswer(recipeRetrieval),
      };
    }

    const model = deps.responseModel ?? createQueryModel();
    const loadedPrompt = deps.promptBundle?.queryResponse;

    if (!loadedPrompt) {
      throw new Error("Missing query response prompt in query graph dependencies");
    }

    const seededContextItems = scopedSeededItems(state, inventory);
    const focusedVisualCrops = seededContextItems.length > 0
      ? await buildFocusedVisualCrops({
        imageId: state.imageId,
        inventory,
        itemIds: scopedVisualItemIds(state, inventory),
        seededItems: seededContextItems,
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
          model: VISION_MODEL,
        },
      },
    );

    const answer = extractMessageText(response);

    return {
      answer,
      visualEvidence: focusedVisualCrops.map((crop) => ({
        itemId: crop.itemId,
        displayName: crop.displayName,
        dataUrl: crop.dataUrl,
      })),
    };
  };
}
