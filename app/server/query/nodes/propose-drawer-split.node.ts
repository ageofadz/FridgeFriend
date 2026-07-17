import { interrupt } from "@langchain/langgraph";
import { z } from "zod";

import {
  CHAT_VISION_PROVIDER as CHAT_PROVIDER,
  CHAT_VISION_MODEL as VISION_MODEL,
} from "../../ai/chat-model.server";
import { applyFridgeInventorySplit, getFridgeInventoryForImage } from "../../inventories.server";
import type { Inventory } from "../../scan/schemas/inventory";
import { createVisionModel } from "../../scan/services/vision-model.server";
import { promptMessages } from "../../scan/services/prompt-messages.server";
import type { QueryGraphDependencies } from "../schemas/query";
import { QueryResumeSchema } from "../schemas/query";
import { conversationContextFromState } from "../services/conversation-context.server";
import {
  cropImageBoundingBoxDataUrl,
  parseInventoryCropId,
} from "../services/focused-visual-context.server";
import type { FridgeQueryStateValue } from "../state";

const ScopedInventorySplitProposalSchema = z.object({
  summary: z.string().min(1),
  replaceItemIds: z.array(z.string()).default([]),
  items: z.array(z.object({
    name: z.string().min(1),
    label: z.string().min(1),
    category: z.enum(["produce", "dairy", "meat", "seafood", "eggs", "prepared_food", "beverage", "condiment", "leftovers", "other"]),
    packaging: z.enum(["loose", "bottle", "jar", "can", "carton", "bag", "box", "tray", "container", "unknown"]),
    boundingBox: z.object({
      x: z.number().min(0).max(1),
      y: z.number().min(0).max(1),
      width: z.number().positive().max(1),
      height: z.number().positive().max(1),
    }),
  })).max(8),
});

type InventoryScope = {
  label: string;
  boundingBox: Inventory["zones"][number]["boundingBox"];
  zoneId: string | null;
  zoneType: Inventory["items"][number]["loc"]["zoneType"];
  replaceItemIds: string[];
};

function normalizedTerms(value: string) {
  return new Set(value
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean));
}

function zoneMatchesDirection(
  zone: Inventory["zones"][number],
  zones: Inventory["zones"],
  direction: "top" | "bottom" | "middle" | "left" | "right",
) {
  const vertical = direction === "top" || direction === "bottom" || direction === "middle";
  const ordered = [...zones].sort((left, right) => {
    const leftCenter = vertical
      ? left.boundingBox.y + left.boundingBox.height / 2
      : left.boundingBox.x + left.boundingBox.width / 2;
    const rightCenter = vertical
      ? right.boundingBox.y + right.boundingBox.height / 2
      : right.boundingBox.x + right.boundingBox.width / 2;
    return leftCenter - rightCenter;
  });
  const index = ordered.findIndex((candidate) => candidate.id === zone.id);
  if (index < 0) return false;
  const third = Math.max(1, Math.ceil(ordered.length / 3));
  if (direction === "top" || direction === "left") return index < third;
  if (direction === "bottom" || direction === "right") return index >= ordered.length - third;
  return index >= third && index < ordered.length - third;
}

function semanticZoneScope(state: FridgeQueryStateValue, inventory: Inventory) {
  const selectedZoneIds = conversationContextFromState(state).selectedZoneIds;
  if (selectedZoneIds.length === 1) {
    const zone = inventory.zones.find((candidate) => candidate.id === selectedZoneIds[0]);
    if (!zone) return null;
    return {
      label: zone.label,
      boundingBox: zone.boundingBox,
      zoneId: zone.id,
      zoneType: zone.type,
      replaceItemIds: inventory.items.filter((item) => item.loc.zoneId === zone.id).map((item) => item.id),
    } satisfies InventoryScope;
  }

  const terms = normalizedTerms(state.query);
  const typeTerms: Array<[Inventory["zones"][number]["type"], string[]]> = [
    ["shelf", ["shelf"]],
    ["drawer", ["drawer"]],
    ["door_shelf", ["door", "bin"]],
    ["freezer", ["freezer"]],
    ["pantry", ["pantry"]],
  ];
  const directions = ["top", "bottom", "middle", "left", "right"] as const;
  const matches = inventory.zones.map((zone) => {
    const labelTerms = normalizedTerms(zone.label);
    let score = [...labelTerms].filter((term) => terms.has(term)).length * 2;
    if (typeTerms.some(([type, aliases]) => type === zone.type && aliases.some((alias) => terms.has(alias)))) score += 4;
    for (const direction of directions) {
      if (terms.has(direction) && zoneMatchesDirection(zone, inventory.zones, direction)) score += 1;
    }
    return { zone, score };
  }).filter((match) => match.score > 0);
  const highestScore = Math.max(...matches.map((match) => match.score), 0);
  const best = matches.filter((match) => match.score === highestScore);
  if (best.length !== 1) return null;
  const zone = best[0].zone;
  return {
    label: zone.label,
    boundingBox: zone.boundingBox,
    zoneId: zone.id,
    zoneType: zone.type,
    replaceItemIds: inventory.items.filter((item) => item.loc.zoneId === zone.id).map((item) => item.id),
  } satisfies InventoryScope;
}

function seededAreaScope(state: FridgeQueryStateValue, inventory: Inventory) {
  if (!state.imageId) return null;
  const seeds = conversationContextFromState(state).seededItems.filter((seed) => seed.imageId === state.imageId);
  if (seeds.length !== 1) return null;
  const seed = seeds[0];
  const parsed = parseInventoryCropId(seed.cropId);
  const item = inventory.items.find((candidate) => candidate.id === seed.itemId);
  const observation = item?.loc.observations[parsed.observationIndex];
  if (!item || !observation || parsed.imageId !== state.imageId || parsed.itemId !== item.id || observation.imageId !== state.imageId) {
    throw new Error(`Seeded area ${seed.cropId} could not be resolved from the current inventory`);
  }
  return {
    label: item.label,
    boundingBox: observation.boundingBox,
    zoneId: item.loc.zoneId,
    zoneType: item.loc.zoneType,
    replaceItemIds: [item.id],
  } satisfies InventoryScope;
}

export function resolveInventoryScope(state: FridgeQueryStateValue, inventory: Inventory) {
  return seededAreaScope(state, inventory) ?? semanticZoneScope(state, inventory);
}

function storedProposal(state: FridgeQueryStateValue) {
  const proposal = ScopedInventorySplitProposalSchema.extend({
    scopeLabel: z.string().min(1),
    boundingBox: z.object({
      x: z.number().min(0).max(1),
      y: z.number().min(0).max(1),
      width: z.number().positive().max(1),
      height: z.number().positive().max(1),
    }),
    zoneId: z.string().nullable(),
    zoneType: z.enum(["shelf", "drawer", "door_shelf", "freezer", "pantry", "unknown"]).nullable(),
  }).safeParse(state.context.inventorySplitProposal);
  return proposal.success ? proposal.data : null;
}

export function createProposeScopedInventorySplitNode(deps: QueryGraphDependencies = {}) {
  return async function proposeScopedInventorySplitNode(state: FridgeQueryStateValue) {
    if (!state.imageId || state.intent !== "inventory") return {};
    const inventory = await (deps.loadInventoryForImage ?? getFridgeInventoryForImage)(state.imageId);
    if (!inventory) return {};

    try {
      const scope = resolveInventoryScope(state, inventory);
      if (!scope || scope.replaceItemIds.length === 0) return {};
      const candidates = inventory.items.filter((item) => scope.replaceItemIds.includes(item.id));
      const crop = await cropImageBoundingBoxDataUrl({
        imageId: state.imageId,
        boundingBox: scope.boundingBox,
        loadImageDataUrlForQuery: deps.loadImageDataUrlForQuery,
      });
      const model = deps.inventorySplitModel ?? createVisionModel();
      const loadedPrompt = deps.promptBundle?.scopedInventorySplit;
      if (!loadedPrompt) throw new Error("Scoped inventory split prompt is unavailable.");
      const structuredModel = model.withStructuredOutput(ScopedInventorySplitProposalSchema, { name: "ScopedInventorySplitProposal" });
      const result = await structuredModel.invoke(await promptMessages(loadedPrompt, {
        scoped_inventory_split_context_json: JSON.stringify({ scopeLabel: scope.label, scopeBoundingBox: scope.boundingBox, zoneType: scope.zoneType, coarseItems: candidates.map((item) => ({ id: item.id, label: item.label, name: item.name, boundingBoxes: item.loc.observations.filter((observation) => observation.imageId === state.imageId).map((observation) => observation.boundingBox) })) }),
        image_data_url: crop,
      }), { tags: ["query", "scoped_inventory_split_proposal"], metadata: { imageId: state.imageId, scopeLabel: scope.label, provider: CHAT_PROVIDER, model: VISION_MODEL, langsmithPromptName: loadedPrompt.name, langsmithPromptRef: loadedPrompt.ref } });
      const parsed = ScopedInventorySplitProposalSchema.safeParse(result);
      if (!parsed.success) {
        return { context: { ...state.context, inventorySplitError: `Scoped inventory split proposal returned invalid output: ${parsed.error.issues.map((issue) => issue.message).join("; ")}` } };
      }
      const allowedIds = new Set(scope.replaceItemIds);
      if (parsed.data.items.length < 2 || parsed.data.replaceItemIds.length === 0) return {};
      if (parsed.data.replaceItemIds.some((itemId) => !allowedIds.has(itemId))) {
        return { context: { ...state.context, inventorySplitError: "Scoped inventory split proposal referenced an item outside the selected area." } };
      }
      return {
        context: {
          ...state.context,
          inventorySplitProposal: { ...parsed.data, scopeLabel: scope.label, boundingBox: scope.boundingBox, zoneId: scope.zoneId, zoneType: scope.zoneType },
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { context: { ...state.context, inventorySplitError: `Scoped inventory split proposal failed: ${message}` } };
    }
  };
}

export function routeScopedInventorySplitReview(state: FridgeQueryStateValue) {
  return storedProposal(state) ? "review" : "end";
}

export function reviewScopedInventorySplitNode(state: FridgeQueryStateValue) {
  const proposal = storedProposal(state);
  if (!proposal) return {};
  const resumed = interrupt({
    type: "inventory_split_review",
    scopeLabel: proposal.scopeLabel,
    summary: proposal.summary,
    items: proposal.items.map((item) => ({ label: item.label, name: item.name })),
  });
  const resume = QueryResumeSchema.safeParse(resumed);
  if (!resume.success || !resume.data.splitReview?.approved || !state.imageId) {
    return { answer: state.answer, context: { ...state.context, inventorySplitProposal: null } };
  }
  applyFridgeInventorySplit({
    imageId: state.imageId,
    replaceItemIds: proposal.replaceItemIds,
    items: proposal.items.map((item) => ({
      name: item.name,
      label: item.label,
      category: item.category,
      packaging: item.packaging,
      boundingBox: item.boundingBox,
      zoneId: proposal.zoneId,
      zoneType: proposal.zoneType,
    })),
  });
  return { answer: state.answer, context: { ...state.context, inventorySplitProposal: null } };
}
