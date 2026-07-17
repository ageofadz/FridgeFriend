import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createFridgeImage } from "../../../../app/server/images.server";
import { saveFridgeInventory } from "../../../../app/server/inventories.server";
import { resetSqliteBootstrapCacheForTests } from "../../../../app/server/sqlite.server";
import type { Inventory } from "../../../../app/server/scan/schemas/inventory";
import {
  completeOrganizationPlan,
  createOrLoadOrganizationPlan,
} from "../../../../app/server/organization/repository.server";

function setTestDatabase() {
  const databasePath = path.join(
    tmpdir(),
    `fridgefriend-organization-test-${randomUUID()}.sqlite`,
  );
  process.env.DATABASE_PATH = databasePath;
  return databasePath;
}

function inventory(imageId: string): Inventory {
  return {
    id: "inventory-1",
    fridgeId: "fridge-1",
    scanId: "scan-1",
    source: "mocked-vision",
    model: "test",
    createdAt: "2026-07-17T00:00:00.000Z",
    items: [{
      id: "item-1",
      name: "yogurt",
      label: "Yogurt",
      cat: "dairy",
      subcat: "yogurt",
      qty: { amount: 1, unit: "package", precision: "estimated", fillLevel: null },
      pack: "container",
      stack: { on: "item-2", conf: 0.9, why: "direct support" },
      loc: {
        status: "matched",
        zoneId: "zone-1",
        zoneType: "shelf",
        confidence: 0.9,
        observations: [{
          imageId,
          depthBackRatio: 0.4,
          boundingBox: { x: 0.3, y: 0.3, width: 0.1, height: 0.1 },
        }],
      },
      conf: 0.9,
      src: ["item-1"],
      attrs: { brand: null, variant: null, opened: null, expirationDate: null },
      review: "inferred",
    }, {
      id: "item-2",
      name: "container",
      label: "Container",
      cat: "leftovers",
      subcat: null,
      qty: { amount: 1, unit: "package", precision: "estimated", fillLevel: null },
      pack: "container",
      loc: {
        status: "matched",
        zoneId: "zone-1",
        zoneType: "shelf",
        confidence: 0.9,
        observations: [{
          imageId,
          depthBackRatio: 0.4,
          boundingBox: { x: 0.28, y: 0.4, width: 0.14, height: 0.1 },
        }],
      },
      conf: 0.9,
      src: ["item-2"],
      attrs: { brand: null, variant: null, opened: null, expirationDate: null },
      review: "inferred",
    }],
    zones: [{
      id: "zone-1",
      type: "shelf",
      label: "Top shelf",
      order: 0,
      boundingBox: { x: 0, y: 0.2, width: 1, height: 0.3 },
      imageIds: [imageId],
      sourceZoneDetectionIds: ["zone-1"],
      confidence: 0.9,
      estimatedCapacityRatio: null,
      estimatedOccupiedRatio: null,
    }, {
      id: "zone-2",
      type: "shelf",
      label: "Lower shelf",
      order: 1,
      boundingBox: { x: 0, y: 0.6, width: 1, height: 0.3 },
      imageIds: [imageId],
      sourceZoneDetectionIds: ["zone-2"],
      confidence: 0.9,
      estimatedCapacityRatio: null,
      estimatedOccupiedRatio: null,
    }],
  };
}

describe("organization placement persistence", () => {
  let databasePath: string;

  beforeEach(() => {
    databasePath = setTestDatabase();
    resetSqliteBootstrapCacheForTests();
  });

  afterEach(() => {
    rmSync(databasePath, { force: true });
    rmSync(`${databasePath}-wal`, { force: true });
    rmSync(`${databasePath}-shm`, { force: true });
    delete process.env.DATABASE_PATH;
    resetSqliteBootstrapCacheForTests();
  });

  it("places confirmed moves directly on the destination storage base", () => {
    const image = createFridgeImage({
      dataUrl: "data:image/jpeg;base64,/9j/2Q==",
      originalName: "fridge.jpg",
      storageLocation: "fridge",
      baseImageId: null,
    });
    const storedInventory = inventory(image.id);
    const savedInventory = saveFridgeInventory({
      imageId: image.id,
      inventory: storedInventory,
    });
    const plan = createOrLoadOrganizationPlan({
      requestId: "request-1",
      userId: "user-1",
      fridgeId: storedInventory.fridgeId,
      imageId: image.id,
      inventory: savedInventory,
      draft: {
        summary: "Move yogurt to the lower shelf",
        moves: [{
          itemId: "item-1",
          fromZoneId: "zone-1",
          toZoneId: "zone-2",
          rationale: "Keep dairy together",
        }],
      },
    });

    const result = completeOrganizationPlan(plan.id);
    const moved = result.inventory!.items.find((item) => item.id === "item-1")!;

    expect(moved.stack).toBeUndefined();
    expect(moved.loc).toMatchObject({
      status: "matched",
      zoneId: "zone-2",
      zoneType: "shelf",
      assignment: { source: "user_confirmed", planId: plan.id },
    });
    expect(moved.loc.observations[0].depthBackRatio).toBeCloseTo(0.4);
  });

  it("marks a placement correction stale when saved inventory changed before apply", () => {
    const image = createFridgeImage({
      dataUrl: "data:image/jpeg;base64,/9j/2Q==",
      originalName: "fridge.jpg",
      storageLocation: "fridge",
      baseImageId: null,
    });
    const storedInventory = inventory(image.id);
    const savedInventory = saveFridgeInventory({
      imageId: image.id,
      inventory: storedInventory,
    });
    const plan = createOrLoadOrganizationPlan({
      requestId: "request-stale",
      userId: "user-1",
      fridgeId: storedInventory.fridgeId,
      imageId: image.id,
      inventory: savedInventory,
      priority: "placement_correction",
      draft: {
        summary: "Move yogurt to the lower shelf",
        moves: [{
          itemId: "item-1",
          fromZoneId: "zone-1",
          toZoneId: "zone-2",
          rationale: "User correction: move down.",
        }],
      },
    });

    saveFridgeInventory({
      imageId: image.id,
      inventory: {
        ...storedInventory,
        items: storedInventory.items.map((item) => item.id === "item-2" ? { ...item, label: "Updated Container" } : item),
      },
    });

    expect(() => completeOrganizationPlan(plan.id)).toThrow(
      `Kitchen organization plan ${plan.id} is stale because the recorded inventory changed after planning`,
    );
  });
});
