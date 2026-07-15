import { randomUUID } from "node:crypto";

import { desc, eq } from "drizzle-orm";

import { fridgeImages } from "./db/schema.server";
import { withDatabase } from "./sqlite.server";

const JPEG_DATA_URL_PREFIX = "data:image/jpeg;base64,";

export type FridgeImage = typeof fridgeImages.$inferSelect;

export function assertJpegDataUrl(dataUrl: string) {
  if (!dataUrl.startsWith(JPEG_DATA_URL_PREFIX)) {
    throw new Error("Uploaded fridge image must be a JPEG data URL");
  }
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
}) {
  assertJpegDataUrl(input.dataUrl);

  const image = {
    id: randomUUID(),
    dataUrl: input.dataUrl,
    originalName: input.originalName,
    createdAt: new Date().toISOString(),
  };

  withDatabase((db) => {
    db.insert(fridgeImages).values(image).run();
  });

  return image;
}
