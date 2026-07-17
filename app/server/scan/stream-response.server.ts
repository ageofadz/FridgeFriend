import {
  coerceInventoryStorageLocation,
  getFridgeInventoryForImage,
  mergeStorageInventory,
  saveFridgeInventory,
} from "../inventories.server";
import {
  deleteFridgeImage,
  type FridgeImage,
  type StorageImageLocation,
} from "../images.server";
import type { ScanStreamEvent } from "../../workspace/scan-events";
import {
  persistScanForFridgeImageInBackground,
  streamScanForStorageImage,
} from "./index.server";
import type { ScanStateValue } from "./state";

type ScanStreamResponseInput = {
  fridgeId: string;
  image: FridgeImage;
  storageLocation: StorageImageLocation;
  baseImageId: string | null;
};

function encodeStreamEvent(event: ScanStreamEvent) {
  return `${JSON.stringify(event)}\n`;
}

async function* storageImageScanEvents(
  input: ScanStreamResponseInput,
): AsyncGenerator<ScanStreamEvent> {
  yield {
    type: "image_created",
    image: {
      id: input.image.id,
      originalName: input.image.originalName,
      storageLocation: input.storageLocation,
      baseImageId: input.image.baseImageId,
      createdAt: input.image.createdAt,
    },
  };

  const stream = streamScanForStorageImage({
    fridgeId: input.fridgeId,
    imageId: input.image.id,
    storageLocation: input.storageLocation,
  });

  let scanState: ScanStateValue | null = null;

  try {
    while (true) {
      const result = await stream.next();

      if (result.done) {
        scanState = result.value;
        break;
      }

      if (result.value.type === "invalid_storage_image") {
        deleteFridgeImage(input.image.id);
        yield result.value;
        return;
      }

      if (result.value.type === "error") {
        yield result.value;
        return;
      }

      yield result.value;
    }

    if (!scanState?.inventory) {
      yield {
        type: "error",
        error: scanState?.error?.message ?? "Scan ended without reconciled inventory",
      };
      return;
    }

    const scannedInventory = coerceInventoryStorageLocation(
      scanState.inventory,
      input.storageLocation,
    );
    const inventory = input.storageLocation === "fridge"
      ? saveFridgeInventory({
        imageId: input.image.id,
        inventory: scannedInventory,
      })
      : saveFridgeInventory({
        imageId: input.baseImageId as string,
        inventory: mergeStorageInventory(
          (() => {
            const baseInventory = getFridgeInventoryForImage(input.baseImageId as string);

            if (!baseInventory) {
              throw new Error(`Cannot extend ${input.storageLocation} inventory because inventory for selected fridge image ${input.baseImageId as string} was not found`);
            }

            return baseInventory;
          })(),
          scannedInventory,
          input.storageLocation,
        ),
      });

    if (input.storageLocation === "fridge") {
      persistScanForFridgeImageInBackground({
        fridgeId: input.fridgeId,
        imageId: input.image.id,
        storageLocation: input.storageLocation,
        scanState: {
          ...scanState,
          inventory,
        },
      });
    }

    yield {
      type: "complete",
      imageId: input.storageLocation === "fridge"
        ? input.image.id
        : input.baseImageId as string,
      inventory,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    yield {
      type: "error",
      error: `Storage image scan failed: ${message}`,
    };
  }
}

export function createScanStreamResponse(input: ScanStreamResponseInput) {
  const encoder = new TextEncoder();

  return new Response(
    new ReadableStream({
      async start(controller) {
        try {
          for await (const event of storageImageScanEvents(input)) {
            controller.enqueue(encoder.encode(encodeStreamEvent(event)));
          }
        } finally {
          controller.close();
        }
      },
    }),
    {
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-cache",
      },
    },
  );
}
