import { describe, expect, it } from "vitest";

import type { Inventory, InventoryItem } from "../../../app/server/scan/schemas/inventory";
import {
  buildInventoryPlacementLayout,
  buildImageGroundedPlacementLayout,
  canonicalizeInventoryPlacement,
  chooseBestSupportZone,
  renderedPackageDimensions,
  SCENE_HEIGHT,
  SCENE_WIDTH,
  supportSurfaceTopY,
} from "../../../app/components/fridge-placement";

const imageId = "image-1";

function item(input: Partial<InventoryItem> & Pick<InventoryItem, "id">): InventoryItem {
  return {
    id: input.id,
    name: input.name ?? input.id,
    label: input.label ?? input.id,
    cat: input.cat ?? "other",
    subcat: null,
    qty: { amount: null, unit: "unknown", precision: "unknown", fillLevel: null },
    pack: input.pack ?? "container",
    ...(input.stack ? { stack: input.stack } : {}),
    ...(input.scene ? { scene: input.scene } : {}),
    loc: input.loc ?? {
      status: "matched",
      zoneId: "shelf-1",
      zoneType: "shelf",
      confidence: 0.9,
      observations: [{
        imageId,
        depthBackRatio: 0.4,
        boundingBox: { x: 0.35, y: 0.42, width: 0.16, height: 0.18 },
      }],
    },
    conf: 0.9,
    src: [input.id],
    attrs: { brand: null, variant: null, opened: null, expirationDate: null },
    review: "inferred",
  };
}

function inventory(items: InventoryItem[], zones: Inventory["zones"] = [
  {
    id: "shelf-1",
    type: "shelf",
    label: "Middle shelf",
    order: 0,
    boundingBox: { x: 0, y: 0.3, width: 1, height: 0.3 },
    imageIds: [imageId],
    sourceZoneDetectionIds: ["shelf-1"],
    confidence: 0.9,
    estimatedCapacityRatio: null,
    estimatedOccupiedRatio: null,
  },
]) {
  return {
    id: "inventory-1",
    fridgeId: "fridge-1",
    scanId: "scan-1",
    source: "mocked-vision",
    model: "test",
    createdAt: "2026-07-17T00:00:00.000Z",
    items,
    zones,
  } satisfies Inventory;
}

describe("fridge placement layout", () => {
  it("uses tight image evidence and explicit depth for image-grounded placements", () => {
    const shelf = {
      id: "v2-shelf",
      type: "shelf" as const,
      label: "Middle shelf",
      order: 1,
      boundingBox: { x: 0.1, y: 0.49, width: 0.8, height: 0.02 },
      surfaceY: 0.51,
      imageIds: [imageId],
      sourceZoneDetectionIds: ["v2-shelf"],
      confidence: 0.9,
      estimatedCapacityRatio: null,
      estimatedOccupiedRatio: null,
    };
    const upperShelf = {
      ...shelf,
      id: "v2-upper-shelf",
      boundingBox: { x: 0.1, y: 0.19, width: 0.8, height: 0.02 },
      surfaceY: 0.21,
    };
    const grounded = item({
      id: "grounded-container",
      pack: "container",
      loc: {
        status: "matched",
        zoneId: shelf.id,
        zoneType: "shelf",
        confidence: 0.9,
        observations: [{
          imageId,
          depthBackRatio: 0.15,
          boundingBox: { x: 0.3, y: 0.31, width: 0.2, height: 0.2 },
        }],
      },
      scene: {
        status: "placed",
        supportKind: "zone",
        supportId: shelf.id,
        depth: { back: 0.15, front: 0.55 },
        confidence: 0.9,
      },
    });
    const sceneInventory = {
      ...inventory([grounded], [upperShelf, shelf]),
      sceneVersion: "image-grounded-v2" as const,
    };
    const [placement] = buildImageGroundedPlacementLayout(sceneInventory);

    expect(placement.width).toBeCloseTo(1);
    expect(placement.height).toBeCloseTo(1.4);
    expect(placement.depth).toBeCloseTo(0.88);
    expect(placement.y - placement.height / 2).toBeCloseTo(
      supportSurfaceTopY({ ...shelf, boundingBox: { ...shelf.boundingBox, y: shelf.surfaceY - shelf.boundingBox.height } }),
    );
  });

  it("uses an explicit correction preview zone for an image-grounded item", () => {
    const topShelf = {
      id: "top-shelf",
      type: "shelf" as const,
      label: "Top shelf",
      order: 0,
      boundingBox: { x: 0, y: 0.15, width: 1, height: 0.03 },
      surfaceY: 0.18,
      imageIds: [imageId],
      sourceZoneDetectionIds: ["top-shelf"],
      confidence: 0.9,
      estimatedCapacityRatio: null,
      estimatedOccupiedRatio: null,
    };
    const middleShelf = {
      ...topShelf,
      id: "middle-shelf",
      label: "Middle shelf",
      order: 1,
      boundingBox: { x: 0, y: 0.5, width: 1, height: 0.03 },
      surfaceY: 0.53,
    };
    const cloves = item({
      id: "cloves",
      scene: {
        status: "placed",
        supportKind: "zone",
        supportId: middleShelf.id,
        depth: { back: 0.2, front: 0.5 },
        confidence: 0.9,
      },
    });

    const [placement] = buildImageGroundedPlacementLayout(
      { ...inventory([cloves], [topShelf, middleShelf]), sceneVersion: "image-grounded-v2" },
      new Map([[cloves.id, topShelf.id]]),
    );

    expect(placement.supportZone.id).toBe(topShelf.id);
    expect(placement.y - placement.height / 2).toBeCloseTo(
      supportSurfaceTopY({ ...topShelf, boundingBox: { ...topShelf.boundingBox, y: topShelf.surfaceY - topShelf.boundingBox.height } }),
    );
  });

  it("clamps an image-grounded item that crosses an intervening shelf to its support surface", () => {
    const shelf = {
      id: "v2-shelf",
      type: "shelf" as const,
      label: "Middle shelf",
      order: 1,
      boundingBox: { x: 0, y: 0.49, width: 1, height: 0.02 },
      surfaceY: 0.51,
      imageIds: [imageId],
      sourceZoneDetectionIds: ["v2-shelf"],
      confidence: 0.9,
      estimatedCapacityRatio: null,
      estimatedOccupiedRatio: null,
    };
    const upperShelf = { ...shelf, id: "v2-upper", boundingBox: { x: 0, y: 0.29, width: 1, height: 0.02 }, surfaceY: 0.31 };
    const elongated = item({
      id: "elongated",
      scene: { status: "placed", supportKind: "zone", supportId: shelf.id, depth: { back: 0.1, front: 0.4 }, confidence: 0.9 },
      loc: {
        status: "matched", zoneId: shelf.id, zoneType: "shelf", confidence: 0.9,
        observations: [{ imageId, depthBackRatio: 0.1, boundingBox: { x: 0.3, y: 0.12, width: 0.16, height: 0.39 } }],
      },
    });
    const valid = item({
      id: "valid",
      scene: { status: "placed", supportKind: "zone", supportId: shelf.id, depth: { back: 0.45, front: 0.65 }, confidence: 0.9 },
      loc: {
        status: "matched", zoneId: shelf.id, zoneType: "shelf", confidence: 0.9,
        observations: [{ imageId, depthBackRatio: 0.45, boundingBox: { x: 0.6, y: 0.35, width: 0.12, height: 0.16 } }],
      },
    });

    const placements = buildImageGroundedPlacementLayout({
      ...inventory([elongated, valid], [upperShelf, shelf]),
      sceneVersion: "image-grounded-v2",
    });

    expect(placements).toHaveLength(2);
    expect(placements.map((placement) => placement.item.id)).toEqual(["elongated", "valid"]);
    expect(placements[0].y - placements[0].height / 2).toBeCloseTo(
      supportSurfaceTopY({ ...shelf, boundingBox: { ...shelf.boundingBox, y: shelf.surfaceY - shelf.boundingBox.height } }),
    );
    expect(placements[0].height).toBeLessThanOrEqual(
      (shelf.surfaceY - upperShelf.surfaceY) * SCENE_HEIGHT,
    );
  });

  it("renders an image-grounded review item when its unassigned box still maps to a storage zone", () => {
    const shelf = {
      id: "v2-shelf",
      type: "shelf" as const,
      label: "Middle shelf",
      order: 1,
      boundingBox: { x: 0.1, y: 0.49, width: 0.8, height: 0.02 },
      surfaceY: 0.51,
      imageIds: [imageId],
      sourceZoneDetectionIds: ["v2-shelf"],
      confidence: 0.9,
      estimatedCapacityRatio: null,
      estimatedOccupiedRatio: null,
    };
    const unassigned = item({
      id: "unassigned-container",
      scene: {
        status: "needs_review",
        reason: "No visible physical support satisfies the fixed item bounds",
        confidence: 0,
      },
      loc: {
        status: "needs_review",
        zoneId: null,
        zoneType: null,
        confidence: 0,
        observations: [{
          imageId,
          depthBackRatio: null,
          boundingBox: { x: 0.3, y: 0.35, width: 0.2, height: 0.16 },
        }],
      },
    });
    const [placement] = buildImageGroundedPlacementLayout({
      ...inventory([unassigned], [shelf]),
      sceneVersion: "image-grounded-v2",
    });

    expect(placement.item.id).toBe("unassigned-container");
    expect(placement.supportZone.id).toBe("v2-shelf");
    expect(placement.y - placement.height / 2).toBeCloseTo(
      supportSurfaceTopY({ ...shelf, boundingBox: { ...shelf.boundingBox, y: shelf.surfaceY - shelf.boundingBox.height } }),
    );
  });

  it("keeps geometrically unrelated image-grounded review items out of the 3d scene", () => {
    const shelf = {
      id: "v2-shelf",
      type: "shelf" as const,
      label: "Lower shelf",
      order: 1,
      boundingBox: { x: 0.1, y: 0.7, width: 0.8, height: 0.03 },
      surfaceY: 0.73,
      imageIds: [imageId],
      sourceZoneDetectionIds: ["v2-shelf"],
      confidence: 0.9,
      estimatedCapacityRatio: null,
      estimatedOccupiedRatio: null,
    };
    const unrelated = item({
      id: "floating-container",
      scene: {
        status: "needs_review",
        reason: "No visible physical support satisfies the fixed item bounds",
        confidence: 0,
      },
      loc: {
        status: "needs_review",
        zoneId: null,
        zoneType: null,
        confidence: 0,
        observations: [{
          imageId,
          depthBackRatio: null,
          boundingBox: { x: 0.3, y: 0.2, width: 0.2, height: 0.15 },
        }],
      },
    });

    expect(buildImageGroundedPlacementLayout({
      ...inventory([unrelated], [shelf]),
      sceneVersion: "image-grounded-v2",
    })).toEqual([]);
  });

  it("rests base items on the exact top face of every storage base", () => {
    const types = ["shelf", "door_shelf", "drawer", "freezer", "pantry"] as const;

    for (const type of types) {
      const zone = {
        id: `${type}-1`,
        type,
        label: type,
        order: 0,
        boundingBox: { x: 0, y: 0.3, width: 1, height: 0.3 },
        imageIds: [imageId],
        sourceZoneDetectionIds: [`${type}-1`],
        confidence: 0.9,
        estimatedCapacityRatio: null,
        estimatedOccupiedRatio: null,
      };
      const placedItem = item({
        id: `${type}-item`,
        loc: {
          status: "matched",
          zoneId: zone.id,
          zoneType: type,
          confidence: 0.9,
          observations: [{
            imageId,
            depthBackRatio: 0.4,
            boundingBox: { x: 0.35, y: 0.42, width: 0.16, height: 0.18 },
          }],
        },
      });
      const [placement] = buildInventoryPlacementLayout(inventory([placedItem], [zone]));

      expect(placement.y - placement.height / 2).toBeCloseTo(
        supportSurfaceTopY(zone),
      );
    }
  });

  it("uses the persisted depth anchor and target support top for direct shelf previews", () => {
    const targetZone = {
      id: "shelf-2",
      type: "shelf" as const,
      label: "Lower shelf",
      order: 1,
      boundingBox: { x: 0, y: 0.65, width: 1, height: 0.25 },
      imageIds: [imageId],
      sourceZoneDetectionIds: ["shelf-2"],
      confidence: 0.9,
      estimatedCapacityRatio: null,
      estimatedOccupiedRatio: null,
    };
    const [base] = buildInventoryPlacementLayout(inventory(
      [item({ id: "item-1" })],
      [...inventory([]).zones, targetZone],
    ));
    const [preview] = buildInventoryPlacementLayout(
      inventory([item({ id: "item-1" })], [...inventory([]).zones, targetZone]),
      new Map([["item-1", targetZone.id]]),
    );

    expect(preview.z).toBeCloseTo(base.z);
    expect(preview.y - preview.height / 2).toBeCloseTo(
      supportSurfaceTopY(targetZone),
    );
  });

  it("inherits Z through a stack and makes every stack contact exact", () => {
    const base = item({ id: "base" });
    const middle = item({
      id: "middle",
      stack: { on: "base", conf: 0.9, why: "direct support" },
      loc: {
        status: "matched",
        zoneId: "shelf-1",
        zoneType: "shelf",
        confidence: 0.9,
        observations: [{
          imageId,
          depthBackRatio: 0.4,
          boundingBox: { x: 0.39, y: 0.33, width: 0.12, height: 0.1 },
        }],
      },
    });
    const top = item({
      id: "top",
      stack: { on: "middle", conf: 0.9, why: "direct support" },
      loc: {
        status: "matched",
        zoneId: "shelf-1",
        zoneType: "shelf",
        confidence: 0.9,
        observations: [{
          imageId,
          depthBackRatio: 0.4,
          boundingBox: { x: 0.4, y: 0.25, width: 0.1, height: 0.08 },
        }],
      },
    });
    const placements = new Map(
      buildInventoryPlacementLayout(inventory([base, middle, top]))
        .map((placement) => [placement.item.id, placement]),
    );
    const basePlacement = placements.get("base")!;
    const middlePlacement = placements.get("middle")!;
    const topPlacement = placements.get("top")!;

    expect(middlePlacement.z).toBeCloseTo(basePlacement.z);
    expect(topPlacement.z).toBeCloseTo(basePlacement.z);
    expect(middlePlacement.y - middlePlacement.height / 2).toBeCloseTo(
      basePlacement.y + basePlacement.height / 2,
    );
    expect(topPlacement.y - topPlacement.height / 2).toBeCloseTo(
      middlePlacement.y + middlePlacement.height / 2,
    );
  });

  it("rejects stacked items that do not overlap their support footprint", () => {
    const base = item({
      id: "base",
      loc: {
        status: "matched",
        zoneId: "shelf-1",
        zoneType: "shelf",
        confidence: 0.9,
        observations: [{
          imageId,
          depthBackRatio: 0.4,
          boundingBox: { x: 0.05, y: 0.42, width: 0.1, height: 0.18 },
        }],
      },
    });
    const stacked = item({
      id: "stacked",
      stack: { on: "base", conf: 0.9, why: "direct support" },
      loc: {
        status: "matched",
        zoneId: "shelf-1",
        zoneType: "shelf",
        confidence: 0.9,
        observations: [{
          imageId,
          depthBackRatio: 0.4,
          boundingBox: { x: 0.8, y: 0.33, width: 0.1, height: 0.1 },
        }],
      },
    });

    expect(() => buildInventoryPlacementLayout(inventory([base, stacked]))).toThrow(
      "Cannot place stacked item stacked because its footprint does not overlap support item base",
    );
  });

  it("keeps same-shelf rendered X order aligned with detected image X order", () => {
    const shelf = {
      id: "bottom-shelf",
      type: "shelf" as const,
      label: "Bottom shelf",
      order: 0,
      boundingBox: { x: 0.12, y: 0.58, width: 0.76, height: 0.035 },
      imageIds: [imageId],
      sourceZoneDetectionIds: ["bottom-shelf"],
      confidence: 0.9,
      estimatedCapacityRatio: null,
      estimatedOccupiedRatio: null,
    };
    const lemonade = item({
      id: "lemonade",
      name: "Simply Lemonade",
      label: "Simply Lemonade",
      pack: "bottle",
      loc: {
        status: "matched",
        zoneId: shelf.id,
        zoneType: "shelf",
        confidence: 0.9,
        observations: [{
          imageId,
          depthBackRatio: 0.5,
          boundingBox: { x: 0.16, y: 0.47, width: 0.12, height: 0.24 },
        }],
      },
    });
    const bai = item({
      id: "bai",
      name: "Bai",
      label: "Bai",
      pack: "bottle",
      loc: {
        status: "matched",
        zoneId: shelf.id,
        zoneType: "shelf",
        confidence: 0.9,
        observations: [{
          imageId,
          depthBackRatio: 0.5,
          boundingBox: { x: 0.28, y: 0.47, width: 0.07, height: 0.22 },
        }],
      },
    });
    const placements = new Map(
      buildInventoryPlacementLayout(inventory([bai, lemonade], [shelf]))
        .map((placement) => [placement.item.id, placement]),
    );

    expect(placements.get("lemonade")!.x).toBeLessThan(placements.get("bai")!.x);
  });

  it("does not stretch rendered package dimensions to detection bounding boxes", () => {
    const tallBottle = item({
      id: "tall-bottle",
      name: "Tea bottle",
      label: "Tea bottle",
      pack: "bottle",
      loc: {
        status: "matched",
        zoneId: "shelf-1",
        zoneType: "shelf",
        confidence: 0.9,
        observations: [{
          imageId,
          depthBackRatio: 0.5,
          boundingBox: { x: 0.18, y: 0.1, width: 0.42, height: 0.72 },
        }],
      },
    });
    const [placement] = buildInventoryPlacementLayout(inventory([tallBottle]));
    const expected = renderedPackageDimensions(tallBottle);
    const observation = tallBottle.loc.observations[0];

    expect(placement.width).toBeCloseTo(expected.width);
    expect(placement.height).toBeCloseTo(expected.height);
    expect(placement.depth).toBeCloseTo(expected.depth);
    expect(placement.width).toBeLessThan(
      observation.boundingBox.width * SCENE_WIDTH,
    );
    expect(placement.height).toBeLessThan(
      observation.boundingBox.height * SCENE_HEIGHT,
    );
  });

  it("repairs unmatched base items to the best fitting same-image storage base", () => {
    const leftZone = {
      id: "left",
      type: "shelf" as const,
      label: "Left shelf",
      order: 0,
      boundingBox: { x: 0, y: 0.3, width: 0.45, height: 0.3 },
      imageIds: [imageId],
      sourceZoneDetectionIds: ["left"],
      confidence: 0.9,
      estimatedCapacityRatio: null,
      estimatedOccupiedRatio: null,
    };
    const rightZone = {
      ...leftZone,
      id: "right",
      label: "Right shelf",
      boundingBox: { x: 0.55, y: 0.3, width: 0.45, height: 0.3 },
    };
    const unresolved = item({
      id: "unresolved",
      loc: {
        status: "unmatched",
        zoneId: null,
        zoneType: null,
        confidence: null,
        observations: [{
          imageId,
          depthBackRatio: null,
          boundingBox: { x: 0.7, y: 0.43, width: 0.12, height: 0.17 },
        }],
      },
    });
    const placed = canonicalizeInventoryPlacement(
      inventory([unresolved], [leftZone, rightZone]),
    );

    expect(placed.items[0].loc).toMatchObject({
      status: "matched",
      zoneId: "right",
      zoneType: "shelf",
    });
    expect(placed.items[0].loc.observations[0].depthBackRatio).toBeCloseTo(1);
  });

  it("does not repair an unmatched item onto a geometrically unrelated shelf", () => {
    const sameColumnZone = {
      id: "same-column",
      type: "shelf" as const,
      label: "Left shelf",
      order: 0,
      boundingBox: { x: 0.02, y: 0.22, width: 0.3, height: 0.04 },
      imageIds: [imageId],
      sourceZoneDetectionIds: ["same-column"],
      confidence: 0.9,
      estimatedCapacityRatio: null,
      estimatedOccupiedRatio: null,
    };
    const wrongSideCloserZone = {
      id: "wrong-side",
      type: "shelf" as const,
      label: "Right lower shelf",
      order: 1,
      boundingBox: { x: 0.7, y: 0.52, width: 0.25, height: 0.04 },
      imageIds: [imageId],
      sourceZoneDetectionIds: ["wrong-side"],
      confidence: 0.9,
      estimatedCapacityRatio: null,
      estimatedOccupiedRatio: null,
    };
    const unresolved = item({
      id: "unresolved",
      loc: {
        status: "unmatched",
        zoneId: null,
        zoneType: null,
        confidence: null,
        observations: [{
          imageId,
          depthBackRatio: null,
          boundingBox: { x: 0.08, y: 0.42, width: 0.12, height: 0.12 },
        }],
      },
    });
    const placed = canonicalizeInventoryPlacement(
      inventory([unresolved], [sameColumnZone, wrongSideCloserZone]),
    );

    expect(placed.items[0].loc).toMatchObject({
      status: "unmatched",
      zoneId: null,
      zoneType: null,
    });
  });

  it("does not choose a lower support zone solely from bbox bottom distance", () => {
    const middleZone = {
      value: "middle",
      id: "middle",
      type: "shelf" as const,
      boundingBox: { x: 0.5, y: 0.32, width: 0.5, height: 0.24 },
      confidence: 0.9,
    };
    const bottomZone = {
      value: "bottom",
      id: "bottom",
      type: "shelf" as const,
      boundingBox: { x: 0, y: 0.815, width: 1, height: 0.035 },
      confidence: 0.9,
    };

    expect(
      chooseBestSupportZone(
        { x: 0.65, y: 0.41, width: 0.153, height: 0.405 },
        [middleZone, bottomZone],
      )?.value,
    ).toBe("middle");
  });

  it("returns null when no support zone has vertical overlap", () => {
    expect(
      chooseBestSupportZone(
        { x: 0.2, y: 0.2, width: 0.1, height: 0.1 },
        [
          {
            value: "lower",
            id: "lower",
            type: "shelf",
            boundingBox: { x: 0.1, y: 0.55, width: 0.8, height: 0.04 },
            confidence: 0.9,
          },
        ],
      ),
    ).toBeNull();
  });

  it("preserves valid matched scan shelf assignments instead of re-picking by bottom edge", () => {
    const shelves = [
      {
        id: "shelf-1",
        type: "shelf" as const,
        label: "Top shelf",
        order: 0,
        boundingBox: { x: 0, y: 0.2, width: 1, height: 0.025 },
        imageIds: [imageId],
        sourceZoneDetectionIds: ["shelf-1"],
        confidence: 0.9,
        estimatedCapacityRatio: null,
        estimatedOccupiedRatio: null,
      },
      {
        id: "shelf-2",
        type: "shelf" as const,
        label: "Middle shelf",
        order: 1,
        boundingBox: { x: 0, y: 0.5, width: 1, height: 0.025 },
        imageIds: [imageId],
        sourceZoneDetectionIds: ["shelf-2"],
        confidence: 0.9,
        estimatedCapacityRatio: null,
        estimatedOccupiedRatio: null,
      },
      {
        id: "shelf-3",
        type: "shelf" as const,
        label: "Bottom shelf",
        order: 2,
        boundingBox: { x: 0, y: 0.75, width: 1, height: 0.025 },
        imageIds: [imageId],
        sourceZoneDetectionIds: ["shelf-3"],
        confidence: 0.9,
        estimatedCapacityRatio: null,
        estimatedOccupiedRatio: null,
      },
    ];
    const lowerBox = item({
      id: "lower-box",
      loc: {
        status: "matched",
        zoneId: "shelf-2",
        zoneType: "shelf",
        confidence: 0.9,
        observations: [{
          imageId,
          depthBackRatio: 1,
          boundingBox: { x: 0.4, y: 0.53, width: 0.12, height: 0.25 },
        }],
      },
    });
    const higherBox = item({
      id: "higher-box",
      loc: {
        status: "matched",
        zoneId: "shelf-3",
        zoneType: "shelf",
        confidence: 0.9,
        observations: [{
          imageId,
          depthBackRatio: 0,
          boundingBox: { x: 0.58, y: 0.585, width: 0.12, height: 0.11 },
        }],
      },
    });

    const placed = canonicalizeInventoryPlacement(
      inventory([lowerBox, higherBox], shelves),
    );
    const byId = new Map(placed.items.map((candidate) => [candidate.id, candidate]));
    const placedLowerBox = byId.get("lower-box")!;
    const placedHigherBox = byId.get("higher-box")!;

    expect(placedLowerBox.loc.zoneId).toBe("shelf-2");
    expect(placedHigherBox.loc.zoneId).toBe("shelf-3");
  });
});
