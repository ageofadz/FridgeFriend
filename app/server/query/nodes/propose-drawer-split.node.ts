import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { interrupt } from "@langchain/langgraph";
import { z } from "zod";

import { applyFridgeInventorySplit, getFridgeInventoryForImage } from "../../inventories.server";
import type { Inventory } from "../../scan/schemas/inventory";
import { VISION_MODEL } from "../../scan/schemas/inventory";
import { createVisionModel } from "../../scan/services/vision-model.server";
import { ConversationContextSchema } from "../../../workspace/contracts";
import type { QueryGraphDependencies } from "../schemas/query";
import { QueryResumeSchema } from "../schemas/query";
import { cropImageBoundingBoxDataUrl } from "../services/focused-visual-context.server";
import type { FridgeQueryStateValue } from "../state";

const DrawerSplitProposalSchema = z.object({
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

type DrawerSplitProposal = z.infer<typeof DrawerSplitProposalSchema> & {
  zoneId: string;
  zoneType: Inventory["zones"][number]["type"];
};

function selectedZoneId(state: FridgeQueryStateValue) {
  const context = ConversationContextSchema.catch({
    selectedItemIds: [],
    selectedZoneIds: [],
    selectedRecipeId: null,
    seededItems: [],
  }).parse(state.context.conversationContext);
  return context.selectedZoneIds.length === 1 ? context.selectedZoneIds[0] : null;
}

function storedProposal(state: FridgeQueryStateValue) {
  const proposal = DrawerSplitProposalSchema.extend({
    zoneId: z.string(),
    zoneType: z.enum(["shelf", "drawer", "door_shelf", "freezer", "pantry", "unknown"]),
  }).safeParse(state.context.drawerSplitProposal);
  return proposal.success ? proposal.data : null;
}

export function createProposeDrawerSplitNode(deps: QueryGraphDependencies = {}) {
  return async function proposeDrawerSplitNode(state: FridgeQueryStateValue) {
    const zoneId = selectedZoneId(state);
    if (!zoneId || !state.imageId || state.intent !== "inventory") return {};

    const inventory = await (deps.loadInventoryForImage ?? getFridgeInventoryForImage)(state.imageId);
    const zone = inventory?.zones.find((candidate) => candidate.id === zoneId);
    const coarseItems = inventory?.items.filter((item) => item.loc.zoneId === zoneId) ?? [];
    if (!inventory || !zone || zone.type !== "drawer" || coarseItems.length === 0) return {};

    try {
      const crop = await cropImageBoundingBoxDataUrl({
        imageId: state.imageId,
        boundingBox: zone.boundingBox,
        loadImageDataUrlForQuery: deps.loadImageDataUrlForQuery,
      });
      const model = deps.drawerSplitModel ?? createVisionModel();
      const structuredModel = model.withStructuredOutput(DrawerSplitProposalSchema, { name: "DrawerInventorySplitProposal" });
      const result = await structuredModel.invoke([
        new SystemMessage("Inspect only the supplied drawer crop. Split a coarse bag or mixed-container detection into separate visible food items only when the crop supports at least two distinct items. Use replaceItemIds only for supplied coarse items that the proposed items replace. Keep bounding boxes within the original image coordinate system. Return no proposal when a split is not visually supported."),
        new HumanMessage([
          { type: "text", text: JSON.stringify({ zoneId, zoneType: zone.type, zoneBoundingBox: zone.boundingBox, coarseItems: coarseItems.map((item) => ({ id: item.id, label: item.label, name: item.name, boundingBoxes: item.loc.observations.filter((observation) => observation.imageId === state.imageId).map((observation) => observation.boundingBox) })) }) },
          { type: "image_url", image_url: { url: crop } },
        ]),
      ], { tags: ["query", "drawer_split_proposal"], metadata: { imageId: state.imageId, zoneId, model: VISION_MODEL } });
      const parsed = DrawerSplitProposalSchema.safeParse(result);
      if (!parsed.success) {
        return { context: { ...state.context, drawerSplitError: `Drawer split proposal returned invalid output: ${parsed.error.issues.map((issue) => issue.message).join("; ")}` } };
      }
      const allowedIds = new Set(coarseItems.map((item) => item.id));
      if (parsed.data.items.length < 2 || parsed.data.replaceItemIds.length === 0) {
        return {};
      }
      if (parsed.data.replaceItemIds.some((itemId) => !allowedIds.has(itemId))) {
        return { context: { ...state.context, drawerSplitError: "Drawer split proposal referenced an item outside the selected drawer." } };
      }
      return {
        context: {
          ...state.context,
          drawerSplitProposal: { ...parsed.data, zoneId, zoneType: zone.type },
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { context: { ...state.context, drawerSplitError: `Drawer split proposal failed: ${message}` } };
    }
  };
}

export function routeDrawerSplitReview(state: FridgeQueryStateValue) {
  return storedProposal(state) ? "review" : "end";
}

export function reviewDrawerSplitNode(state: FridgeQueryStateValue) {
  const proposal = storedProposal(state);
  if (!proposal) return {};
  const resumed = interrupt({
    type: "inventory_split_review",
    zoneId: proposal.zoneId,
    summary: proposal.summary,
    items: proposal.items.map((item) => ({ label: item.label, name: item.name })),
  });
  const resume = QueryResumeSchema.safeParse(resumed);
  if (!resume.success || !resume.data.splitReview?.approved || !state.imageId) {
    return { answer: state.answer, context: { ...state.context, drawerSplitProposal: null } };
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
  return { answer: state.answer, context: { ...state.context, drawerSplitProposal: null } };
}
