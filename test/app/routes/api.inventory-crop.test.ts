import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

import { encode as encodeJpeg } from "jpeg-js";
import type { LoaderFunctionArgs } from "react-router";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createFridgeImage } from "../../../app/server/images.server";
import { saveFridgeInventory } from "../../../app/server/inventories.server";
import type { Inventory } from "../../../app/server/scan/schemas/inventory";
import { loader } from "../../../app/routes/api.inventory-crop";

function setTestDatabase() {
  const databasePath = path.join(
    tmpdir(),
    `fridgefriend-crop-route-test-${randomUUID()}.sqlite`,
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
              depthBackRatio: 0.5,
              boundingBox: { x: 0, y: 0, width: 0.5, height: 0.5 },
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
    zones: [],
  };
}

async function responseJson(response: Response) {
  return await response.json() as { error: string };
}

function loadCrop(request: Request) {
  return loader({
    request,
    url: new URL(request.url),
    pattern: "/api/inventory-crop",
    params: {},
    context: {
      get: () => undefined,
      set: () => undefined,
    } as unknown as LoaderFunctionArgs["context"],
  });
}

describe("inventory crop route", () => {
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

  it("returns a JPEG crop for a valid deterministic crop id", async () => {
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

    const response = await loadCrop(
      new Request(`http://localhost/api/inventory-crop?cropId=${encodeURIComponent(`${image.id}:item-1:0`)}`),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(new Uint8Array(await response.arrayBuffer()).slice(0, 3)).toEqual(
      new Uint8Array([255, 216, 255]),
    );
  });

  it("resolves crops by image observation when item ids repeat across storage images", async () => {
    const image = createFridgeImage({
      dataUrl: createJpegDataUrl(),
      originalName: "fridge.jpg",
      storageLocation: "fridge",
      baseImageId: null,
    });
    const inventory = createInventory(image.id);
    saveFridgeInventory({
      imageId: image.id,
      inventory: {
        ...inventory,
        items: [
          {
            ...inventory.items[0],
            label: "Pantry oats",
            loc: {
              ...inventory.items[0].loc,
              zoneType: "pantry",
              observations: [
                {
                  imageId: "pantry-image",
                  depthBackRatio: 0.5,
                  boundingBox: { x: 0.5, y: 0.5, width: 0.25, height: 0.25 },
                },
              ],
            },
          },
          {
            ...inventory.items[0],
            label: "Fridge milk",
          },
        ],
      },
    });

    const response = await loadCrop(
      new Request(`http://localhost/api/inventory-crop?cropId=${encodeURIComponent(`${image.id}:item-1:0`)}`),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/jpeg");
  });

  it("returns specific errors for invalid crop requests", async () => {
    const malformed = await loadCrop(
      new Request("http://localhost/api/inventory-crop?cropId=bad"),
    );
    expect(malformed.status).toBe(400);
    expect((await responseJson(malformed)).error).toContain("Inventory crop id is malformed");

    const missingInventory = await loadCrop(
      new Request("http://localhost/api/inventory-crop?cropId=image-1:item-1:0"),
    );
    expect(missingInventory.status).toBe(404);
    expect((await responseJson(missingInventory)).error).toContain("inventory was not found");

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

    const missingItem = await loadCrop(
      new Request(`http://localhost/api/inventory-crop?cropId=${encodeURIComponent(`${image.id}:item-2:0`)}`),
    );
    expect(missingItem.status).toBe(404);
    expect((await responseJson(missingItem)).error).toContain("item item-2 with observation 0 was not found");

    const missingObservation = await loadCrop(
      new Request(`http://localhost/api/inventory-crop?cropId=${encodeURIComponent(`${image.id}:item-1:4`)}`),
    );
    expect(missingObservation.status).toBe(404);
    expect((await responseJson(missingObservation)).error).toContain("observation 4 was not found");
  });
});
