import { z } from "zod";

export const WorkspaceViewSchema = z.enum(["scene", "photo", "compare"]);
export const WorkspaceLocationSchema = z.enum([
  "fridge",
  "freezer",
  "pantry",
  "all_inventory",
]);

export const ConversationContextSchema = z.object({
  selectedItemIds: z.array(z.string()).default([]),
  selectedZoneIds: z.array(z.string()).default([]),
  selectedRecipeId: z.string().nullable().default(null),
  seededItems: z.array(z.object({
    itemId: z.string(),
    imageId: z.string(),
    cropId: z.string(),
    userSeeded: z.literal(true).default(true),
  })).default([]),
});

export const WorkspaceFocusSchema = z.object({
  mode: z.enum(["overview", "item", "zone", "recipe", "comparison"]),
  itemIds: z.array(z.string()),
  zoneIds: z.array(z.string()),
  recipeId: z.string().nullable(),
  emphasis: z.enum(["none", "highlight", "isolate", "warning", "candidate"]),
  reason: z.string().nullable(),
});

export const WorkspaceSelectionSchema = z.object({
  itemIds: z.array(z.string()),
  source: z.enum(["agent", "user"]),
  pinned: z.boolean(),
});

export const WorkspaceBoundingBoxSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  width: z.number().positive().max(1),
  height: z.number().positive().max(1),
});

export const WorkspaceActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("focus_items"),
    itemIds: z.array(z.string()).min(1),
    emphasis: WorkspaceFocusSchema.shape.emphasis.default("highlight"),
    reason: z.string().nullable().default(null),
  }),
  z.object({
    type: z.literal("focus_zone"),
    zoneId: z.string(),
    reason: z.string().nullable().default(null),
  }),
  z.object({
    type: z.literal("show_evidence"),
    itemId: z.string(),
    imageId: z.string(),
    boundingBox: WorkspaceBoundingBoxSchema,
  }),
  z.object({
    type: z.literal("show_recipe_coverage"),
    recipeId: z.string(),
    availableItemIds: z.array(z.string()),
    uncertainItemIds: z.array(z.string()).default([]),
    missingIngredients: z.array(z.string()),
  }),
  z.object({
    type: z.literal("show_freshness"),
    itemIds: z.array(z.string()).min(1),
  }),
  z.object({
    type: z.literal("preview_reorganization"),
    placements: z.array(z.object({ itemId: z.string(), zoneId: z.string() })).min(1),
  }),
  z.object({ type: z.literal("reset_view") }),
]);

export const AgentActivityEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("enrichment_started"), itemId: z.string(), fields: z.array(z.string()).min(1) }),
  z.object({ type: z.literal("enrichment_completed"), itemId: z.string(), fields: z.array(z.string()).min(1) }),
  z.object({ type: z.literal("enrichment_failed"), itemId: z.string(), error: z.string() }),
  z.object({ type: z.literal("inventory_assertion_applied"), itemId: z.string(), cropId: z.string(), label: z.string().min(1) }),
  z.object({ type: z.literal("clarification_required"), itemId: z.string().nullable(), question: z.string() }),
]);

export type ConversationContext = z.infer<typeof ConversationContextSchema>;
export type ConversationContextSeededItem = ConversationContext["seededItems"][number];
export type WorkspaceFocus = z.infer<typeof WorkspaceFocusSchema>;
export type WorkspaceSelection = z.infer<typeof WorkspaceSelectionSchema>;
export type WorkspaceAction = z.infer<typeof WorkspaceActionSchema>;
export type AgentActivityEvent = z.infer<typeof AgentActivityEventSchema>;

export function inventorySeedCropId(input: {
  imageId: string;
  itemId: string;
  observationIndex: number;
}) {
  return `${input.imageId}:${input.itemId}:${input.observationIndex}`;
}

export function emptyWorkspaceFocus(): WorkspaceFocus {
  return {
    mode: "overview",
    itemIds: [],
    zoneIds: [],
    recipeId: null,
    emphasis: "none",
    reason: null,
  };
}

export function focusFromWorkspaceAction(action: WorkspaceAction): WorkspaceFocus {
  if (action.type === "focus_items") {
    return { mode: "item", itemIds: action.itemIds, zoneIds: [], recipeId: null, emphasis: action.emphasis, reason: action.reason };
  }

  if (action.type === "focus_zone") {
    return { mode: "zone", itemIds: [], zoneIds: [action.zoneId], recipeId: null, emphasis: "highlight", reason: action.reason };
  }

  if (action.type === "show_recipe_coverage") {
    return { mode: "recipe", itemIds: action.availableItemIds, zoneIds: [], recipeId: action.recipeId, emphasis: "candidate", reason: null };
  }

  if (action.type === "show_freshness") {
    return { mode: "item", itemIds: action.itemIds, zoneIds: [], recipeId: null, emphasis: "warning", reason: "Freshness assessment" };
  }

  if (action.type === "preview_reorganization") {
    return { mode: "zone", itemIds: action.placements.map((placement) => placement.itemId), zoneIds: action.placements.map((placement) => placement.zoneId), recipeId: null, emphasis: "candidate", reason: "Proposed reorganization" };
  }

  return emptyWorkspaceFocus();
}
