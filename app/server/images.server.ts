import { randomUUID } from "node:crypto";

import { desc, eq } from "drizzle-orm";

import { fridgeImages, fridgeInventories } from "./db/schema.server";
import { withDatabase } from "./sqlite.server";

const JPEG_DATA_URL_PREFIX = "data:image/jpeg;base64,";
const STORAGE_IMAGE_LOCATIONS = ["fridge", "freezer", "pantry"] as const;

export type FridgeImage = typeof fridgeImages.$inferSelect;
export type StorageImageLocation = typeof STORAGE_IMAGE_LOCATIONS[number];

export function assertJpegDataUrl(dataUrl: string) {
  if (!dataUrl.startsWith(JPEG_DATA_URL_PREFIX)) {
    throw new Error("Uploaded storage image must be a JPEG data URL");
  }
}

export function parseStorageImageLocation(value: FormDataEntryValue | null) {
  if (typeof value !== "string") {
    throw new Error("Missing storage location");
  }

  if (!STORAGE_IMAGE_LOCATIONS.includes(value as StorageImageLocation)) {
    throw new Error(`Unsupported storage location: ${value}`);
  }

  return value as StorageImageLocation;
}

export function listFridgeImages() {
  return withDatabase((db) =>
    db.select().from(fridgeImages).orderBy(desc(fridgeImages.createdAt)).all(),
  );
}

export function getFridgeImage(id: string) {
  return withDatabase((db) => {
    const image = db
      .select()
      .from(fridgeImages)
      .where(eq(fridgeImages.id, id))
      .get();

    return image ?? null;
  });
}

export function createFridgeImage(input: {
  dataUrl: string;
  originalName: string | null;
  storageLocation: StorageImageLocation;
  baseImageId: string | null;
}) {
  assertJpegDataUrl(input.dataUrl);

  const image = {
    id: randomUUID(),
    dataUrl: input.dataUrl,
    originalName: input.originalName,
    storageLocation: input.storageLocation,
    baseImageId: input.baseImageId,
    createdAt: new Date().toISOString(),
  };

  withDatabase((db) => {
    db.insert(fridgeImages).values(image).run();
  });

  return image;
}

export function deleteFridgeImage(id: string) {
  return withDatabase((db) => {
    db.delete(fridgeInventories)
      .where(eq(fridgeInventories.imageId, id))
      .run();
    db.delete(fridgeImages).where(eq(fridgeImages.id, id)).run();
  });
}
