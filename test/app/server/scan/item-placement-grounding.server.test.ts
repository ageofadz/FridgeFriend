import { describe, expect, it } from "vitest";

import { GroundItemPlacementsResponseSchema } from "../../../../app/server/scan/schemas/scan-result";
import { groundItemPlacements } from "../../../../app/server/scan/services/item-placement-grounding.server";

function groundingState(imageId: string) {
  return {
    fridgeId: "fridge-1",
    imageIds: [imageId],
    rawDetections: [{
      id: "container-1",
      img: imageId,
      name: "food container",
      conf: 0.95,
      bbox: { x: 0.25, y: 0.35, width: 0.2, height: 0.15 },
      pack: "container",
      qty: null,
    }],
    zoneMaps: [{
      imageId,
      zones: [{
        id: "middle-shelf",
        img: imageId,
        type: "shelf",
        bbox: { x: 0.1, y: 0.48, width: 0.8, height: 0.02 },
        surfaceY: 0.5,
        ord: 0,
        name: "middle shelf",
        conf: 0.9,
        partial: false,
      }],
    }],
  };
}

describe("groundItemPlacements", () => {
  it("keeps the legacy provider schema Gemini-compatible while grounding is deterministic", () => {
    const serializedSchema = JSON.stringify(GroundItemPlacementsResponseSchema);

    expect(serializedSchema).toContain('"placements"');
    expect(serializedSchema).toContain('"supportKind"');
    expect(serializedSchema).toContain('"needs_review"');
    expect(serializedSchema).not.toContain("anyOf");
  });

  it("zones an item to a mapped storage bbox even when it is not already sitting on the surface", async () => {
    await expect(groundItemPlacements({
      fridgeId: "fridge-1",
      imageIds: ["image-1"],
      rawDetections: [{
        id: "container-1",
        img: "image-1",
        name: "food container",
        conf: 0.95,
        bbox: { x: 0.25, y: 0.2, width: 0.2, height: 0.15 },
        pack: "container",
        qty: null,
      }],
      zoneMaps: [{
        imageId: "image-1",
        zones: [{
          id: "lower-shelf",
          img: "image-1",
          type: "shelf",
          bbox: { x: 0.1, y: 0.7, width: 0.8, height: 0.03 },
          surfaceY: 0.73,
          ord: 0,
          name: "lower shelf",
          conf: 0.9,
          partial: false,
        }],
      }],
    } as never, {})).resolves.toEqual({
      groundedPlacements: [{
        detectionId: "container-1",
        status: "placed",
        supportKind: "zone",
        supportId: "lower-shelf",
        depth: { back: 0.21, front: 0.49 },
        confidence: 0.39,
      }],
      placementValidation: {
        valid: true,
        reason: "Item placement grounding completed",
      },
    });
  });

  it("zones an item deterministically when its bounds cross an intervening shelf clearance", async () => {
    await expect(groundItemPlacements({
      fridgeId: "fridge-1",
      imageIds: ["image-1"],
      rawDetections: [{
        id: "container-1",
        img: "image-1",
        name: "food container",
        conf: 0.95,
        bbox: { x: 0.3, y: 0.12, width: 0.16, height: 0.39 },
        pack: "container",
        qty: null,
      }],
      zoneMaps: [{
        imageId: "image-1",
        zones: [
          {
            id: "upper-shelf",
            img: "image-1",
            type: "shelf",
            bbox: { x: 0.1, y: 0.29, width: 0.8, height: 0.02 },
            surfaceY: 0.31,
            ord: 0,
            name: "upper shelf",
            conf: 0.9,
            partial: false,
          },
          {
            id: "middle-shelf",
            img: "image-1",
            type: "shelf",
            bbox: { x: 0.1, y: 0.49, width: 0.8, height: 0.02 },
            surfaceY: 0.51,
            ord: 1,
            name: "middle shelf",
            conf: 0.9,
            partial: false,
          },
        ],
      }],
    } as never, {})).resolves.toEqual({
      groundedPlacements: [{
        detectionId: "container-1",
        status: "placed",
        supportKind: "zone",
        supportId: "upper-shelf",
        depth: { back: 0.268, front: 0.492 },
        confidence: 0.4028205128205128,
      }],
      placementValidation: {
        valid: true,
        reason: "Item placement grounding completed",
      },
    });
  });

  it("grounds a shelf-supported item deterministically", async () => {
    await expect(groundItemPlacements(groundingState("image-1") as never, {})).resolves.toEqual({
      groundedPlacements: [{
        detectionId: "container-1",
        status: "placed",
        supportKind: "zone",
        supportId: "middle-shelf",
        depth: { back: 0.21, front: 0.49 },
        confidence: 0.7733333333333332,
      }],
      placementValidation: {
        valid: true,
        reason: "Item placement grounding completed",
      },
    });
  });

  it("zones items using the mapped bbox surface when support zones are missing surfaceY", async () => {
    await expect(groundItemPlacements({
      ...groundingState("image-1"),
      zoneMaps: [{
        imageId: "image-1",
        zones: [{
          id: "middle-shelf",
          img: "image-1",
          type: "shelf",
          bbox: { x: 0.1, y: 0.48, width: 0.8, height: 0.02 },
          ord: 0,
          name: "middle shelf",
          conf: 0.9,
          partial: false,
        }],
      }],
    } as never, {})).resolves.toEqual({
      groundedPlacements: [{
        detectionId: "container-1",
        status: "placed",
        supportKind: "zone",
        supportId: "middle-shelf",
        depth: { back: 0.21, front: 0.49 },
        confidence: 0.7733333333333332,
      }],
      placementValidation: {
        valid: true,
        reason: "Item placement grounding completed",
      },
    });
  });

  it("zones stacked-looking detections directly to mapped storage bboxes", async () => {
    await expect(groundItemPlacements({
      ...groundingState("image-1"),
      rawDetections: [
        {
          id: "unsupported-base",
          img: "image-1",
          name: "base container",
          conf: 0.95,
          bbox: { x: 0.25, y: 0.2, width: 0.2, height: 0.15 },
          pack: "container",
          qty: null,
        },
        {
          id: "top-container",
          img: "image-1",
          name: "top container",
          conf: 0.9,
          bbox: { x: 0.27, y: 0.08, width: 0.16, height: 0.12 },
          pack: "container",
          qty: null,
        },
      ],
      zoneMaps: [{
        imageId: "image-1",
        zones: [{
          id: "lower-shelf",
          img: "image-1",
          type: "shelf",
          bbox: { x: 0.1, y: 0.7, width: 0.8, height: 0.03 },
          surfaceY: 0.73,
          ord: 0,
          name: "lower shelf",
          conf: 0.9,
          partial: false,
        }],
      }],
    } as never, {})).resolves.toEqual({
      groundedPlacements: [
        {
          detectionId: "unsupported-base",
          status: "placed",
          supportKind: "zone",
          supportId: "lower-shelf",
          depth: { back: 0.21, front: 0.49 },
          confidence: 0.39,
        },
        {
          detectionId: "top-container",
          status: "placed",
          supportKind: "zone",
          supportId: "lower-shelf",
          depth: { back: 0.23800000000000004, front: 0.462 },
          confidence: 0.39,
        },
      ],
      placementValidation: {
        valid: true,
        reason: "Item placement grounding completed",
      },
    });
  });

  it("preserves output ordering for stacked-looking detections while zoning each item", async () => {
    const result = await groundItemPlacements({
      ...groundingState("image-1"),
      rawDetections: [
        {
          id: "base-container",
          img: "image-1",
          name: "base container",
          conf: 0.95,
          bbox: { x: 0.25, y: 0.35, width: 0.2, height: 0.15 },
          pack: "container",
          qty: null,
        },
        {
          id: "top-container",
          img: "image-1",
          name: "top container",
          conf: 0.9,
          bbox: { x: 0.27, y: 0.23, width: 0.16, height: 0.12 },
          pack: "container",
          qty: null,
        },
      ],
    } as never, {});

    expect(result).toHaveProperty("groundedPlacements");
    if (!("groundedPlacements" in result)) {
      const failure = result as { placementValidation?: { reason?: string } };
      throw new Error(failure.placementValidation?.reason ?? "Item placement grounding failed");
    }

    expect(result.groundedPlacements).toEqual([
      expect.objectContaining({
        detectionId: "base-container",
        status: "placed",
        supportKind: "zone",
        supportId: "middle-shelf",
      }),
      expect.objectContaining({
        detectionId: "top-container",
        status: "placed",
        supportKind: "zone",
        supportId: "middle-shelf",
      }),
    ]);
  });
});
