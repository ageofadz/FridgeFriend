import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createFridgeImage, deleteFridgeImage } from "../../../app/server/images.server";
import {
  coerceInventoryStorageLocation,
  getFridgeInventoryForImage,
  appendFridgeInventoryEnrichments,
  applyFridgeInventorySplit,
  inventoryWithoutStorageLocation,
  mergeStorageInventory,
  saveFridgeInventory,
} from "../../../app/server/inventories.server";
import { fridgeInventories } from "../../../app/server/db/schema.server";
import type { Inventory } from "../../../app/server/scan/schemas/inventory";
import { resetSqliteBootstrapCacheForTests, withDatabase } from "../../../app/server/sqlite.server";

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

    const savedInventory = saveFridgeInventory({ imageId: image.id, inventory });

    expect(getFridgeInventoryForImage(image.id)).toEqual(savedInventory);
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

  it("does not append duplicate inventory enrichments when the same write is retried", () => {
    const image = createFridgeImage({
      dataUrl: createJpegDataUrl(),
      originalName: "fridge.jpg",
      storageLocation: "fridge",
      baseImageId: null,
    });
    const enrichment = {
      itemId: "item-1",
      source: "focused_vlm" as const,
      fields: ["fill_level" as const],
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
        expirationDate: null,
        opened: null,
      },
    };

    saveFridgeInventory({ imageId: image.id, inventory: createInventory(image.id) });
    appendFridgeInventoryEnrichments({ imageId: image.id, enrichments: [enrichment] });
    appendFridgeInventoryEnrichments({ imageId: image.id, enrichments: [enrichment] });

    expect(getFridgeInventoryForImage(image.id)?.items[0].enrichments).toHaveLength(1);
  });

  it("replaces confirmed coarse inventory items with approved scoped split items", () => {
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

    // Legacy rows only exist before the first bootstrap of a database; reset
    // the per-path bootstrap cache so the migration runs against this row.
    resetSqliteBootstrapCacheForTests();

    const loadedInventory = getFridgeInventoryForImage(image.id);

	    expect(loadedInventory?.items[0].loc.observations[0]).toMatchObject({
	      depthBackRatio: 1,
	    });
	    expect(loadedInventory?.items[0].loc.observations[0]).not.toHaveProperty(
	      "depthPosition",
	    );
	  });

  it("repairs persisted base and stacked placements before they can render", () => {
    const image = createFridgeImage({
      dataUrl: createJpegDataUrl(),
      originalName: "fridge.jpg",
      storageLocation: "fridge",
      baseImageId: null,
    });
    const storedInventory = structuredClone(createInventory(image.id));
    storedInventory.items[0].loc = {
      ...storedInventory.items[0].loc,
      status: "unmatched",
      zoneId: null,
      zoneType: null,
      confidence: null,
      observations: storedInventory.items[0].loc.observations.map((observation) => ({
        ...observation,
        depthBackRatio: null,
      })),
    };
    storedInventory.items.push({
      ...storedInventory.items[0],
      id: "item-2",
      name: "yogurt",
      label: "Yogurt",
      stack: { on: "item-1", conf: 0.9, why: "direct support" },
      loc: {
        ...storedInventory.items[0].loc,
        observations: [{
          imageId: image.id,
          depthBackRatio: null,
          boundingBox: { x: 0.22, y: 0.22, width: 0.08, height: 0.08 },
        }],
      },
    });
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

    resetSqliteBootstrapCacheForTests();

    const loadedInventory = getFridgeInventoryForImage(image.id)!;

    expect(loadedInventory.items[0].loc).toMatchObject({
      status: "matched",
      zoneId: "zone-1",
      zoneType: "shelf",
    });
    expect(loadedInventory.items[0].loc.observations[0].depthBackRatio).toBeCloseTo(1);
    expect(loadedInventory.items[1].loc).toMatchObject({
      status: "matched",
      zoneId: "zone-1",
      zoneType: "shelf",
    });
    expect(loadedInventory.items[1].loc.observations[0].depthBackRatio).toBe(
      loadedInventory.items[0].loc.observations[0].depthBackRatio,
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

describe("multi-location inventory merging", () => {
  function createFreezerInventory(imageId: string): Inventory {
    const inventory = createInventory(imageId);

    return {
      ...inventory,
      id: "freezer-inventory-1",
      scanId: "freezer-scan-1",
      items: [
        {
          ...inventory.items[0],
          id: "freezer-item-1",
          name: "peas",
          label: "Frozen Peas",
          cat: "produce",
          loc: {
            ...inventory.items[0].loc,
            zoneId: "freezer-zone-1",
            zoneType: "shelf",
          },
        },
      ],
      zones: [
        {
          ...inventory.zones[0],
          id: "freezer-zone-1",
          label: "Drawer",
        },
      ],
    };
  }

  it("returns fridge inventories unchanged from coercion", () => {
    const inventory = createInventory("image-1");

    expect(coerceInventoryStorageLocation(inventory, "fridge")).toBe(inventory);
  });

  it("coerces zones and item locations to the scanned storage location", () => {
    const coerced = coerceInventoryStorageLocation(
      createFreezerInventory("image-1"),
      "freezer",
    );

    expect(coerced.zones[0]).toMatchObject({
      type: "freezer",
      label: "Freezer Drawer",
    });
    expect(coerced.items[0].loc.zoneType).toBe("freezer");
  });

  it("does not re-prefix zone labels that already mention the storage location", () => {
    const freezerInventory = createFreezerInventory("image-1");
    freezerInventory.zones[0].label = "Freezer drawer";

    const coerced = coerceInventoryStorageLocation(freezerInventory, "freezer");

    expect(coerced.zones[0].label).toBe("Freezer drawer");
  });

  it("removes a storage location's items and zones from a merged inventory", () => {
    const merged = mergeStorageInventory(
      createInventory("image-1"),
      coerceInventoryStorageLocation(createFreezerInventory("image-2"), "freezer"),
      "freezer",
    );

    const withoutFreezer = inventoryWithoutStorageLocation(merged, "freezer");

    expect(withoutFreezer.items.map((item) => item.id)).toEqual(["item-1"]);
    expect(withoutFreezer.zones.map((zone) => zone.id)).toEqual(["zone-1"]);
  });

  it("merges extension inventories and replaces prior data for that location", () => {
    const base = createInventory("image-1");
    const firstScan = coerceInventoryStorageLocation(
      createFreezerInventory("image-2"),
      "freezer",
    );
    const secondScan = coerceInventoryStorageLocation(
      {
        ...createFreezerInventory("image-3"),
        scanId: "freezer-scan-2",
      },
      "freezer",
    );

    const merged = mergeStorageInventory(
      mergeStorageInventory(base, firstScan, "freezer"),
      secondScan,
      "freezer",
    );

    expect(merged.scanId).toBe("scan-1:freezer:freezer-scan-1:freezer:freezer-scan-2");
    expect(merged.items).toHaveLength(2);
    expect(merged.zones).toHaveLength(2);
    expect(merged.items.map((item) => item.loc.zoneType)).toEqual(["shelf", "freezer"]);
  });
});
