import { z } from "zod";

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

export const MINIMUM_SUPPORT_ZONE_WIDTH_RATIO = 0.04;

const RelativeZonePosition = z.enum(RELATIVE_ZONE_POSITIONS);

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

const StackingHint = z.object({
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
  zone: PredictedZoneHint.nullable().optional(),
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
  surfaceY: z.number().min(0).max(1).optional(),
  ord: z.number().int().nonnegative().nullable(),
  name: z.string(),
  conf: z.number().min(0).max(1),
  partial: z.boolean().default(false),
}).superRefine((zone, context) => {
  if (zone.bbox.width < MINIMUM_SUPPORT_ZONE_WIDTH_RATIO) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["bbox", "width"],
      message: `Support zone width must be at least ${MINIMUM_SUPPORT_ZONE_WIDTH_RATIO}`,
    });
  }
});

export const FridgeZoneMap = z.object({
  imageId: z.string(),
  zones: z.array(FridgeZoneDetection),
});

const InventoryLocationObservation = z.object({
  imageId: z.string(),
  depthBackRatio: z.number().min(0).max(1).nullable(),
  boundingBox: z.object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    width: z.number().positive().max(1),
    height: z.number().positive().max(1),
  }),
});

const InventoryLocation = z.object({
  status: z.enum(["matched", "unmatched", "needs_review"]),
  zoneId: z.string().nullable(),
  zoneType: ZoneType.nullable(),
  observations: z.array(InventoryLocationObservation),
  confidence: z.number().min(0).max(1).nullable(),
  assignment: z.object({
    source: z.enum(["scan", "user_confirmed"]),
    planId: z.string().nullable(),
    updatedAt: z.string().nullable(),
  }).optional(),
});

const SceneDepthInterval = z.object({
  back: z.number().min(0).max(1),
  front: z.number().min(0).max(1),
}).refine(({ back, front }) => back < front, {
  message: "Scene depth interval must have back less than front",
});

export const GroundedPlacement = z.discriminatedUnion("status", [
  z.object({
    detectionId: z.string(),
    status: z.literal("placed"),
    supportKind: z.enum(["zone", "item"]),
    supportId: z.string(),
    depth: SceneDepthInterval,
    confidence: z.number().min(0).max(1),
  }),
  z.object({
    detectionId: z.string(),
    status: z.literal("needs_review"),
    reason: z.string().min(1),
    confidence: z.number().min(0).max(1),
  }),
]);

export type GroundedPlacementValue = z.infer<typeof GroundedPlacement>;

const InventoryScenePlacement = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("placed"),
    supportKind: z.enum(["zone", "item"]),
    supportId: z.string(),
    depth: SceneDepthInterval,
    confidence: z.number().min(0).max(1),
  }),
  z.object({
    status: z.literal("needs_review"),
    reason: z.string().min(1),
    confidence: z.number().min(0).max(1),
  }),
]);

const QuantityEstimate = z.object({
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
  scene: InventoryScenePlacement.optional(),
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
  source: z.enum(["mocked-vision", "gemini-vision", "anthropic-vision"]),
  model: z.string(),
  createdAt: z.string(),
  sceneVersion: z.literal("image-grounded-v2").optional(),
  items: z.array(InventoryItem),
  zones: z.array(
    z.object({
      id: z.string(),
      type: ZoneType,
      label: z.string(),
      order: z.number().nullable(),
      boundingBox: BoundingBox,
      surfaceY: z.number().min(0).max(1).optional(),
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
export type ZoneType = z.infer<typeof ZoneType>;
