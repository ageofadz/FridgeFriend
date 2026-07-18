import { readFileSync } from "node:fs";
import path from "node:path";

import type { ImageFixture } from "../schemas/query-eval-case";

/**
 * Resolves case image fixtures to data URLs without touching the SQLite
 * image store. Fixtures either embed a data URL directly or point at a
 * committed image file relative to the repository root.
 */
export function createFixtureImageResolver(images: ImageFixture[]) {
  const byId = new Map(images.map((image) => [image.imageId, image]));

  function resolve(imageId: string): string {
    const fixture = byId.get(imageId);

    if (!fixture) {
      throw new Error(
        `Fixture image "${imageId}" is not defined; known fixture images: ${[...byId.keys()].join(", ") || "none"}`,
      );
    }

    if (fixture.dataUrl) {
      return fixture.dataUrl;
    }

    if (fixture.fixturePath) {
      const bytes = readFileSync(path.resolve(process.cwd(), fixture.fixturePath));
      return `data:image/jpeg;base64,${bytes.toString("base64")}`;
    }

    throw new Error(`Fixture image "${imageId}" has neither a dataUrl nor a fixturePath`);
  }

  return {
    // Scan graph resolver.
    loadImageDataUrls: (imageIds: string[]) => imageIds.map(resolve),
    // Query graph resolver.
    loadImageDataUrlForQuery: (imageId: string) => resolve(imageId),
  };
}
