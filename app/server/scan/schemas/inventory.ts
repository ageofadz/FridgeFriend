import { z } from "zod";

export const VISION_MODEL = "gemini-3.5-flash";
export const IMAGE_VALIDATION_MODEL = "gemini-3.1-flash-lite-preview";
export const INVENTORY_REVIEW_STATUS_COLORS = {
  needs_review: 0xb7791f,
  unmatched: 0x7a869a,
} as const;

export const INVENTORY_PACKAGING_COLORS = {
  bottle: 0x3a86ff,
  jar: 0x65a30d,
  carton: 0xf59e0b,
  bag: 0xd946ef,
  box: 0x14b8a6,
  tray: 0xef4444,
  container: 0x8b5cf6,
  loose: 0x22c55e,
  can: 0x64748b,
  unknown: 0x94a3b8,
} as const;

export const DEFAULT_INVENTORY_ITEM_COLOR = INVENTORY_PACKAGING_COLORS.unknown;

export const RELATIVE_ZONE_POSITIONS = [
  "top",
  "middle",
  "bottom",
  "left",
  "right",
  "unknown",
] as const;

export const ZoneType = z.enum([
  "shelf",
  "drawer",
  "door_shelf",
  "freezer",
  "pantry",
  "unknown",
]);

export const RelativeZonePosition = z.enum(RELATIVE_ZONE_POSITIONS);

export const NormalizedBoundingBox = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  width: z.number().positive().max(1),
  height: z.number().positive().max(1),
}).refine(
  ({ x, width }) => x + width <= 1,
  "Bounding box extends beyond image width",
).refine(
  ({ y, height }) => y + height <= 1,
  "Bounding box extends beyond image height",
);

export const BoundingBox = NormalizedBoundingBox;

export const PredictedZoneHint = z.object({
  zoneType: ZoneType,
  relativePosition: RelativeZonePosition.nullable(),
  confidence: z.number().min(0).max(1),
});

export const StackingHint = z.object({
  on: z.string(),
  conf: z.number().min(0).max(1),
  why: z.string(),
});

export const RawDetection = z.object({
  id: z.string(),
  img: z.string(),
  name: z.string(),
  conf: z.number().min(0).max(1),
  bbox: BoundingBox,
  zone: PredictedZoneHint.nullable(),
  stack: StackingHint.optional(),
  pack: z
    .enum([
      "loose",
      "bottle",
      "jar",
      "carton",
      "bag",
      "box",
      "tray",
      "container",
      "unknown",
    ]),
  qty: z.string().nullable(),
});

export const FridgeZoneDetection = z.object({
  id: z.string(),
  img: z.string(),
  type: ZoneType,
  bbox: BoundingBox,
  ord: z.number().int().nonnegative().nullable(),
  name: z.string(),
  conf: z.number().min(0).max(1),
  partial: z.boolean().default(false),
});

export const FridgeZoneMap = z.object({
  imageId: z.string(),
  zones: z.array(FridgeZoneDetection),
});

export const InventoryLocationObservation = z.object({
  imageId: z.string(),
  depthBackRatio: z.number().min(0).max(1).nullable(),
  boundingBox: z.object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    width: z.number().positive().max(1),
    height: z.number().positive().max(1),
  }),
});

export const InventoryLocation = z.object({
  status: z.enum(["matched", "unmatched", "needs_review"]),
  zoneId: z.string().nullable(),
  zoneType: ZoneType.nullable(),
  observations: z.array(InventoryLocationObservation),
  confidence: z.number().min(0).max(1).nullable(),
});

export const QuantityEstimate = z.object({
  amount: z.number().nonnegative().nullable(),
  unit: z.enum([
    "count",
    "g",
    "kg",
    "oz",
    "lb",
    "ml",
    "l",
    "package",
    "container",
    "unknown",
  ]),
  precision: z.enum(["exact", "estimated", "unknown"]),
  fillLevel: z.number().min(0).max(1).nullable(),
});

export const VisualEnrichment = z.object({
  query: z.string().min(1),
  response: z.string().min(1),
  imageId: z.string(),
  boundingBox: InventoryLocationObservation.shape.boundingBox,
  observedAt: z.string(),
});

export const InventoryEnrichmentField = z.enum([
  "identity",
  "quantity",
  "fill_level",
  "expiration_date",
  "opened",
]);

export const InventoryEnrichment = z.object({
  source: z.enum(["focused_vlm", "user", "inference"]),
  fields: z.array(InventoryEnrichmentField).min(1),
  confidence: z.number().min(0).max(1),
  observedAt: z.string(),
  imageId: z.string().nullable(),
  boundingBox: InventoryLocationObservation.shape.boundingBox.nullable(),
  values: z.object({
    label: z.string().nullable(),
    variant: z.string().nullable(),
    amount: z.number().nonnegative().nullable(),
    unit: QuantityEstimate.shape.unit.nullable(),
    fillLevel: z.number().min(0).max(1).nullable(),
    expirationDate: z.string().nullable(),
    opened: z.boolean().nullable(),
  }),
});

export const InventoryItem = z.object({
  id: z.string(),
  name: z.string(),
  label: z.string(),
  cat: z.enum([
    "produce",
    "dairy",
    "meat",
    "seafood",
    "eggs",
    "prepared_food",
    "beverage",
    "condiment",
    "leftovers",
    "other",
  ]),
  subcat: z.string().nullable(),
  qty: QuantityEstimate,
  pack: z.enum([
    "loose",
    "bottle",
    "jar",
    "can",
    "carton",
    "bag",
    "box",
    "tray",
    "container",
    "unknown",
  ]),
  stack: StackingHint.optional(),
  loc: InventoryLocation,
  conf: z.number().min(0).max(1),
  src: z.array(z.string()),
  attrs: z.object({
    brand: z.string().nullable(),
    variant: z.string().nullable(),
    opened: z.boolean().nullable(),
    expirationDate: z.string().nullable(),
    expirationDateSource: z.enum(["user", "observed"]).nullable().optional(),
  }),
  visual: z.array(VisualEnrichment).optional(),
  enrichments: z.array(InventoryEnrichment).optional(),
  review: z
    .enum(["confirmed", "inferred", "needs_review"])
    .default("inferred"),
});

export const Inventory = z.object({
  id: z.string(),
  fridgeId: z.string(),
  scanId: z.string(),
  source: z.enum(["mocked-vision", "gemini-vision"]),
  model: z.string(),
  createdAt: z.string(),
  items: z.array(InventoryItem),
  zones: z.array(
    z.object({
      id: z.string(),
      type: ZoneType,
      label: z.string(),
      order: z.number().nullable(),
      boundingBox: BoundingBox,
      imageIds: z.array(z.string()),
      sourceZoneDetectionIds: z.array(z.string()),
      confidence: z.number().min(0).max(1),
      estimatedCapacityRatio: z.number().min(0).max(1).nullable(),
      estimatedOccupiedRatio: z.number().min(0).max(1).nullable(),
    }),
  ),
});

export type RawDetection = z.infer<typeof RawDetection>;
export type FridgeZoneDetection = z.infer<typeof FridgeZoneDetection>;
export type FridgeZoneMap = z.infer<typeof FridgeZoneMap>;
export type InventoryItem = z.infer<typeof InventoryItem>;
export type Inventory = z.infer<typeof Inventory>;
export type VisualEnrichment = z.infer<typeof VisualEnrichment>;
export type InventoryEnrichment = z.infer<typeof InventoryEnrichment>;
export type InventoryEnrichmentField = z.infer<typeof InventoryEnrichmentField>;
export type NormalizedBoundingBox = z.infer<typeof NormalizedBoundingBox>;
export type StackingHint = z.infer<typeof StackingHint>;
export type ZoneType = z.infer<typeof ZoneType>;

export function inventoryItemColor(item: InventoryItem) {
  if (item.loc.status === "needs_review") {
    return INVENTORY_REVIEW_STATUS_COLORS.needs_review;
  }

  if (item.loc.status === "unmatched") {
    return INVENTORY_REVIEW_STATUS_COLORS.unmatched;
  }

  return INVENTORY_PACKAGING_COLORS[item.pack] ??
    DEFAULT_INVENTORY_ITEM_COLOR;
}
