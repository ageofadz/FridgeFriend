import { describe, expect, it } from "vitest";

import { createAssessInventoryEnrichmentNode, routeInventoryEnrichment } from "../../../../../app/server/query/nodes/enrich-inventory.node";
import type { Inventory } from "../../../../../app/server/scan/schemas/inventory";
import type { FridgeQueryStateValue } from "../../../../../app/server/query/state";

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
      name: "milk",
      label: "Milk carton",
      cat: "dairy",
      subcat: null,
      qty: { amount: 1, unit: "package", precision: "estimated", fillLevel: null },
      pack: "carton",
      loc: {
        status: "matched",
        zoneId: "zone-1",
        zoneType: "shelf",
        observations: [{ imageId: "image-1", depthBackRatio: 0.5, boundingBox: { x: 0.1, y: 0.2, width: 0.2, height: 0.3 } }],
        confidence: 0.9,
      },
      conf: 0.9,
      src: ["detection-1"],
      attrs: { brand: null, variant: null, opened: null, expirationDate: null },
      review: "inferred",
    }],
    zones: [],
  };
}

function state(fields: string[]): FridgeQueryStateValue {
  return {
    userId: "user-1",
    fridgeId: "fridge-1",
    imageId: "image-1",
    query: "Can I use this milk?",
    context: {
      intentRouting: { enrichment: { itemNames: ["milk"], fields } },
    },
  } as unknown as FridgeQueryStateValue;
}

describe("inventory enrichment assessment", () => {
  it("does not enrich when the requested quantity is already known", async () => {
    const node = createAssessInventoryEnrichmentNode({ loadInventoryForImage: () => inventory() });
    const result = await node(state(["quantity"]));

    expect(routeInventoryEnrichment({ ...state(["quantity"]), ...result } as FridgeQueryStateValue)).toBe("continue");
  });

  it("separates visible and nonvisual gaps into focused VLM and human steps", async () => {
    const node = createAssessInventoryEnrichmentNode({ loadInventoryForImage: () => inventory() });
    const result = await node(state(["fill_level", "opened"]));
    const context = result.context as Record<string, unknown>;
    const enrichment = context.inventoryEnrichment as { plan: Array<{ fields: string[]; method: string }> };

    expect(enrichment.plan).toEqual([
      { itemId: "item-1", displayName: "Milk carton", fields: ["fill_level"], method: "focused_vlm", imageId: "image-1", boundingBox: { x: 0.1, y: 0.2, width: 0.2, height: 0.3 } },
      { itemId: "item-1", displayName: "Milk carton", fields: ["opened"], method: "ask_user", imageId: "image-1", boundingBox: { x: 0.1, y: 0.2, width: 0.2, height: 0.3 } },
    ]);
  });
});
