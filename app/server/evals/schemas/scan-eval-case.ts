import { z } from "zod";

import { BaseEvalCaseSchema, BoundingBoxSchema, ImageFixtureSchema, ReplayStepSchema, StorageLocationSchema } from "./query-eval-case";

export const GoldDetectionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  boundingBox: BoundingBoxSchema,
  zoneId: z.string().nullable().default(null),
});
export type GoldDetection = z.infer<typeof GoldDetectionSchema>;

export const GoldZoneSchema = z.object({
  zoneId: z.string().min(1),
  label: z.string().min(1),
  boundingBox: BoundingBoxSchema,
});
export type GoldZone = z.infer<typeof GoldZoneSchema>;

export const GoldPlacementSchema = z.object({
  detectionId: z.string().min(1),
  zoneId: z.string().min(1),
});
export type GoldPlacement = z.infer<typeof GoldPlacementSchema>;

export const GoldInventoryItemSchema = z.looseObject({
  name: z.string().min(1),
  storageLocation: StorageLocationSchema,
});
export type GoldInventoryItem = z.infer<typeof GoldInventoryItemSchema>;

export const ScanCaseInputSchema = z.object({
  fridgeId: z.string().min(1),
  imageId: z.string().min(1),
  storageLocation: StorageLocationSchema,
});
export type ScanCaseInput = z.infer<typeof ScanCaseInputSchema>;

export const ScanExpectationSchema = z.object({
  terminalRoute: z.enum(["finalize_scan", "scan_failed"]),
  imageValid: z.boolean().optional(),
  requiredNodes: z.array(z.string()).default([]),
  forbiddenNodes: z.array(z.string()).default([]),
  detections: z.array(GoldDetectionSchema).optional(),
  zones: z.array(GoldZoneSchema).optional(),
  placements: z.array(GoldPlacementSchema).optional(),
  inventoryItems: z.array(GoldInventoryItemSchema).optional(),
  minimumDetectionPrecision: z.number().min(0).max(1).default(0.5),
  minimumDetectionRecall: z.number().min(0).max(1).default(0.5),
  minimumMatchedIou: z.number().min(0).max(1).default(0.5),
});
export type ScanExpectation = z.infer<typeof ScanExpectationSchema>;

export const ScanEvalCaseSchema = BaseEvalCaseSchema.extend({
  input: ScanCaseInputSchema,
  fixtures: z.object({
    images: z.array(ImageFixtureSchema).min(1),
  }),
  replay: z.array(ReplayStepSchema).optional(),
  expected: ScanExpectationSchema,
});
export type ScanEvalCase = z.infer<typeof ScanEvalCaseSchema>;
