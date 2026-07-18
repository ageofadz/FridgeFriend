import { ReducedValue, StateSchema } from "@langchain/langgraph";
import { z } from "zod";

import { FridgeZoneMap, GroundedPlacement, Inventory, RawDetection } from "./schemas/inventory";
import {
  ScanError,
  ValidationResult,
} from "./schemas/scan-result";

function mergeByKey<TItem>(
  current: TItem[],
  next: TItem[],
  keyFor: (item: TItem) => string,
) {
  const merged = new Map(current.map((item) => [keyFor(item), item]));

  for (const item of next) {
    merged.set(keyFor(item), item);
  }

  return Array.from(merged.values());
}

export const ScanState = new StateSchema({
  fridgeId: z.string(),
  imageIds: z.array(z.string()),
  storageLocation: z.enum(["fridge", "freezer", "pantry"]),
  rawDetections: new ReducedValue(z.array(RawDetection).default(() => []), {
    reducer: (current, next) =>
      mergeByKey(current, next, (detection) => detection.id),
  }),
  detectionModelRawOutput: z.unknown().nullable().default(null),
  zoneMaps: new ReducedValue(z.array(FridgeZoneMap).default(() => []), {
    reducer: (current, next) =>
      mergeByKey(current, next, (zoneMap) => zoneMap.imageId),
  }),
  zoneMapModelRawOutput: z.unknown().nullable().default(null),
  groundedPlacements: new ReducedValue(z.array(GroundedPlacement).default(() => []), {
    reducer: (current, next) => mergeByKey(current, next, (placement) => placement.detectionId),
  }),
  inventory: Inventory.nullable().default(null),
  imageValidation: ValidationResult.nullable().default(null),
  detectionValidation: ValidationResult.nullable().default(null),
  zoneMapValidation: ValidationResult.nullable().default(null),
  placementValidation: ValidationResult.nullable().default(null),
  inventoryValidation: ValidationResult.nullable().default(null),
  scanStatus: z
    .enum(["pending", "processing", "completed", "failed"])
    .default("pending"),
  error: ScanError.nullable().default(null),
});

export type ScanStateValue = typeof ScanState.State;
