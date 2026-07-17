import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createFridgeImage, deleteFridgeImage } from "./images.server";
import {
  getFridgeInventoryForImage,
  appendFridgeInventoryVisualEnrichment,
  appendFridgeInventoryEnrichments,
  applyFridgeInventorySplit,
  saveFridgeInventory,
} from "./inventories.server";
import { fridgeInventories } from "./db/schema.server";
import type { Inventory } from "./scan/schemas/inventory";
import { withDatabase } from "./sqlite.server";

function setTestDatabase() {
  const databasePath = path.join(
    tmpdir(),
    `fridgefriend-inventory-test-${randomUUID()}.sqlite`,
  );
  process.env.DATABASE_PATH = databasePath;
  return databasePath;
}

function createJpegDataUrl() {
  return `data:image/jpeg;base64,${Buffer.from([255, 216, 255, 217]).toString("base64")}`;
}

function createInventory(imageId: string): Inventory {
  return {
    id: "inventory-1",
    fridgeId: "default-fridge",
    scanId: "scan-1",
    source: "mocked-vision",
    model: "test-model",
    createdAt: "2026-07-16T00:00:00.000Z",
    items: [
      {
        id: "item-1",
        name: "milk",
        label: "Milk",
        cat: "dairy",
        subcat: null,
        qty: {
          amount: 1,
          unit: "package",
          precision: "estimated",
          fillLevel: null,
        },
        pack: "carton",
        loc: {
          status: "matched",
          zoneId: "zone-1",
          zoneType: "shelf",
          observations: [
            {
              imageId,
              depthBackRatio: 1,
              boundingBox: { x: 0.2, y: 0.3, width: 0.1, height: 0.2 },
            },
          ],
          confidence: 0.82,
        },
        conf: 0.9,
        src: ["detection-1"],
        attrs: {
          brand: null,
          variant: null,
          opened: null,
          expirationDate: null,
        },
        review: "inferred",
      },
    ],
    zones: [
      {
        id: "zone-1",
        type: "shelf",
        label: "Top shelf",
        order: 0,
        boundingBox: { x: 0.1, y: 0.2, width: 0.8, height: 0.3 },
        imageIds: [imageId],
        sourceZoneDetectionIds: ["zone-detection-1"],
        confidence: 0.88,
        estimatedCapacityRatio: null,
        estimatedOccupiedRatio: null,
      },
    ],
  };
}

describe("fridge inventory persistence", () => {
  let databasePath: string;

  beforeEach(() => {
    databasePath = setTestDatabase();
  });

  afterEach(() => {
    rmSync(databasePath, { force: true });
    rmSync(`${databasePath}-wal`, { force: true });
    rmSync(`${databasePath}-shm`, { force: true });
    delete process.env.DATABASE_PATH;
  });

  it("persists and loads consolidated inventory for an image", () => {
    const image = createFridgeImage({
      dataUrl: createJpegDataUrl(),
      originalName: "fridge.jpg",
      storageLocation: "fridge",
      baseImageId: null
    });
    const inventory = createInventory(image.id);

    saveFridgeInventory({ imageId: image.id, inventory });

    expect(getFridgeInventoryForImage(image.id)).toEqual(inventory);
  });

  it("persists focused visual enrichment on the matched inventory item", () => {
    const image = createFridgeImage({
      dataUrl: createJpegDataUrl(),
      originalName: "fridge.jpg",
      storageLocation: "fridge",
      baseImageId: null
    });
    const inventory = createInventory(image.id);

    saveFridgeInventory({ imageId: image.id, inventory });
    appendFridgeInventoryVisualEnrichment({
      imageId: image.id,
      itemIds: ["item-1"],
      query: "How much milk is left?",
      response: "The carton looks about half full.",
      crops: [
        {
          itemId: "item-1",
          imageId: image.id,
          boundingBox: { x: 0.2, y: 0.3, width: 0.1, height: 0.2 },
        },
      ],
      observedAt: "2026-07-17T00:00:00.000Z",
    });

    expect(getFridgeInventoryForImage(image.id)?.items[0].visual).toEqual([
      {
        query: "How much milk is left?",
        response: "The carton looks about half full.",
        imageId: image.id,
        boundingBox: { x: 0.2, y: 0.3, width: 0.1, height: 0.2 },
        observedAt: "2026-07-17T00:00:00.000Z",
      },
    ]);
  });

  it("persists field patches with enrichment provenance", () => {
    const image = createFridgeImage({
      dataUrl: createJpegDataUrl(),
      originalName: "fridge.jpg",
      storageLocation: "fridge",
      baseImageId: null,
    });
    saveFridgeInventory({ imageId: image.id, inventory: createInventory(image.id) });

    appendFridgeInventoryEnrichments({
      imageId: image.id,
      enrichments: [{
        itemId: "item-1",
        source: "focused_vlm",
        fields: ["fill_level", "expiration_date"],
        confidence: 0.72,
        observedAt: "2026-07-17T00:00:00.000Z",
        imageId: image.id,
        boundingBox: { x: 0.2, y: 0.3, width: 0.1, height: 0.2 },
        values: {
          label: null,
          variant: null,
          amount: null,
          unit: null,
          fillLevel: 0.5,
          expirationDate: "2026-07-21",
          opened: null,
        },
      }],
    });

    expect(getFridgeInventoryForImage(image.id)?.items[0]).toMatchObject({
      qty: { fillLevel: 0.5, precision: "estimated" },
      attrs: { expirationDate: "2026-07-21" },
      enrichments: [{ source: "focused_vlm", fields: ["fill_level", "expiration_date"], confidence: 0.72 }],
    });
  });

  it("replaces confirmed coarse inventory items with approved drawer split items", () => {
    const image = createFridgeImage({ dataUrl: createJpegDataUrl(), originalName: "fridge.jpg", storageLocation: "fridge", baseImageId: null });
    saveFridgeInventory({ imageId: image.id, inventory: createInventory(image.id) });

    applyFridgeInventorySplit({
      imageId: image.id,
      replaceItemIds: ["item-1"],
      items: [
        { name: "carrot", label: "Carrots", category: "produce", packaging: "bag", boundingBox: { x: 0.2, y: 0.3, width: 0.04, height: 0.12 }, zoneId: "zone-1", zoneType: "shelf" },
        { name: "celery", label: "Celery", category: "produce", packaging: "bag", boundingBox: { x: 0.25, y: 0.3, width: 0.04, height: 0.12 }, zoneId: "zone-1", zoneType: "shelf" },
      ],
    });

    const items = getFridgeInventoryForImage(image.id)?.items ?? [];
    expect(items.map((item) => item.name)).toEqual(["carrot", "celery"]);
    expect(items.every((item) => item.review === "confirmed")).toBe(true);
  });

  it("ignores old inventory row volume fields", () => {
    const image = createFridgeImage({
      dataUrl: createJpegDataUrl(),
      originalName: "fridge.jpg",
      storageLocation: "fridge",
      baseImageId: null
    });
    const inventory = createInventory(image.id);
    const storedInventory = inventory as unknown as {
      id: string;
      items: Array<{ volume_cubic_inches?: unknown }>;
      zones: Array<{
        volume_cubic_inches?: unknown;
        remaining_volume_cubic_inches?: unknown;
      }>;
    };
    storedInventory.items[0].volume_cubic_inches = 187;
    storedInventory.zones[0].volume_cubic_inches = 720;
    storedInventory.zones[0].remaining_volume_cubic_inches = 533;
    const now = new Date().toISOString();

    withDatabase((db) => {
      db.insert(fridgeInventories)
        .values({
          imageId: image.id,
          inventoryId: storedInventory.id,
          inventoryJson: JSON.stringify(storedInventory),
          createdAt: now,
          updatedAt: now,
        })
        .run();
    });

    const loadedInventory = getFridgeInventoryForImage(image.id);

    expect(loadedInventory?.items[0]).not.toHaveProperty("volume_cubic_inches");
    expect(loadedInventory?.zones[0]).not.toHaveProperty("volume_cubic_inches");
    expect(loadedInventory?.zones[0]).not.toHaveProperty(
      "remaining_volume_cubic_inches",
    );
  });

  it("migrates stored observation rows with old depth positions to depthBackRatio", () => {
    const image = createFridgeImage({
      dataUrl: createJpegDataUrl(),
      originalName: "fridge.jpg",
      storageLocation: "fridge",
      baseImageId: null
    });
    const inventory = createInventory(image.id);
	    const storedInventory = structuredClone(inventory) as unknown as {
	      id: string;
	      items: Array<{
	        loc: {
	          observations: Array<{
	            depthPosition?: string;
	            depthBackRatio?: number | null;
	          }>;
	        };
	      }>;
	    };
	    storedInventory.items[0].loc.observations[0].depthPosition = "middle";
	    delete storedInventory.items[0].loc.observations[0].depthBackRatio;
    const now = new Date().toISOString();

    withDatabase((db) => {
      db.insert(fridgeInventories)
        .values({
          imageId: image.id,
          inventoryId: storedInventory.id,
          inventoryJson: JSON.stringify(storedInventory),
          createdAt: now,
          updatedAt: now,
        })
        .run();
    });

    const loadedInventory = getFridgeInventoryForImage(image.id);

	    expect(loadedInventory?.items[0].loc.observations[0]).toMatchObject({
	      depthBackRatio: 1,
	    });
	    expect(loadedInventory?.items[0].loc.observations[0]).not.toHaveProperty(
	      "depthPosition",
	    );
	  });

  it("removes persisted inventory when the image is deleted", () => {
    const image = createFridgeImage({
      dataUrl: createJpegDataUrl(),
      originalName: "fridge.jpg",
      storageLocation: "fridge",
      baseImageId: null
    });

    saveFridgeInventory({
      imageId: image.id,
      inventory: createInventory(image.id),
    });
    deleteFridgeImage(image.id);

    expect(getFridgeInventoryForImage(image.id)).toBeNull();
  });
});
