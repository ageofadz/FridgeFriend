import { z } from "zod";

import {
  FridgeZoneDetection,
  FridgeZoneMap,
  PredictedZoneHint,
  RawDetection,
  RELATIVE_ZONE_POSITIONS,
  ZoneType,
} from "./inventory";

const BOX_JSON_SCHEMA = {
  type: "object",
  properties: {
    x: { type: "number" },
    y: { type: "number" },
    width: { type: "number" },
    height: { type: "number" },
  },
  required: ["x", "y", "width", "height"],
} as const;

const ZONE_TYPES = ZoneType.options;

export const InventoryDetectionResponseSchema = {
  type: "object",
  properties: {
    rawDetections: {
      type: "array",
      description:
        "Raw visible food storage inventory detections, including unidentified visible inventory objects when the exact food or product is unclear.",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          img: { type: "string" },
          name: { type: "string" },
          conf: { type: "number" },
          bbox: BOX_JSON_SCHEMA,
          zone: {
            type: "object",
            properties: {
              zoneType: {
                type: "string",
                format: "enum",
                enum: ZONE_TYPES,
              },
              relativePosition: {
                type: "string",
                format: "enum",
                enum: RELATIVE_ZONE_POSITIONS,
                nullable: true,
              },
              confidence: { type: "number" },
            },
            description:
              "Optional weak evidence about the storage zone. This is not authoritative.",
            nullable: true,
            required: ["zoneType", "relativePosition", "confidence"],
          },
          stack: {
            type: "object",
            properties: {
              on: { type: "string" },
              conf: { type: "number" },
              why: { type: "string" },
            },
            description:
              "Optional weak evidence that this item is physically stacked on top of another detected item.",
            required: ["on", "conf", "why"],
          },
          pack: {
            type: "string",
            format: "enum",
            enum: [
              "loose",
              "bottle",
              "jar",
              "carton",
              "bag",
              "box",
              "tray",
              "container",
              "unknown",
            ],
          },
          qty: {
            type: "string",
            nullable: true,
          },
        },
        required: [
          "id",
          "img",
          "name",
          "conf",
          "bbox",
          "zone",
          "pack",
          "qty",
        ],
      },
    },
  },
  required: ["rawDetections"],
} as const;

export const ValidationResult = z.object({
  valid: z.boolean(),
  reason: z.string().optional(),
});

export const ImageValidationModelResult = z.object({
  isFridge: z.boolean().describe("Whether the image clearly shows the requested storage location."),
  reason: z.string().describe("Specific reason for the validation decision."),
});

const InventoryDetectionModelBoundingBox = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  width: z.number().min(0).max(1),
  height: z.number().min(0).max(1),
});

const InventoryDetectionModelRawDetection = z.object({
  id: z.string(),
  img: z.string(),
  name: z.string(),
  conf: z.number().min(0).max(1),
  bbox: InventoryDetectionModelBoundingBox,
  zone: PredictedZoneHint.nullable(),
  stack: RawDetection.shape.stack,
  pack: z.enum([
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

export const InventoryDetectionModelResult = z.object({
  rawDetections: z
    .array(InventoryDetectionModelRawDetection)
    .describe(
      "Raw visible food storage inventory detections, including unidentified visible inventory objects when the exact food or product is unclear.",
    ),
});

export const ZoneMapResponseSchema = {
  type: "object",
  properties: {
    imageId: { type: "string" },
    zones: {
      type: "array",
      description: "Image-local geometric food storage zones.",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          img: { type: "string" },
          type: {
            type: "string",
            format: "enum",
            enum: ZONE_TYPES,
          },
          bbox: BOX_JSON_SCHEMA,
          ord: {
            type: "number",
            nullable: true,
          },
          name: { type: "string" },
          conf: { type: "number" },
          partial: { type: "boolean" },
        },
        required: [
          "id",
          "img",
          "type",
          "bbox",
          "ord",
          "name",
          "conf",
          "partial",
        ],
      },
    },
  },
  required: ["imageId", "zones"],
} as const;

export const LocationAdjudicationResponseSchema = {
  type: "object",
  properties: {
    decisions: {
      type: "array",
      description:
        "Location decisions for ambiguous detections using only supplied candidate zone ids.",
      items: {
        type: "object",
        properties: {
          detectionId: { type: "string" },
          selectedZoneDetectionId: {
            type: "string",
            nullable: true,
          },
          confidence: { type: "number" },
          reason: { type: "string" },
        },
        required: [
          "detectionId",
          "selectedZoneDetectionId",
          "confidence",
          "reason",
        ],
      },
    },
  },
  required: ["decisions"],
} as const;

export const ZoneMapModelResult = FridgeZoneMap;

export const LocationAdjudicationDecision = z.object({
  detectionId: z.string(),
  selectedZoneDetectionId: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  reason: z.string(),
});

export const LocationAdjudicationModelResult = z.object({
  decisions: z.array(LocationAdjudicationDecision),
});

export const ZoneMatch = z.object({
  detectionId: z.string(),
  zoneDetectionId: z.string(),
  score: z.number(),
  containmentRatio: z.number().min(0).max(1),
  centerContained: z.boolean(),
});

export const ReconciledLocation = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("matched"),
    detectionId: z.string(),
    zone: FridgeZoneDetection,
    score: z.number(),
    match: ZoneMatch,
  }),
  z.object({
    status: z.literal("ambiguous"),
    detectionId: z.string(),
    candidates: z.array(ZoneMatch).min(1),
    reason: z.string(),
  }),
  z.object({
    status: z.literal("unmatched"),
    detectionId: z.string(),
    reason: z.string(),
  }),
]);

export const AmbiguousLocationRequest = z.object({
  imageId: z.string(),
  detectionId: z.string(),
  detectionBox: RawDetection.shape.bbox,
  candidateZones: z.array(
    z.object({
      zoneDetectionId: z.string(),
      type: ZoneType,
      boundingBox: RawDetection.shape.bbox,
    }),
  ),
  reason: z.string(),
});

export const ScanError = z.object({
  stage: z.enum([
    "validate_images",
    "detect_inventory",
    "map_zones",
    "reconcile_locations",
    "adjudicate_locations",
    "reconcile_inventory",
    "persist_scan",
  ]),
  code: z.string(),
  message: z.string(),
  retryable: z.boolean(),
});

export type ValidationResult = z.infer<typeof ValidationResult>;
export type ImageValidationModelResult = z.infer<typeof ImageValidationModelResult>;
export type InventoryDetectionModelResult = z.infer<typeof InventoryDetectionModelResult>;
export type ZoneMapModelResult = z.infer<typeof ZoneMapModelResult>;
export type LocationAdjudicationModelResult = z.infer<
  typeof LocationAdjudicationModelResult
>;
export type LocationAdjudicationDecision = z.infer<
  typeof LocationAdjudicationDecision
>;
export type ZoneMatch = z.infer<typeof ZoneMatch>;
export type ReconciledLocation = z.infer<typeof ReconciledLocation>;
export type AmbiguousLocationRequest = z.infer<
  typeof AmbiguousLocationRequest
>;
export type ScanError = z.infer<typeof ScanError>;
