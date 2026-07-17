import { describe, expect, it } from "vitest";

import type { Inventory } from "../../scan/schemas/inventory";
import { summarizeInventory } from "./inventory-context.server";

function createInventory(): Inventory {
  const item = {
    id: "item-1",
    name: "oats",
    label: "Pantry oats",
    cat: "other" as const,
    subcat: null,
    qty: {
      amount: 1,
      unit: "package" as const,
      precision: "estimated" as const,
      fillLevel: null,
    },
    pack: "bag" as const,
    loc: {
      status: "matched" as const,
      zoneId: "pantry-zone",
      zoneType: "pantry" as const,
      observations: [
        {
          imageId: "pantry-image",
          depthBackRatio: 0.3,
          boundingBox: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
        },
      ],
      confidence: 0.9,
    },
    conf: 0.9,
    src: ["pantry-detection"],
    attrs: {
      brand: null,
      variant: null,
      opened: null,
      expirationDate: null,
    },
    review: "inferred" as const,
  };

  return {
    id: "inventory-1",
    fridgeId: "fridge-1",
    scanId: "scan-1",
    source: "mocked-vision",
    model: "test-model",
    createdAt: "2026-07-17T00:00:00.000Z",
    items: [
      item,
      {
        ...item,
        name: "milk",
        label: "Fridge milk",
        loc: {
          ...item.loc,
          zoneId: "fridge-zone",
          zoneType: "shelf",
          observations: [
            {
              imageId: "fridge-image",
              depthBackRatio: 0.5,
              boundingBox: { x: 0.3, y: 0.3, width: 0.2, height: 0.2 },
            },
          ],
        },
        src: ["fridge-detection"],
      },
    ],
    zones: [],
  };
}

describe("inventory query context", () => {
  it("matches seeded inventory by item id and source image", () => {
    const summary = summarizeInventory(createInventory(), {
      seededItems: [
        {
          itemId: "item-1",
          imageId: "fridge-image",
          cropId: "fridge-image:item-1:0",
          userSeeded: true,
        },
      ],
    });

    expect(summary.items.map((item) => ({
      displayName: item.displayName,
      userSeeded: item.userSeeded,
    }))).toEqual([
      {
        displayName: "Fridge milk",
        userSeeded: true,
      },
      {
        displayName: "Pantry oats",
        userSeeded: false,
      },
    ]);
  });
});
