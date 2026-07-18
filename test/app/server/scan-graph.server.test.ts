import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encode as encodeJpeg } from "jpeg-js";

import { fridgeImages } from "../../../app/server/db/schema.server";
import { createFridgeImage } from "../../../app/server/images.server";
import { PromptName } from "../../../app/server/prompts/registry.server";
import { detectInventory } from "../../../app/server/scan/services/inventory-detection.server";
import { reconcileInventory } from "../../../app/server/scan/services/inventory-reconciliation.server";
import { mapZones } from "../../../app/server/scan/services/zone-map.server";
import {
  CHAT_PROVIDER,
  CHAT_VISION_MODEL as VISION_MODEL,
} from "../../../app/server/ai/chat-model.server";
import {
  ImageValidationModelResult,
  InventoryDetectionResponseSchema,
  ZoneMapResponseSchema,
} from "../../../app/server/scan/schemas/scan-result";
import { reconcileInventoryNode } from "../../../app/server/scan/nodes/reconcile-inventory.node";
import { routeAfterInventoryReconciliation } from "../../../app/server/scan/routing/scan-routing";
import { validateImagesNode } from "../../../app/server/scan/nodes/validate-images.node";
import { withDatabase } from "../../../app/server/sqlite.server";

function setTestDatabase() {
  const databasePath = path.join(
    tmpdir(),
    `fridgefriend-scan-test-${randomUUID()}.sqlite`,
  );
  process.env.DATABASE_PATH = databasePath;
  return databasePath;
}

function insertStoredImage(id: string, dataUrl: string) {
  withDatabase((db) => {
    db.insert(fridgeImages)
      .values({
        id,
        dataUrl,
        originalName: null,
        storageLocation: "fridge",
        baseImageId: null,
        createdAt: new Date().toISOString(),
      })
      .run();
  });
}

function createJpegDataUrl() {
  const jpeg = encodeJpeg(
    {
      data: Buffer.from([255, 255, 255, 255]),
      width: 1,
      height: 1,
    },
    100,
  );

  return `data:image/jpeg;base64,${Buffer.from(jpeg.data).toString("base64")}`;
}

describe("validateImagesNode", () => {
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

  function validateImageState(imageIds: string[]) {
    return validateImagesNode(
      {
        fridgeId: "fridge-1",
        imageIds,
        storageLocation: "fridge",
      } as never,
      {
        promptBundle: {
          imageValidation: {
            name: PromptName.ImageValidation,
            ref: "fridgefriend-fridge-perception:latest",
            prompt: {
              invoke: vi.fn(),
            },
          },
        },
      } as never,
    );
  }

  it("returns an invalid validation result when no image is provided", async () => {
    await expect(validateImageState([])).resolves.toEqual({
      imageValidation: {
        valid: false,
        reason: "At least one fridge image is required",
      },
    });
  });

  it("returns an invalid validation result for non-JPEG image data", async () => {
    const imageId = randomUUID();
    insertStoredImage(imageId, "data:image/png;base64,AAAA");

    await expect(validateImageState([imageId])).resolves.toEqual({
      imageValidation: {
        valid: false,
        reason: "Image 1 must be a JPEG data URL",
      },
    });
  });

  it("returns an invalid validation result for corrupt JPEG data", async () => {
    const image = createFridgeImage({
      dataUrl: "data:image/jpeg;base64,/9gAAA==",
      originalName: null,
      storageLocation: "fridge",
      baseImageId: null
    });

    await expect(validateImageState([image.id])).resolves.toEqual({
      imageValidation: {
        valid: false,
        reason: expect.stringContaining("Image 1 is not loadable JPEG data"),
      },
    });
  });

  it("uses flash lite for image validation", async () => {
    const image = createFridgeImage({
      dataUrl: createJpegDataUrl(),
      originalName: null,
      storageLocation: "fridge",
      baseImageId: null
    });
    const promptInvoke = vi.fn(async () => ({
      toChatMessages: () => ["message"],
    }));
    const modelInvoke = vi.fn(async () => ({
      isFridge: true,
      reason: "fridge interior is visible",
    }));
    const withStructuredOutput = vi.fn(() => ({
      invoke: modelInvoke,
    }));

    await expect(
      validateImagesNode(
        {
          fridgeId: "fridge-1",
          imageIds: [image.id],
          storageLocation: "fridge",
        } as never,
        {
          promptBundle: {
            imageValidation: {
              name: PromptName.ImageValidation,
              ref: "fridgefriend-fridge-perception:latest",
              prompt: {
                invoke: promptInvoke,
              },
            },
          },
          validationModel: {
            withStructuredOutput,
          },
        } as never,
      ),
    ).resolves.toEqual({
      imageValidation: {
        valid: true,
        reason: "fridge interior is visible",
      },
    });

    expect(withStructuredOutput).toHaveBeenCalledWith(
      ImageValidationModelResult,
      {
        name: "ImageValidation",
      },
    );
    expect(promptInvoke).toHaveBeenCalledWith({
      image_data_url: image.dataUrl,
      storage_location: "fridge",
    });
    expect(modelInvoke).toHaveBeenCalledWith(["message"], {
      tags: ["scan", "validate_image"],
      metadata: {
        langsmithPromptName: PromptName.ImageValidation,
        langsmithPromptRef: "fridgefriend-fridge-perception:latest",
        provider: CHAT_PROVIDER,
        model: VISION_MODEL,
      },
    });
  });

  it("passes the pantry target to the validation prompt", async () => {
    const image = createFridgeImage({
      dataUrl: createJpegDataUrl(),
      originalName: null,
      storageLocation: "pantry",
      baseImageId: "fridge-1",
    });
    const promptInvoke = vi.fn(async () => ({
      toChatMessages: () => ["message"],
    }));

    await validateImagesNode(
      {
        fridgeId: "fridge-1",
        imageIds: [image.id],
        storageLocation: "pantry",
      } as never,
      {
        promptBundle: {
          imageValidation: {
            name: PromptName.ImageValidation,
            ref: "fridgefriend-fridge-perception:latest",
            prompt: {
              invoke: promptInvoke,
            },
          },
        },
        validationModel: {
          withStructuredOutput: vi.fn(() => ({
            invoke: vi.fn(async () => ({
              isFridge: true,
              reason: "pantry shelves are visible",
            })),
          })),
        },
      } as never,
    );

    expect(promptInvoke).toHaveBeenCalledWith({
      image_data_url: image.dataUrl,
      storage_location: "pantry",
    });
  });
});

describe("detectInventory", () => {
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

  it("returns an invalid detection result when no image is provided", async () => {
    await expect(
      detectInventory(
        {
          fridgeId: "fridge-1",
          imageIds: [],
        } as never,
        {} as never,
      ),
    ).resolves.toEqual({
      rawDetections: [],
      detectionModelRawOutput: null,
      detectionValidation: {
        valid: false,
        reason: "At least one fridge image is required",
      },
    });
  });

  it("runs the inventory detection prompt and returns raw detections", async () => {
    const image = createFridgeImage({
      dataUrl: createJpegDataUrl(),
      originalName: null,
      storageLocation: "fridge",
      baseImageId: null
    });
    const rawDetections = [
      {
        id: "detection-1",
        img: image.id,
        name: "milk carton",
        conf: 0.92,
        bbox: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
        zone: {
          zoneType: "shelf",
          relativePosition: "middle",
          confidence: 0.71,
        },
        pack: "carton",
        qty: "one carton",
      },
    ];
    const promptInvoke = vi.fn(async () => ({
      toChatMessages: () => ["message"],
    }));
    const modelInvoke = vi.fn(async () => ({ rawDetections }));
    const withStructuredOutput = vi.fn(() => ({
      invoke: modelInvoke,
    }));

    await expect(
      detectInventory(
        {
          fridgeId: "fridge-1",
          imageIds: [image.id],
        } as never,
        {
          promptBundle: {
            inventoryDetection: {
              name: PromptName.InventoryDetection,
              ref: "fridgefriend-inventory-detection:latest",
              prompt: {
                invoke: promptInvoke,
              },
            },
          },
          detectionModel: {
            withStructuredOutput,
          },
        } as never,
      ),
    ).resolves.toEqual({
      rawDetections,
      detectionModelRawOutput: {
        rawDetections,
      },
      detectionValidation: {
        valid: true,
        reason: "Inventory detection completed",
      },
    });

    expect(promptInvoke).toHaveBeenCalledWith({
      image_id: image.id,
      image_data_url: image.dataUrl,
    });
    expect(withStructuredOutput).toHaveBeenCalledWith(
      InventoryDetectionResponseSchema,
      {
        name: "InventoryDetection",
      },
    );
    expect(modelInvoke).toHaveBeenCalledWith(["message"], {
      tags: ["scan", "detect_inventory"],
      metadata: {
        langsmithPromptName: PromptName.InventoryDetection,
        langsmithPromptRef: "fridgefriend-inventory-detection:latest",
        provider: CHAT_PROVIDER,
        model: VISION_MODEL,
      },
    });
  });

  it("uses a Gemini-compatible inventory detection response schema", () => {
    const serializedSchema = JSON.stringify(InventoryDetectionResponseSchema);

    expect(serializedSchema).toContain("unidentified visible inventory objects");
    expect(serializedSchema).toContain('"bbox"');
    expect(serializedSchema).not.toContain('"depthPosition"');
    expect(serializedSchema).not.toContain('"front"');
    expect(serializedSchema).not.toContain('"back"');
    expect(serializedSchema).toContain('"stack"');
    expect(serializedSchema).not.toContain('"estimatedDimensions"');
    expect(serializedSchema).not.toContain('"footprint"');
    expect(serializedSchema).not.toContain('"stack"],');
    expect(serializedSchema).not.toContain("shelfPos");
    expect(serializedSchema).not.toContain("exclusiveMinimum");
    expect(serializedSchema).not.toContain("anyOf");
  });

  it("normalizes image file names in inventory detections to the stored image id", async () => {
    const image = createFridgeImage({
      dataUrl: createJpegDataUrl(),
      originalName: null,
      storageLocation: "fridge",
      baseImageId: null
    });
    const rawDetections = [
      {
        id: "detection-1",
        img: `${image.id}.jpg`,
        name: "milk carton",
        conf: 0.92,
        bbox: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
        zone: null,
        stack: undefined,
        pack: "carton",
        qty: "one carton",
      },
    ];
    const promptInvoke = vi.fn(async () => ({
      toChatMessages: () => ["message"],
    }));
    const modelInvoke = vi.fn(async () => ({ rawDetections }));
    const withStructuredOutput = vi.fn(() => ({
      invoke: modelInvoke,
    }));

    await expect(
      detectInventory(
        {
          fridgeId: "fridge-1",
          imageIds: [image.id],
        } as never,
        {
          promptBundle: {
            inventoryDetection: {
              name: PromptName.InventoryDetection,
              ref: "fridgefriend-inventory-detection:latest",
              prompt: {
                invoke: promptInvoke,
              },
            },
          },
          detectionModel: {
            withStructuredOutput,
          },
        } as never,
      ),
    ).resolves.toMatchObject({
      rawDetections: [
        {
          id: "detection-1",
          img: image.id,
          name: "milk carton",
        },
      ],
      detectionValidation: {
        valid: true,
        reason: "Inventory detection completed",
      },
    });
  });

  it("accepts unidentified visible inventory detections", async () => {
    const image = createFridgeImage({
      dataUrl: createJpegDataUrl(),
      originalName: null,
      storageLocation: "fridge",
      baseImageId: null
    });
    const rawDetections = [
      {
        id: "detection-unknown-1",
        img: image.id,
        name: "unknown container",
        conf: 0.64,
        bbox: { x: 0.24, y: 0.36, width: 0.18, height: 0.14 },
        zone: null,
        pack: "container",
        qty: null,
      },
    ];
    const promptInvoke = vi.fn(async () => ({
      toChatMessages: () => ["message"],
    }));
    const modelInvoke = vi.fn(async () => ({ rawDetections }));
    const withStructuredOutput = vi.fn(() => ({
      invoke: modelInvoke,
    }));

    await expect(
      detectInventory(
        {
          fridgeId: "fridge-1",
          imageIds: [image.id],
        } as never,
        {
          promptBundle: {
            inventoryDetection: {
              name: PromptName.InventoryDetection,
              ref: "fridgefriend-inventory-detection:latest",
              prompt: {
                invoke: promptInvoke,
              },
            },
          },
          detectionModel: {
            withStructuredOutput,
          },
        } as never,
      ),
    ).resolves.toEqual({
      rawDetections,
      detectionModelRawOutput: {
        rawDetections,
      },
      detectionValidation: {
        valid: true,
        reason: "Inventory detection completed",
      },
    });
  });

  it("returns raw stacking hints when they reference another same-image detection", async () => {
    const image = createFridgeImage({
      dataUrl: createJpegDataUrl(),
      originalName: null,
      storageLocation: "fridge",
      baseImageId: null
    });
    const rawDetections = [
      {
        id: "detection-1",
        img: image.id,
        name: "yogurt cup",
        conf: 0.91,
        bbox: { x: 0.2, y: 0.2, width: 0.12, height: 0.12 },
        zone: null,
        stack: {
          on: "detection-2",
          conf: 0.82,
          why: "bottom edge rests on the container below",
        },
        pack: "container",
        qty: "one cup",
      },
      {
        id: "detection-2",
        img: image.id,
        name: "leftover container",
        conf: 0.93,
        bbox: { x: 0.2, y: 0.32, width: 0.16, height: 0.12 },
        zone: null,
        pack: "container",
        qty: "one container",
      },
    ];
    const promptInvoke = vi.fn(async () => ({
      toChatMessages: () => ["message"],
    }));
    const modelInvoke = vi.fn(async () => ({ rawDetections }));
    const withStructuredOutput = vi.fn(() => ({
      invoke: modelInvoke,
    }));

    await expect(
      detectInventory(
        {
          fridgeId: "fridge-1",
          imageIds: [image.id],
        } as never,
        {
          promptBundle: {
            inventoryDetection: {
              name: PromptName.InventoryDetection,
              ref: "fridgefriend-inventory-detection:latest",
              prompt: {
                invoke: promptInvoke,
              },
            },
          },
          detectionModel: {
            withStructuredOutput,
          },
        } as never,
      ),
    ).resolves.toEqual({
      rawDetections,
      detectionModelRawOutput: {
        rawDetections,
      },
      detectionValidation: {
        valid: true,
        reason: "Inventory detection completed",
      },
    });
  });

  it("returns invalid detection validation for unknown stacking references", async () => {
    const image = createFridgeImage({
      dataUrl: createJpegDataUrl(),
      originalName: null,
      storageLocation: "fridge",
      baseImageId: null
    });
    const rawDetections = [
      {
        id: "detection-1",
        img: image.id,
        name: "yogurt cup",
        conf: 0.91,
        bbox: { x: 0.2, y: 0.2, width: 0.12, height: 0.12 },
        zone: null,
        stack: {
          on: "missing-detection",
          conf: 0.82,
          why: "bottom edge rests on another item",
        },
        pack: "container",
        qty: "one cup",
      },
    ];
    const promptInvoke = vi.fn(async () => ({
      toChatMessages: () => ["message"],
    }));
    const modelInvoke = vi.fn(async () => ({ rawDetections }));
    const withStructuredOutput = vi.fn(() => ({
      invoke: modelInvoke,
    }));

    await expect(
      detectInventory(
        {
          fridgeId: "fridge-1",
          imageIds: [image.id],
        } as never,
        {
          promptBundle: {
            inventoryDetection: {
              name: PromptName.InventoryDetection,
              ref: "fridgefriend-inventory-detection:latest",
              prompt: {
                invoke: promptInvoke,
              },
            },
          },
          detectionModel: {
            withStructuredOutput,
          },
        } as never,
      ),
    ).resolves.toEqual({
      rawDetections: [],
      detectionModelRawOutput: {
        rawDetections,
      },
      detectionValidation: {
        valid: false,
        reason: expect.stringContaining(
          "references unknown detection id missing-detection",
        ),
      },
    });
  });

  it("retries invalid raw detections before returning detection validation", async () => {
    const image = createFridgeImage({
      dataUrl: createJpegDataUrl(),
      originalName: null,
      storageLocation: "fridge",
      baseImageId: null
    });
    const promptInvoke = vi.fn(async () => ({
      toChatMessages: () => ["message"],
    }));
    const invalidRawDetections = [
      {
        id: "detection-1",
        img: image.id,
        name: "milk carton",
        conf: 0.92,
        bbox: { x: 0.1, y: 0.2, width: 0, height: 0.4 },
        zone: null,
        pack: "carton",
        qty: "one carton",
      },
    ];
    const correctedRawDetections = [
      {
        id: "detection-1",
        img: image.id,
        name: "milk carton",
        conf: 0.92,
        bbox: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
        zone: null,
        pack: "carton",
        qty: "one carton",
      },
    ];
    const modelInvoke = vi.fn()
      .mockResolvedValueOnce({ rawDetections: invalidRawDetections })
      .mockResolvedValueOnce({ rawDetections: correctedRawDetections });
    const withStructuredOutput = vi.fn(() => ({
      invoke: modelInvoke,
    }));

    await expect(
      detectInventory(
        {
          fridgeId: "fridge-1",
          imageIds: [image.id],
        } as never,
        {
          promptBundle: {
            inventoryDetection: {
              name: PromptName.InventoryDetection,
              ref: "fridgefriend-inventory-detection:latest",
              prompt: {
                invoke: promptInvoke,
              },
            },
          },
          detectionModel: {
            withStructuredOutput,
          },
        } as never,
      ),
    ).resolves.toEqual({
      rawDetections: correctedRawDetections,
      detectionModelRawOutput: {
        rawDetections: correctedRawDetections,
      },
      detectionValidation: {
        valid: true,
        reason: "Inventory detection completed",
      },
    });
    expect(modelInvoke).toHaveBeenCalledTimes(2);
    expect(modelInvoke.mock.calls[1][0][1].content).toContain(
      "rawDetections.0.bbox.width",
    );
  });

  it("normalizes Gemini 0-1000 bounding boxes before validation", async () => {
    const image = createFridgeImage({
      dataUrl: createJpegDataUrl(),
      originalName: null,
      storageLocation: "fridge",
      baseImageId: null
    });
    const promptInvoke = vi.fn(async () => ({
      toChatMessages: () => ["message"],
    }));
    const modelInvoke = vi.fn(async () => ({
      rawDetections: [
        {
          id: "detection-1",
          img: image.id,
          name: "juice bottle",
          conf: 0.98,
          bbox: { x: 518, y: 231, width: 135, height: 487 },
          zone: null,
          pack: "bottle",
          qty: "1 bottle",
        },
        {
          id: "detection-2",
          img: image.id,
          name: "yogurt",
          conf: 0.96,
          bbox: { x: 24, y: 530, width: 125, height: 645 },
          zone: null,
          pack: "container",
          qty: "1 container",
        },
        {
          id: "detection-3",
          img: image.id,
          name: "tea",
          conf: 0.97,
          bbox: { x: 938, y: 291, width: 135, height: 525 },
          zone: null,
          pack: "bottle",
          qty: "1 bottle",
        },
      ],
    }));
    const withStructuredOutput = vi.fn(() => ({
      invoke: modelInvoke,
    }));

    await expect(
      detectInventory(
        {
          fridgeId: "fridge-1",
          imageIds: [image.id],
        } as never,
        {
          promptBundle: {
            inventoryDetection: {
              name: PromptName.InventoryDetection,
              ref: "fridgefriend-inventory-detection:latest",
              prompt: {
                invoke: promptInvoke,
              },
            },
          },
          detectionModel: {
            withStructuredOutput,
          },
        } as never,
      ),
    ).resolves.toMatchObject({
      rawDetections: [
        {
          bbox: { x: 0.518, y: 0.231, width: 0.135, height: 0.487 },
        },
        {
          bbox: { x: 0.024, y: 0.53, width: 0.125, height: 0.115 },
        },
        {
          bbox: { x: 0.938, y: 0.291, width: 0.062, height: 0.525 },
        },
      ],
      detectionValidation: {
        valid: true,
        reason: "Inventory detection completed",
      },
    });
  });
});

describe("mapZones", () => {
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

  it("returns an invalid zone-map result when no image is provided", async () => {
    await expect(
      mapZones(
        {
          fridgeId: "fridge-1",
          imageIds: [],
        } as never,
        {} as never,
      ),
    ).resolves.toEqual({
      zoneMaps: [],
      zoneMapModelRawOutput: null,
      zoneMapValidation: {
        valid: false,
        reason: "At least one fridge image is required",
      },
    });
  });

  it("runs the zone-map prompt and returns image-local zones", async () => {
    const image = createFridgeImage({
      dataUrl: createJpegDataUrl(),
      originalName: null,
      storageLocation: "fridge",
      baseImageId: null
    });
    const zoneMap = {
      imageId: image.id,
      zones: [
        {
          id: "zone-1",
          img: image.id,
          type: "shelf",
          bbox: { x: 0.1, y: 0.2, width: 0.8, height: 0.3 },
          surfaceY: 0.5,
          ord: 0,
          name: "top shelf",
          conf: 0.91,
          partial: false,
        },
      ],
    };
    const promptInvoke = vi.fn(async () => ({
      toChatMessages: () => ["message"],
    }));
    const modelInvoke = vi.fn(async () => zoneMap);
    const withStructuredOutput = vi.fn(() => ({
      invoke: modelInvoke,
    }));

    await expect(
      mapZones(
        {
          fridgeId: "fridge-1",
          imageIds: [image.id],
        } as never,
        {
          promptBundle: {
            zoneMap: {
              name: PromptName.ZoneMap,
              ref: "fridgefriend-zone-map:latest",
              prompt: {
                invoke: promptInvoke,
              },
            },
          },
          zoneMapModel: {
            withStructuredOutput,
          },
        } as never,
      ),
    ).resolves.toEqual({
      zoneMaps: [zoneMap],
      zoneMapModelRawOutput: zoneMap,
      zoneMapValidation: {
        valid: true,
        reason: "Zone map completed",
      },
    });

    expect(promptInvoke).toHaveBeenCalledWith({
      image_id: image.id,
      image_data_url: image.dataUrl,
    });
    expect(withStructuredOutput).toHaveBeenCalledWith(ZoneMapResponseSchema, {
      name: "ZoneMap",
    });
    expect(modelInvoke).toHaveBeenCalledWith(["message"], {
      tags: ["scan", "map_zones"],
      metadata: {
        langsmithPromptName: PromptName.ZoneMap,
        langsmithPromptRef: "fridgefriend-zone-map:latest",
        provider: CHAT_PROVIDER,
        model: VISION_MODEL,
      },
    });
  });

  it("returns invalid zone-map validation for invalid zone boxes", async () => {
    const image = createFridgeImage({
      dataUrl: createJpegDataUrl(),
      originalName: null,
      storageLocation: "fridge",
      baseImageId: null
    });
    const zoneMap = {
      imageId: image.id,
      zones: [
        {
          id: "zone-1",
          img: image.id,
          type: "shelf",
          bbox: { x: 0.1, y: 0.2, width: 0, height: 0.3 },
          ord: 0,
          name: "top shelf",
          conf: 0.91,
          partial: false,
        },
      ],
    };
    const promptInvoke = vi.fn(async () => ({
      toChatMessages: () => ["message"],
    }));
    const modelInvoke = vi.fn(async () => zoneMap);
    const withStructuredOutput = vi.fn(() => ({
      invoke: modelInvoke,
    }));

    await expect(
      mapZones(
        {
          fridgeId: "fridge-1",
          imageIds: [image.id],
        } as never,
        {
          promptBundle: {
            zoneMap: {
              name: PromptName.ZoneMap,
              ref: "fridgefriend-zone-map:latest",
              prompt: {
                invoke: promptInvoke,
              },
            },
          },
          zoneMapModel: {
            withStructuredOutput,
          },
        } as never,
      ),
    ).resolves.toEqual({
      zoneMaps: [],
      zoneMapModelRawOutput: zoneMap,
      zoneMapValidation: {
        valid: false,
        reason: expect.stringContaining("zoneMap.zones.0.bbox.width"),
      },
    });
  });

  it("normalizes Gemini 0-1000 zone boxes before validation", async () => {
    const image = createFridgeImage({
      dataUrl: createJpegDataUrl(),
      originalName: null,
      storageLocation: "fridge",
      baseImageId: null
    });
    const promptInvoke = vi.fn(async () => ({
      toChatMessages: () => ["message"],
    }));
    const modelInvoke = vi.fn(async () => ({
      imageId: image.id,
      zones: [
        {
          id: "zone-1",
          img: image.id,
          type: "shelf",
          bbox: { x: 100, y: 200, width: 800, height: 300 },
          surfaceY: 500,
          ord: 0,
          name: "top shelf",
          conf: 0.91,
          partial: false,
        },
      ],
    }));
    const withStructuredOutput = vi.fn(() => ({
      invoke: modelInvoke,
    }));

    await expect(
      mapZones(
        {
          fridgeId: "fridge-1",
          imageIds: [image.id],
        } as never,
        {
          promptBundle: {
            zoneMap: {
              name: PromptName.ZoneMap,
              ref: "fridgefriend-zone-map:latest",
              prompt: {
                invoke: promptInvoke,
              },
            },
          },
          zoneMapModel: {
            withStructuredOutput,
          },
        } as never,
      ),
    ).resolves.toMatchObject({
      zoneMaps: [
        {
          zones: [
            {
              bbox: { x: 0.1, y: 0.2, width: 0.8, height: 0.3 },
            },
          ],
        },
      ],
      zoneMapValidation: {
        valid: true,
        reason: "Zone map completed",
      },
    });
  });

  it("preserves normalized zone axes when another axis uses Gemini grid values", async () => {
    const image = createFridgeImage({
      dataUrl: createJpegDataUrl(),
      originalName: null,
      storageLocation: "fridge",
      baseImageId: null,
    });
    const zoneMap = {
      imageId: image.id,
      zones: [
        {
          id: "zone-1",
          img: image.id,
          type: "shelf",
          bbox: { x: 0, y: 232, width: 1, height: 0.12 },
          surfaceY: 352,
          ord: 0,
          name: "top shelf",
          conf: 1,
          partial: false,
        },
      ],
    };

    await expect(
      mapZones(
        {
          fridgeId: "fridge-1",
          imageIds: [image.id],
        } as never,
        {
          promptBundle: {
            zoneMap: {
              name: PromptName.ZoneMap,
              ref: "fridgefriend-zone-map:latest",
              prompt: {
                invoke: vi.fn(async () => ({ toChatMessages: () => ["message"] })),
              },
            },
          },
          zoneMapModel: {
            withStructuredOutput: vi.fn(() => ({
              invoke: vi.fn(async () => zoneMap),
            })),
          },
        } as never,
      ),
    ).resolves.toMatchObject({
      zoneMaps: [
        {
          zones: [
            {
              bbox: { x: 0, y: 0.232, width: 1, height: 0.12 },
            },
          ],
        },
      ],
      zoneMapValidation: {
        valid: true,
        reason: "Zone map completed",
      },
    });
  });

  it("corrects normalized hairline support zones", async () => {
    const image = createFridgeImage({
      dataUrl: createJpegDataUrl(),
      originalName: null,
      storageLocation: "fridge",
      baseImageId: null,
    });
    const zoneMap = {
      imageId: image.id,
      zones: [
        {
          id: "zone-1",
          img: image.id,
          type: "shelf",
          bbox: { x: 0, y: 0.232, width: 0.001, height: 0.12 },
          surfaceY: 0.352,
          ord: 0,
          name: "top shelf",
          conf: 1,
          partial: false,
        },
      ],
    };

    const repairedZoneMap = {
      ...zoneMap,
      zones: [{
        ...zoneMap.zones[0],
        bbox: { x: 0, y: 0.232, width: 1, height: 0.12 },
      }],
    };
    const modelInvoke = vi.fn()
      .mockResolvedValueOnce(zoneMap)
      .mockResolvedValueOnce(repairedZoneMap);

    await expect(
      mapZones(
        {
          fridgeId: "fridge-1",
          imageIds: [image.id],
        } as never,
        {
          promptBundle: {
            zoneMap: {
              name: PromptName.ZoneMap,
              ref: "fridgefriend-zone-map:latest",
              prompt: {
                invoke: vi.fn(async () => ({ toChatMessages: () => ["message"] })),
              },
            },
          },
          zoneMapModel: {
            withStructuredOutput: vi.fn(() => ({
              invoke: modelInvoke,
            })),
          },
        } as never,
      ),
    ).resolves.toMatchObject({
      zoneMaps: [{
        zones: [{
          bbox: { x: 0, y: 0.232, width: 1, height: 0.12 },
        }],
      }],
      zoneMapModelRawOutput: repairedZoneMap,
      zoneMapValidation: {
        valid: true,
        reason: "Zone map completed",
      },
    });
    expect(modelInvoke).toHaveBeenCalledTimes(2);
  });

  it("uses a Gemini-compatible zone-map response schema", () => {
    const serializedZoneMap = JSON.stringify(ZoneMapResponseSchema);

    expect(serializedZoneMap).toContain('"partial"');
    expect(
      ZoneMapResponseSchema.properties.zones.items.properties.bbox.properties.width,
    ).toEqual({ type: "number", minimum: 0.04 });
    expect(
      InventoryDetectionResponseSchema.properties.rawDetections.items.properties.bbox.properties.width,
    ).toEqual({ type: "number" });
    expect(serializedZoneMap).not.toContain("volume_cubic_inches");
    expect(serializedZoneMap).not.toContain("exclusiveMinimum");
    expect(serializedZoneMap).not.toContain("anyOf");
  });
});

describe("inventory reconciliation", () => {
  it("stores general recipe ingredients on reconciled inventory items", async () => {
    const detections = [
      { name: "mt olive pickle jar", pack: "jar" },
      { name: "yogurt cup", pack: "container" },
      { name: "egg carton", pack: "carton" },
      { name: "cream cheese container", pack: "container" },
      { name: "butter package", pack: "unknown" },
      { name: "tortilla package", pack: "unknown" },
    ] as const;

    await expect(
      reconcileInventory({
        fridgeId: "fridge-1",
        imageIds: ["image-1"],
        rawDetections: detections.map((detection, index) => ({
          id: `detection-${index + 1}`,
          img: "image-1",
          name: detection.name,
          conf: 0.9,
          bbox: { x: 0.1, y: 0.1, width: 0.1, height: 0.1 },
          zone: null,
          pack: detection.pack,
          qty: null,
        })),
        reconciledLocations: [],
        adjudicationDecisions: [],
        zoneMaps: [{
          imageId: "image-1",
          zones: [{
            id: "zone-1",
            img: "image-1",
            type: "shelf",
            bbox: { x: 0, y: 0, width: 1, height: 0.5 },
            ord: 0,
            name: "shelf",
            conf: 0.9,
            partial: false,
          }],
        }],
      } as never),
    ).resolves.toMatchObject({
      inventory: {
        items: [
          { name: "mt olive pickle jar", label: "mt olive pickle jar", cat: "condiment", subcat: "pickle" },
          { name: "yogurt cup", label: "yogurt cup", cat: "dairy", subcat: "yogurt" },
          { name: "egg carton", label: "egg carton", cat: "eggs", subcat: "egg" },
          { name: "cream cheese container", label: "cream cheese container", cat: "dairy", subcat: "cream cheese" },
          { name: "butter package", label: "butter package", cat: "dairy", subcat: "butter" },
          { name: "tortilla package", label: "tortilla package", cat: "other", subcat: "tortilla" },
        ],
      },
    });
  });

  it("keeps unidentified visible detections in inventory for review", async () => {
    await expect(
      reconcileInventory({
        fridgeId: "fridge-1",
        imageIds: ["image-1"],
        rawDetections: [
          {
            id: "detection-unknown-1",
            img: "image-1",
            name: "unknown container",
            conf: 0.64,
            bbox: { x: 0.24, y: 0.36, width: 0.18, height: 0.14 },
            zone: null,
            pack: "container",
            qty: null,
          },
        ],
        reconciledLocations: [
          {
            detectionId: "detection-unknown-1",
            status: "matched",
            zone: {
              id: "zone-1",
              img: "image-1",
              type: "shelf",
              bbox: { x: 0.1, y: 0.2, width: 0.8, height: 0.3 },
              ord: 0,
              name: "top shelf",
              conf: 0.9,
              partial: false,
            },
            score: 0.83,
            match: {
              detectionId: "detection-unknown-1",
              zoneDetectionId: "zone-1",
              score: 0.83,
              surfaceDistance: 0,
              horizontalOverlapRatio: 1,
            },
          },
        ],
        adjudicationDecisions: [],
        zoneMaps: [
          {
            imageId: "image-1",
            zones: [
              {
                id: "zone-1",
                img: "image-1",
                type: "shelf",
                bbox: { x: 0.1, y: 0.2, width: 0.8, height: 0.3 },
                ord: 0,
                name: "top shelf",
                conf: 0.9,
                partial: false,
              },
            ],
          },
        ],
        groundedPlacements: [
          {
            detectionId: "detection-unknown-1",
            status: "placed",
            supportKind: "zone",
            supportId: "zone-1",
            depth: { back: 0.5, front: 0.75 },
            confidence: 0.83,
          },
        ],
      } as never),
    ).resolves.toMatchObject({
      inventory: {
        items: [
          {
            id: "detection-unknown-1",
            name: "unknown container",
            label: "unknown container",
            pack: "container",
            review: "needs_review",
            loc: {
              observations: [
                {
                  depthBackRatio: 0.5,
                },
              ],
            },
          },
        ],
      },
    });
  });

  it("stores zone-derived depthBackRatio and zone occupancy", async () => {
    await expect(
      reconcileInventory({
        fridgeId: "fridge-1",
        imageIds: ["image-1"],
        rawDetections: [
          {
            id: "detection-1",
            img: "image-1",
            name: "milk carton",
            conf: 0.92,
            bbox: { x: 0.2, y: 0.2, width: 0.1, height: 0.1 },
            zone: null,
            pack: "carton",
            qty: "one carton",
          },
        ],
        reconciledLocations: [
          {
            detectionId: "detection-1",
            status: "matched",
            zone: {
              id: "zone-1",
              img: "image-1",
              type: "shelf",
              bbox: { x: 0.1, y: 0.1, width: 0.4, height: 0.4 },
              ord: 0,
              name: "top shelf",
              conf: 0.9,
              partial: false,
            },
            score: 0.9,
            match: {
              detectionId: "detection-1",
              zoneDetectionId: "zone-1",
              score: 0.8,
              surfaceDistance: 0.2,
              horizontalOverlapRatio: 1,
            },
          },
        ],
        adjudicationDecisions: [],
        zoneMaps: [
          {
            imageId: "image-1",
            zones: [
              {
                id: "zone-1",
                img: "image-1",
                type: "shelf",
                bbox: { x: 0.1, y: 0.1, width: 0.4, height: 0.4 },
                ord: 0,
                name: "top shelf",
                conf: 0.9,
                partial: false,
              },
            ],
          },
        ],
        groundedPlacements: [
          {
            detectionId: "detection-1",
            status: "placed",
            supportKind: "zone",
            supportId: "zone-1",
            depth: { back: 0.5, front: 0.75 },
            confidence: 0.9,
          },
        ],
      } as never),
    ).resolves.toMatchObject({
      inventory: {
        items: [
          {
            id: "detection-1",
            loc: {
              observations: [
                {
                  depthBackRatio: 0.5,
                },
              ],
            },
          },
        ],
        zones: [
          {
            id: "zone-1",
            estimatedOccupiedRatio: expect.any(Number),
          },
        ],
      },
    });
  });

  it("uses the support item depthBackRatio for stacked items", async () => {
    const result = await reconcileInventory({
      fridgeId: "fridge-1",
      imageIds: ["image-1"],
      rawDetections: [
        {
          id: "detection-1",
          img: "image-1",
          name: "leftover container",
          conf: 0.93,
          bbox: { x: 0.2, y: 0.12, width: 0.14, height: 0.08 },
          zone: null,
          pack: "container",
          qty: "one container",
        },
        {
          id: "detection-2",
          img: "image-1",
          name: "yogurt cup",
          conf: 0.91,
          bbox: { x: 0.22, y: 0.32, width: 0.08, height: 0.12 },
          zone: null,
          stack: {
            on: "detection-1",
            conf: 0.82,
            why: "resting on the item below",
          },
          pack: "container",
          qty: "one cup",
        },
      ],
      reconciledLocations: [
        {
          detectionId: "detection-1",
          status: "matched",
          zone: {
            id: "zone-1",
            img: "image-1",
            type: "shelf",
            bbox: { x: 0.1, y: 0.1, width: 0.4, height: 0.4 },
            ord: 0,
            name: "top shelf",
            conf: 0.9,
            partial: false,
          },
          score: 0.9,
          match: {
            detectionId: "detection-1",
            zoneDetectionId: "zone-1",
            score: 0.7,
            surfaceDistance: 0.3,
            horizontalOverlapRatio: 1,
          },
        },
        {
          detectionId: "detection-2",
          status: "matched",
          zone: {
            id: "zone-1",
            img: "image-1",
            type: "shelf",
            bbox: { x: 0.1, y: 0.1, width: 0.4, height: 0.4 },
            ord: 0,
            name: "top shelf",
            conf: 0.9,
            partial: false,
          },
          score: 0.9,
          match: {
            detectionId: "detection-2",
            zoneDetectionId: "zone-1",
            score: 0.7,
            surfaceDistance: 0.3,
            horizontalOverlapRatio: 1,
          },
        },
      ],
      adjudicationDecisions: [],
      zoneMaps: [
        {
          imageId: "image-1",
          zones: [
            {
              id: "zone-1",
              img: "image-1",
              type: "shelf",
              bbox: { x: 0.1, y: 0.1, width: 0.4, height: 0.4 },
              ord: 0,
              name: "top shelf",
              conf: 0.9,
              partial: false,
            },
          ],
        },
      ],
      groundedPlacements: [
        {
          detectionId: "detection-1",
          status: "placed",
          supportKind: "zone",
          supportId: "zone-1",
          depth: { back: 0.25, front: 0.5 },
          confidence: 0.9,
        },
        {
          detectionId: "detection-2",
          status: "placed",
          supportKind: "item",
          supportId: "detection-1",
          depth: { back: 0.7, front: 0.9 },
          confidence: 0.82,
        },
      ],
    } as never);
    const supportItem = result.inventory.items.find((item) => item.id === "detection-1")!;
    const stackedItem = result.inventory.items.find((item) => item.id === "detection-2")!;
    const supportObservation = supportItem.loc.observations[0];
    const stackedObservation = stackedItem.loc.observations[0];

    expect(supportObservation.depthBackRatio).toBeCloseTo(0.25);
    expect(stackedObservation.boundingBox).toEqual({
      x: 0.22,
      y: 0.32,
      width: 0.08,
      height: 0.12,
    });
    expect(stackedObservation.depthBackRatio).toBe(
      supportObservation.depthBackRatio,
    );
  });

  it("derives depthBackRatio from adjudicated zones", async () => {
    await expect(
      reconcileInventory({
        fridgeId: "fridge-1",
        imageIds: ["image-1"],
        rawDetections: [
          {
            id: "detection-1",
            img: "image-1",
            name: "yogurt cup",
            conf: 0.9,
            bbox: { x: 0.2, y: 0.35, width: 0.1, height: 0.05 },
            zone: null,
            pack: "container",
            qty: "one cup",
          },
        ],
        reconciledLocations: [
          {
            detectionId: "detection-1",
            status: "ambiguous",
            candidates: [
              {
                detectionId: "detection-1",
                zoneDetectionId: "zone-2",
                score: 0.5,
                surfaceDistance: 0.1,
                horizontalOverlapRatio: 1,
              },
            ],
            reason: "close candidates",
          },
        ],
        adjudicationDecisions: [
          {
            detectionId: "detection-1",
            selectedZoneDetectionId: "zone-2",
            confidence: 0.72,
            reason: "selected lower shelf",
          },
        ],
        zoneMaps: [
          {
            imageId: "image-1",
            zones: [
              {
                id: "zone-2",
                img: "image-1",
                type: "shelf",
                bbox: { x: 0.1, y: 0.3, width: 0.4, height: 0.4 },
                ord: 1,
                name: "lower shelf",
                conf: 0.9,
                partial: false,
              },
            ],
          },
        ],
        groundedPlacements: [
          {
            detectionId: "detection-1",
            status: "placed",
            supportKind: "zone",
            supportId: "zone-2",
            depth: { back: 0.25, front: 0.5 },
            confidence: 0.72,
          },
        ],
      } as never),
    ).resolves.toMatchObject({
      inventory: {
        items: [
          {
            id: "detection-1",
            loc: {
              status: "matched",
              zoneId: "zone-2",
              observations: [
                {
                  depthBackRatio: 0.25,
                },
              ],
            },
          },
        ],
      },
    });
  });

  it("keeps inventory valid with unmatched items when no storage base is available", async () => {
    await expect(
      reconcileInventoryNode({
        fridgeId: "fridge-1",
        imageIds: ["image-1"],
        rawDetections: [
          {
            id: "detection-1",
            img: "image-1",
            name: "milk carton",
            conf: 0.9,
            bbox: { x: 0.2, y: 0.2, width: 0.1, height: 0.1 },
            zone: null,
            pack: "carton",
            qty: "one carton",
          },
        ],
        reconciledLocations: [],
        adjudicationDecisions: [],
        zoneMaps: [],
        groundedPlacements: [
          {
            detectionId: "detection-1",
            status: "needs_review",
            reason: "No mapped storage zone is available for image image-1",
            confidence: 0,
          },
        ],
      } as never),
    ).resolves.toMatchObject({
      inventory: {
        items: [
          {
            id: "detection-1",
            loc: {
              status: "needs_review",
              zoneId: null,
              zoneType: null,
              observations: [
                {
                  depthBackRatio: null,
                },
              ],
            },
            review: "needs_review",
          },
        ],
        zones: [],
      },
      inventoryValidation: {
        valid: true,
        reason: "Inventory reconciliation completed",
      },
    });
  });

  it("changes zone occupancy when the item depth changes", async () => {
    const inventoryForBox = async (bbox: { x: number; y: number; width: number; height: number }) =>
      reconcileInventory({
        fridgeId: "fridge-1",
        imageIds: ["image-1"],
        rawDetections: [
          {
            id: "detection-1",
            img: "image-1",
            name: "milk carton",
            conf: 0.9,
            bbox,
            zone: null,
            pack: "carton",
            qty: "one carton",
          },
        ],
        reconciledLocations: [
          {
            detectionId: "detection-1",
            status: "matched",
            zone: {
              id: "zone-1",
              img: "image-1",
              type: "shelf",
              bbox: { x: 0.1, y: 0.1, width: 0.4, height: 0.4 },
              ord: 0,
              name: "top shelf",
              conf: 0.9,
              partial: false,
            },
            score: 0.9,
            match: {
              detectionId: "detection-1",
              zoneDetectionId: "zone-1",
              score: Math.max(0, 1 - Math.abs(bbox.y + bbox.height - 0.5)),
              surfaceDistance: Math.abs(bbox.y + bbox.height - 0.5),
              horizontalOverlapRatio: 1,
            },
          },
        ],
        adjudicationDecisions: [],
        zoneMaps: [
          {
            imageId: "image-1",
            zones: [
              {
                id: "zone-1",
                img: "image-1",
                type: "shelf",
                bbox: { x: 0.1, y: 0.1, width: 0.4, height: 0.4 },
                ord: 0,
                name: "top shelf",
                conf: 0.9,
                partial: false,
              },
            ],
          },
        ],
        groundedPlacements: [
          {
            detectionId: "detection-1",
            status: "placed",
            supportKind: "zone",
            supportId: "zone-1",
            depth: bbox.y < 0.2
              ? { back: 0.2, front: 0.4 }
              : { back: 0.6, front: 0.8 },
            confidence: 0.9,
          },
        ],
      } as never);
    const front = await inventoryForBox({ x: 0.2, y: 0.12, width: 0.1, height: 0.08 });
    const back = await inventoryForBox({ x: 0.2, y: 0.3, width: 0.1, height: 0.2 });

    expect(front.inventory.zones[0].estimatedOccupiedRatio).not.toBe(
      back.inventory.zones[0].estimatedOccupiedRatio,
    );
  });

  it("keeps stacked items unmatched when stack locations were not resolved", async () => {
    const detectionForStack = (id: string, on: string) => ({
      id,
      img: "image-1",
      name: "leftover container",
      conf: 0.9,
      bbox: { x: 0.2, y: 0.2, width: 0.1, height: 0.1 },
      zone: null,
      stack: {
        on,
        conf: 0.8,
        why: "appears stacked",
      },
      pack: "container",
      qty: "one container",
    });

    await expect(
      reconcileInventoryNode({
        fridgeId: "fridge-1",
        imageIds: ["image-1"],
        rawDetections: [
          detectionForStack("detection-1", "detection-2"),
          detectionForStack("detection-2", "detection-1"),
        ],
        reconciledLocations: [],
        adjudicationDecisions: [],
        zoneMaps: [],
        groundedPlacements: [
          {
            detectionId: "detection-1",
            status: "needs_review",
            reason: "No mapped storage zone is available for image image-1",
            confidence: 0,
          },
          {
            detectionId: "detection-2",
            status: "needs_review",
            reason: "No mapped storage zone is available for image image-1",
            confidence: 0,
          },
        ],
      } as never),
    ).resolves.toMatchObject({
      inventory: {
        items: [
          {
            id: "detection-1",
            loc: {
              status: "needs_review",
              zoneId: null,
              zoneType: null,
              observations: [
                {
                  depthBackRatio: null,
                },
              ],
            },
          },
          {
            id: "detection-2",
            loc: {
              status: "needs_review",
              zoneId: null,
              zoneType: null,
              observations: [
                {
                  depthBackRatio: null,
                },
              ],
            },
          },
        ],
      },
      inventoryValidation: {
        valid: true,
        reason: "Inventory reconciliation completed",
      },
    });
  });

  it("routes failed inventory reconciliation to scan_failed", () => {
    expect(
      routeAfterInventoryReconciliation({
        inventoryValidation: { valid: false, reason: "cycle" },
      } as never),
    ).toBe("scan_failed");
    expect(
      routeAfterInventoryReconciliation({
        inventoryValidation: { valid: true, reason: "completed" },
      } as never),
    ).toBe("finalize_scan");
  });

  it("keeps zone ids while assigning human-readable labels", async () => {
    await expect(
      reconcileInventory({
        fridgeId: "fridge-1",
        imageIds: ["image-1"],
        rawDetections: [],
        reconciledLocations: [],
        adjudicationDecisions: [],
        zoneMaps: [
          {
            imageId: "image-1",
            zones: [
              {
                id: "zone_0",
                img: "image-1",
                type: "shelf",
                bbox: { x: 0.1, y: 0.12, width: 0.8, height: 0.12 },
                ord: 0,
                name: "model label",
                conf: 0.9,
                partial: false,
              },
              {
                id: "zone_1",
                img: "image-1",
                type: "shelf",
                bbox: { x: 0.1, y: 0.42, width: 0.8, height: 0.12 },
                ord: 1,
                name: "model label",
                conf: 0.9,
                partial: false,
              },
              {
                id: "zone_2",
                img: "image-1",
                type: "drawer",
                bbox: { x: 0.08, y: 0.76, width: 0.38, height: 0.18 },
                ord: 0,
                name: "model label",
                conf: 0.9,
                partial: false,
              },
              {
                id: "zone_3",
                img: "image-1",
                type: "drawer",
                bbox: { x: 0.54, y: 0.76, width: 0.38, height: 0.18 },
                ord: 1,
                name: "model label",
                conf: 0.9,
                partial: false,
              },
            ],
          },
        ],
      } as never),
    ).resolves.toMatchObject({
      inventory: {
        zones: [
          {
            id: "zone_0",
            label: "top shelf",
          },
          { id: "zone_1", label: "bottom shelf" },
          { id: "zone_2", label: "bottom left drawer" },
          { id: "zone_3", label: "bottom right drawer" },
        ],
      },
    });
  });
});
