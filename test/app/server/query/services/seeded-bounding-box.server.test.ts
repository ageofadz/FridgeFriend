import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

import { encode as encodeJpeg } from "jpeg-js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createFridgeImage } from "../../../../../app/server/images.server";
import { getFridgeInventoryForImage, saveFridgeInventory } from "../../../../../app/server/inventories.server";
import type { Inventory } from "../../../../../app/server/scan/schemas/inventory";
import { resolveInventoryCropDataUrl } from "../../../../../app/server/query/services/focused-visual-context.server";
import { seedInventoryBoundingBox } from "../../../../../app/server/query/services/seeded-bounding-box.server";
import { applySeededInventoryAssertions } from "../../../../../app/server/query/services/seeded-inventory-assertion.server";

function setTestDatabase() {
  const databasePath = path.join(
    tmpdir(),
    `fridgefriend-seed-bbox-test-${randomUUID()}.sqlite`,
  );
  process.env.DATABASE_PATH = databasePath;
  return databasePath;
}

function createJpegDataUrl() {
  const jpeg = encodeJpeg(
    {
      data: Buffer.from([
        255, 0, 0, 255,
        0, 255, 0, 255,
        0, 0, 255, 255,
        255, 255, 255, 255,
      ]),
      width: 2,
      height: 2,
    },
    100,
  );

  return `data:image/jpeg;base64,${Buffer.from(jpeg.data).toString("base64")}`;
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
        subcat: "milk",
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
              depthBackRatio: 0.4,
              boundingBox: { x: 0.1, y: 0.1, width: 0.3, height: 0.3 },
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
        label: "middle shelf",
        order: 1,
        boundingBox: { x: 0, y: 0, width: 1, height: 1 },
        imageIds: [imageId],
        sourceZoneDetectionIds: ["zone-detection-1"],
        confidence: 0.9,
        estimatedCapacityRatio: null,
        estimatedOccupiedRatio: null,
      },
    ],
  };
}

describe("seedInventoryBoundingBox", () => {
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

  it("adds a drawn crop to a known inventory item without calling vision identification", async () => {
    const image = createFridgeImage({
      dataUrl: createJpegDataUrl(),
      originalName: "fridge.jpg",
      storageLocation: "fridge",
      baseImageId: null,
    });
    saveFridgeInventory({
      imageId: image.id,
      inventory: createInventory(image.id),
    });

    const result = await seedInventoryBoundingBox({
      imageId: image.id,
      boundingBox: { x: 0.12, y: 0.12, width: 0.28, height: 0.28 },
      identifySeededBox: async () => {
        throw new Error("Known item bbox should not call vision identification");
      },
    });

	    expect(result.status).toBe("known_item");
	    expect(result.item.id).toBe("item-1");
	    expect(result.cropId).toBe(`${image.id}:item-1:1`);
	    const observations = getFridgeInventoryForImage(image.id)?.items[0].loc.observations;
	    expect(observations).toHaveLength(2);
	    expect(observations?.[1].depthBackRatio).toBeCloseTo(0.4);
  });

  it("creates a populated review item for an unknown drawn crop", async () => {
    const image = createFridgeImage({
      dataUrl: createJpegDataUrl(),
      originalName: "fridge.jpg",
      storageLocation: "fridge",
      baseImageId: null,
    });
    saveFridgeInventory({
      imageId: image.id,
      inventory: createInventory(image.id),
    });

    const result = await seedInventoryBoundingBox({
      imageId: image.id,
      boundingBox: { x: 0.6, y: 0.6, width: 0.2, height: 0.2 },
      identifySeededBox: async ({ cropDataUrl }) => {
        expect(cropDataUrl).toMatch(/^data:image\/jpeg;base64,/u);
        return {
          label: "Greek Yogurt",
          name: "greek yogurt",
          confidence: 0.84,
          category: "dairy",
          subcategory: "yogurt",
          packaging: "container",
          quantity: {
            amount: 1,
            unit: "container",
            precision: "estimated",
            fillLevel: null,
          },
          attributes: {
            brand: null,
            variant: null,
            opened: null,
            expirationDate: null,
          },
          visualSummary: "A yogurt container is visible in the selected crop.",
        };
      },
    });

    expect(result.status).toBe("created_item");
	    expect(result.item.label).toBe("Greek Yogurt");
	    expect(result.item.review).toBe("needs_review");
	    expect(result.item.loc.observations[0].depthBackRatio).toBeCloseTo(0.8);
	    expect(result.cropId).toBe(`${image.id}:${result.item.id}:0`);
    expect(await resolveInventoryCropDataUrl({ cropId: result.cropId })).toMatch(/^data:image\/jpeg;base64,/u);
  });

  it("relabels the seeded item from an explicit user assertion", () => {
    const image = createFridgeImage({
      dataUrl: createJpegDataUrl(),
      originalName: "fridge.jpg",
      storageLocation: "fridge",
      baseImageId: null,
    });
    saveFridgeInventory({
      imageId: image.id,
      inventory: createInventory(image.id),
    });

    const cropId = `${image.id}:item-1:0`;
    const applied = applySeededInventoryAssertions({
      seededItems: [{
        itemId: "item-1",
        imageId: image.id,
        cropId,
        userSeeded: true,
      }],
      assertions: [{ cropId, label: "Brussels Sprouts" }],
    });

    expect(applied).toEqual([{
      cropId,
      itemId: "item-1",
      label: "Brussels Sprouts",
    }]);
    expect(getFridgeInventoryForImage(image.id)?.items[0]).toMatchObject({
      name: "brussels sprouts",
      label: "Brussels Sprouts",
      review: "confirmed",
      src: ["detection-1", "user-asserted-label"],
    });
  });
});
