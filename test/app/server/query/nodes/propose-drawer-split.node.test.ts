import { describe, expect, it } from "vitest";

import type { Inventory } from "../../../../../app/server/scan/schemas/inventory";
import type { FridgeQueryStateValue } from "../../../../../app/server/query/state";
import { resolveInventoryScope } from "../../../../../app/server/query/nodes/propose-drawer-split.node";

function inventory(): Inventory {
  return {
    id: "inventory-1",
    fridgeId: "fridge-1",
    scanId: "scan-1",
    source: "mocked-vision",
    model: "test",
    createdAt: "2026-07-17T00:00:00.000Z",
    items: [
      {
        id: "item-1",
        name: "mixed produce",
        label: "Mixed produce",
        cat: "produce",
        subcat: null,
        qty: { amount: null, unit: "unknown", precision: "unknown", fillLevel: null },
        pack: "bag",
        loc: {
          status: "matched",
          zoneId: "lower-left",
          zoneType: "shelf",
          observations: [{ imageId: "image-1", depthBackRatio: null, boundingBox: { x: 0.08, y: 0.68, width: 0.22, height: 0.12 } }],
          confidence: 0.8,
        },
        conf: 0.8,
        src: ["detection-1"],
        attrs: { brand: null, variant: null, opened: null, expirationDate: null },
        review: "inferred",
      },
    ],
    zones: [
      { id: "top-left", type: "shelf", label: "Top left shelf", order: 0, boundingBox: { x: 0.05, y: 0.1, width: 0.4, height: 0.2 }, imageIds: ["image-1"], sourceZoneDetectionIds: ["zone-1"], confidence: 0.9, estimatedCapacityRatio: null, estimatedOccupiedRatio: null },
      { id: "top-right", type: "shelf", label: "Top right shelf", order: 1, boundingBox: { x: 0.55, y: 0.1, width: 0.4, height: 0.2 }, imageIds: ["image-1"], sourceZoneDetectionIds: ["zone-2"], confidence: 0.9, estimatedCapacityRatio: null, estimatedOccupiedRatio: null },
      { id: "lower-left", type: "shelf", label: "Lower left shelf", order: 2, boundingBox: { x: 0.05, y: 0.62, width: 0.4, height: 0.25 }, imageIds: ["image-1"], sourceZoneDetectionIds: ["zone-3"], confidence: 0.9, estimatedCapacityRatio: null, estimatedOccupiedRatio: null },
    ],
  };
}

function state(query: string, seededItems: unknown[] = []) {
  return {
    imageId: "image-1",
    query,
    context: {
      conversationContext: {
        selectedItemIds: [],
        selectedZoneIds: [],
        selectedRecipeId: null,
        seededItems,
      },
    },
  } as unknown as FridgeQueryStateValue;
}

describe("scoped inventory split resolution", () => {
  it("resolves a semantic shelf description from scanned zone geometry", () => {
    expect(resolveInventoryScope(state("What's on the top left shelf?"), inventory())).toMatchObject({
      label: "Top left shelf",
      zoneId: "top-left",
      replaceItemIds: [],
    });
  });

  it("uses one seeded crop as the scope before semantic zone matching", () => {
    expect(resolveInventoryScope(state("What's on the top left shelf?", [{
      itemId: "item-1",
      imageId: "image-1",
      cropId: "image-1:item-1:0",
      userSeeded: true,
    }]), inventory())).toMatchObject({
      label: "Mixed produce",
      zoneId: "lower-left",
      replaceItemIds: ["item-1"],
    });
  });
});
