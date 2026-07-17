import { z } from "zod";

import {
  Inventory,
  RawDetection,
} from "../server/scan/schemas/inventory";
import { STORAGE_IMAGE_LOCATIONS } from "./contracts";

const StreamingFridgeImage = z.object({
  id: z.string(),
  originalName: z.string().nullable(),
  storageLocation: z.enum(STORAGE_IMAGE_LOCATIONS),
  baseImageId: z.string().nullable(),
  createdAt: z.string(),
});

export const ScanStreamEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("image_created"),
    image: StreamingFridgeImage,
  }),
  z.object({
    type: z.literal("status"),
    node: z.string(),
  }),
  z.object({
    type: z.literal("raw_detections"),
    imageId: z.string(),
    rawDetections: z.array(RawDetection),
  }),
  z.object({
    type: z.literal("invalid_storage_image"),
    reason: z.string(),
  }),
  z.object({
    type: z.literal("complete"),
    imageId: z.string(),
    inventory: Inventory,
  }),
  z.object({
    type: z.literal("error"),
    error: z.string(),
  }),
]);

export type ScanStreamEvent = z.infer<typeof ScanStreamEventSchema>;
export type StreamingFridgeImage = z.infer<typeof StreamingFridgeImage>;
