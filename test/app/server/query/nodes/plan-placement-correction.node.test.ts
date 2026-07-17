import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createPlanPlacementCorrectionNode } from "../../../../../app/server/query/nodes/plan-placement-correction.node";
import { resetSqliteBootstrapCacheForTests } from "../../../../../app/server/sqlite.server";
import type { Inventory } from "../../../../../app/server/scan/schemas/inventory";
import type { FridgeQueryStateValue } from "../../../../../app/server/query/state";

function setTestDatabase() {
  const databasePath = path.join(
    tmpdir(),
    `fridgefriend-placement-correction-test-${randomUUID()}.sqlite`,
  );
  process.env.DATABASE_PATH = databasePath;
  return databasePath;
}

function inventory(): Inventory {
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
      subcat: null,
      qty: { amount: 1, unit: "package", precision: "estimated", fillLevel: null },
      pack: "container",
      loc: {
        status: "matched",
        zoneId: "top",
        zoneType: "shelf",
        confidence: 0.9,
        observations: [{
          imageId: "image-1",
          depthBackRatio: 0.4,
          boundingBox: { x: 0.3, y: 0.25, width: 0.1, height: 0.1 },
        }],
      },
      conf: 0.9,
      src: ["item-1"],
      attrs: { brand: null, variant: null, opened: null, expirationDate: null },
      review: "inferred",
    }],
    zones: [{
      id: "top",
      type: "shelf",
      label: "Top shelf",
      order: 0,
      boundingBox: { x: 0, y: 0.1, width: 1, height: 0.2 },
      imageIds: ["image-1"],
      sourceZoneDetectionIds: ["top"],
      confidence: 0.9,
      estimatedCapacityRatio: null,
      estimatedOccupiedRatio: null,
    }, {
      id: "middle",
      type: "shelf",
      label: "Middle shelf",
      order: 1,
      boundingBox: { x: 0, y: 0.4, width: 1, height: 0.2 },
      imageIds: ["image-1"],
      sourceZoneDetectionIds: ["middle"],
      confidence: 0.9,
      estimatedCapacityRatio: null,
      estimatedOccupiedRatio: null,
    }, {
      id: "bottom",
      type: "shelf",
      label: "Bottom shelf",
      order: 2,
      boundingBox: { x: 0, y: 0.7, width: 1, height: 0.2 },
      imageIds: ["image-1"],
      sourceZoneDetectionIds: ["bottom"],
      confidence: 0.9,
      estimatedCapacityRatio: null,
      estimatedOccupiedRatio: null,
    }, {
      id: "right-door",
      type: "shelf",
      label: "Right shelf",
      order: 3,
      boundingBox: { x: 0.72, y: 0.1, width: 0.2, height: 0.2 },
      imageIds: ["image-1"],
      sourceZoneDetectionIds: ["right-door"],
      confidence: 0.9,
      estimatedCapacityRatio: null,
      estimatedOccupiedRatio: null,
    }],
  };
}

function state(input: {
  query: string;
  selectedItemIds?: string[];
  selectedZoneIds?: string[];
}): FridgeQueryStateValue {
  return {
    userId: "user-1",
    fridgeId: "fridge-1",
    imageId: "image-1",
    query: input.query,
    requestId: randomUUID(),
    context: {
      conversationContext: {
        selectedItemIds: input.selectedItemIds ?? [],
        selectedZoneIds: input.selectedZoneIds ?? [],
        selectedRecipeId: null,
        seededItems: [],
      },
    },
  } as unknown as FridgeQueryStateValue;
}

describe("placement correction planner", () => {
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

  it("moves the selected item to the adjacent lower shelf", async () => {
    const node = createPlanPlacementCorrectionNode({ loadInventoryForImage: () => inventory() });
    const result = await node(state({ query: "This is on the wrong shelf - move it down.", selectedItemIds: ["item-1"] }));
    const context = result.context as { organizationPlan: { priority: string; moves: Array<{ itemId: string; fromZoneId: string; toZoneId: string; rationale: string }>; summary: string }; workspaceActions: unknown[] };
    const plan = context.organizationPlan;

    expect(plan.priority).toBe("placement_correction");
    expect(plan.summary).toBe("Move Yogurt from Top shelf to Middle shelf.");
    expect(plan.moves).toEqual([{ itemId: "item-1", fromZoneId: "top", toZoneId: "middle", rationale: "User correction: move down." }]);
    expect(context.workspaceActions).toEqual([{ type: "preview_reorganization", placements: [{ itemId: "item-1", zoneId: "middle" }] }]);
  });

  it("moves the selected item to the opposite side", async () => {
    const node = createPlanPlacementCorrectionNode({ loadInventoryForImage: () => inventory() });
    const result = await node(state({ query: "move it to the other side", selectedItemIds: ["item-1"] }));
    const plan = result.context.organizationPlan as { moves: Array<{ toZoneId: string }> };

    expect(plan.moves[0].toZoneId).toBe("right-door");
  });

  it("returns a specific correction error when no item is selected", async () => {
    const node = createPlanPlacementCorrectionNode({ loadInventoryForImage: () => inventory() });
    const result = await node(state({ query: "This is on the wrong shelf - move it down." }));

    expect(result.context.organizationPlan).toBeNull();
    expect(result.context.organizationPlanError).toBe("Inventory correction needs exactly one selected item to move.");
  });
});
