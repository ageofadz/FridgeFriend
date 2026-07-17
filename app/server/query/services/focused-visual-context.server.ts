import { decode as decodeJpeg, encode as encodeJpeg } from "jpeg-js";

import { getFridgeImage } from "../../images.server";
import { getFridgeInventoryForImage } from "../../inventories.server";
import type { NormalizedBoundingBox } from "../../scan/schemas/inventory";
import {
  inventorySeedCropId,
  type ConversationContext,
  type ConversationContextSeededItem,
} from "../../../workspace/contracts";
import type { summarizeInventory } from "./inventory-context.server";

const JPEG_DATA_URL_PREFIX = "data:image/jpeg;base64,";
const CROP_PADDING_RATIO = 0.06;

type InventorySummary = ReturnType<typeof summarizeInventory>;
type InventorySummaryItem = InventorySummary["items"][number];

export type FocusedVisualCrop = {
  cropId: string;
  itemId: string;
  displayName: string;
  imageId: string;
  boundingBox: NormalizedBoundingBox;
  dataUrl: string;
};

type FocusedVisualCropMetadata = Omit<FocusedVisualCrop, "dataUrl">;

export class InventoryCropError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "InventoryCropError";
    this.status = status;
  }
}

type LoadedJpeg = {
  data: Uint8Array;
  width: number;
  height: number;
};

function loadImageDataUrl(
  imageId: string,
  loader?: (imageId: string) => string | null | Promise<string | null>,
) {
  if (loader) {
    return loader(imageId);
  }

  const image = getFridgeImage(imageId);

  return image?.dataUrl ?? null;
}

function decodeJpegDataUrl(dataUrl: string, imageId: string): LoadedJpeg {
  if (!dataUrl.startsWith(JPEG_DATA_URL_PREFIX)) {
    throw new Error(
      `Focused visual crop source image ${imageId} must be a JPEG data URL`,
    );
  }

  const bytes = Buffer.from(dataUrl.slice(JPEG_DATA_URL_PREFIX.length), "base64");

  try {
    return decodeJpeg(bytes, { useTArray: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Focused visual crop source image ${imageId} is not loadable JPEG data: ${message}`,
    );
  }
}

function cropBounds(box: NormalizedBoundingBox, image: LoadedJpeg) {
  const leftRatio = Math.max(0, box.x - CROP_PADDING_RATIO);
  const topRatio = Math.max(0, box.y - CROP_PADDING_RATIO);
  const rightRatio = Math.min(1, box.x + box.width + CROP_PADDING_RATIO);
  const bottomRatio = Math.min(1, box.y + box.height + CROP_PADDING_RATIO);
  const left = Math.floor(leftRatio * image.width);
  const top = Math.floor(topRatio * image.height);
  const right = Math.ceil(rightRatio * image.width);
  const bottom = Math.ceil(bottomRatio * image.height);
  const width = right - left;
  const height = bottom - top;

  if (width <= 0 || height <= 0) {
    throw new Error(
      `Focused visual crop has invalid pixel bounds: left=${left}, top=${top}, right=${right}, bottom=${bottom}`,
    );
  }

  return {
    left,
    top,
    width,
    height,
  };
}

function cropJpegDataUrl(
  source: LoadedJpeg,
  box: NormalizedBoundingBox,
) {
  const bounds = cropBounds(box, source);
  const cropData = Buffer.alloc(bounds.width * bounds.height * 4);

  for (let y = 0; y < bounds.height; y += 1) {
    const sourceStart = ((bounds.top + y) * source.width + bounds.left) * 4;
    const sourceEnd = sourceStart + bounds.width * 4;
    const targetStart = y * bounds.width * 4;

    cropData.set(source.data.slice(sourceStart, sourceEnd), targetStart);
  }

  const jpeg = encodeJpeg(
    {
      data: cropData,
      width: bounds.width,
      height: bounds.height,
    },
    90,
  );

  return `${JPEG_DATA_URL_PREFIX}${Buffer.from(jpeg.data).toString("base64")}`;
}

function itemObservationsForImage(item: InventorySummaryItem, imageId: string) {
  return item.location.observations
    .map((observation, observationIndex) => ({ observation, observationIndex }))
    .filter(({ observation }) => observation.imageId === imageId);
}

function getInventoryForCropImage(imageId: string) {
  const directInventory = getFridgeInventoryForImage(imageId);

  if (directInventory) {
    return directInventory;
  }

  const image = getFridgeImage(imageId);
  const baseImageId = image?.baseImageId ?? null;

  return baseImageId ? getFridgeInventoryForImage(baseImageId) : null;
}

function inventoryCropId(input: {
  imageId: string;
  itemId: string;
  observationIndex: number;
}) {
  return inventorySeedCropId(input);
}

export function parseInventoryCropId(cropId: string) {
  const parts = cropId.split(":");

  if (parts.length !== 3 || parts.some((part) => part.trim().length === 0)) {
    throw new InventoryCropError(
      `Inventory crop id is malformed: ${cropId}`,
      400,
    );
  }

  const [imageId, itemId, observationIndexText] = parts;
  const observationIndex = Number(observationIndexText);

  if (!Number.isInteger(observationIndex) || observationIndex < 0) {
    throw new InventoryCropError(
      `Inventory crop id has invalid observation index: ${cropId}`,
      400,
    );
  }

  return {
    imageId,
    itemId,
    observationIndex,
  };
}

export async function resolveInventoryCropDataUrl(input: {
  cropId: string;
  loadImageDataUrlForQuery?: (
    imageId: string,
  ) => string | null | Promise<string | null>;
}) {
  const parsed = parseInventoryCropId(input.cropId);
  const inventory = getInventoryForCropImage(parsed.imageId);

  if (!inventory) {
    throw new InventoryCropError(
      `Inventory crop ${input.cropId} could not be resolved because inventory was not found for image ${parsed.imageId}`,
      404,
    );
  }

  const item = inventory.items.find((candidate) =>
    candidate.id === parsed.itemId &&
    candidate.loc.observations[parsed.observationIndex]?.imageId === parsed.imageId
  );

  if (!item) {
    throw new InventoryCropError(
      `Inventory crop ${input.cropId} could not be resolved because item ${parsed.itemId} with observation ${parsed.observationIndex} was not found in image ${parsed.imageId}`,
      404,
    );
  }

  const observation = item.loc.observations[parsed.observationIndex];

  if (!observation) {
    throw new InventoryCropError(
      `Inventory crop ${input.cropId} could not be resolved because observation ${parsed.observationIndex} was not found for item ${parsed.itemId}`,
      404,
    );
  }

  if (observation.imageId !== parsed.imageId) {
    throw new InventoryCropError(
      `Inventory crop ${input.cropId} points to image ${parsed.imageId}, but observation ${parsed.observationIndex} belongs to image ${observation.imageId}`,
      404,
    );
  }

  const dataUrl = await loadImageDataUrl(
    parsed.imageId,
    input.loadImageDataUrlForQuery,
  );

  if (!dataUrl) {
    throw new InventoryCropError(
      `Inventory crop ${input.cropId} source image was not found: ${parsed.imageId}`,
      404,
    );
  }

  const source = decodeJpegDataUrl(dataUrl, parsed.imageId);

  return cropJpegDataUrl(source, observation.boundingBox);
}

export async function cropImageBoundingBoxDataUrl(input: {
  imageId: string;
  boundingBox: NormalizedBoundingBox;
  loadImageDataUrlForQuery?: (
    imageId: string,
  ) => string | null | Promise<string | null>;
}) {
  const dataUrl = await loadImageDataUrl(
    input.imageId,
    input.loadImageDataUrlForQuery,
  );

  if (!dataUrl) {
    throw new Error(
      `Focused visual crop source image not found in SQLite store: ${input.imageId}`,
    );
  }

  const source = decodeJpegDataUrl(dataUrl, input.imageId);

  return cropJpegDataUrl(source, input.boundingBox);
}

export function jpegDataUrlToBytes(dataUrl: string, cropId: string) {
  if (!dataUrl.startsWith(JPEG_DATA_URL_PREFIX)) {
    throw new InventoryCropError(
      `Inventory crop ${cropId} did not resolve to a JPEG data URL`,
      500,
    );
  }

  return Buffer.from(dataUrl.slice(JPEG_DATA_URL_PREFIX.length), "base64");
}

export async function buildFocusedVisualCrops(input: {
  imageId: string | null;
  inventory: InventorySummary | null;
  itemIds?: string[];
  seededItems?: ConversationContextSeededItem[];
  seededBoundingBoxes?: ConversationContext["seededBoundingBoxes"];
  loadImageDataUrlForQuery?: (
    imageId: string,
  ) => string | null | Promise<string | null>;
}) {
  const seededBoundingBoxes = input.seededBoundingBoxes ?? [];

  if (!input.inventory && seededBoundingBoxes.length === 0) {
    return [];
  }

  const itemIds = input.itemIds ? new Set(input.itemIds) : null;
  const seededItems = input.seededItems ?? [];
  const seededCropRequests = seededItems.flatMap((seed) => {
      if (!input.inventory) {
        throw new Error(
          `Focused visual crop ${seed.cropId} could not be resolved because inventory was not loaded`,
        );
      }
      const parsedCrop = parseInventoryCropId(seed.cropId);
      const item = input.inventory.items.find((candidate) =>
        candidate.id === seed.itemId
      );
      const observation = item?.location.observations[parsedCrop.observationIndex];

      if (
        !item ||
        !observation ||
        observation.imageId !== seed.imageId ||
        parsedCrop.imageId !== seed.imageId ||
        parsedCrop.itemId !== seed.itemId
      ) {
        throw new Error(
          `Focused visual crop ${seed.cropId} could not be resolved from seeded chat context`,
        );
      }

      return [{
        item,
        observation,
        observationIndex: parsedCrop.observationIndex,
      }];
    });
  const seededCropKeys = new Set(
    seededCropRequests.map(({ item, observationIndex }) =>
      `${item.id}:${observationIndex}`
    ),
  );
  const regularCropRequests = input.imageId
    ? (input.inventory?.items ?? [])
      .filter((item) => !itemIds || itemIds.has(item.id))
      .flatMap((item) =>
        itemObservationsForImage(item, input.imageId as string).map(({ observation, observationIndex }) => ({
          item,
          observation,
          observationIndex,
        }))
      )
      .filter(({ item, observationIndex }) =>
        !seededCropKeys.has(`${item.id}:${observationIndex}`)
      )
    : [];
  const cropRequests = [...seededCropRequests, ...regularCropRequests];

  if (cropRequests.length === 0 && seededBoundingBoxes.length === 0) {
    return [];
  }

  const sources = new Map<string, LoadedJpeg>();

  async function sourceForImage(imageId: string) {
    const cached = sources.get(imageId);

    if (cached) {
      return cached;
    }

    const dataUrl = await loadImageDataUrl(
      imageId,
      input.loadImageDataUrlForQuery,
    );

    if (!dataUrl) {
      throw new Error(
        `Focused visual crop source image not found in SQLite store: ${imageId}`,
      );
    }

    const source = decodeJpegDataUrl(dataUrl, imageId);
    sources.set(imageId, source);
    return source;
  }

  const itemCrops = cropRequests.map(async ({ item, observation, observationIndex }): Promise<FocusedVisualCrop> => ({
      cropId: inventoryCropId({
        imageId: observation.imageId,
        itemId: item.id,
        observationIndex,
      }),
      itemId: item.id,
      displayName: item.displayName,
      imageId: observation.imageId,
      boundingBox: observation.boundingBox,
      dataUrl: cropJpegDataUrl(
        await sourceForImage(observation.imageId),
        observation.boundingBox,
      ),
    }));
  const boxCrops = seededBoundingBoxes.map(async (box, index): Promise<FocusedVisualCrop> => ({
    cropId: box.cropId,
    itemId: box.cropId,
    displayName: `selected area ${index + 1}`,
    imageId: box.imageId,
    boundingBox: box.boundingBox,
    dataUrl: cropJpegDataUrl(
      await sourceForImage(box.imageId),
      box.boundingBox,
    ),
  }));

  return Promise.all(
    [...boxCrops, ...itemCrops],
  );
}

export function focusedVisualCropMetadata(
  crops: FocusedVisualCrop[],
): FocusedVisualCropMetadata[] {
  return crops.map(({ dataUrl: _dataUrl, ...crop }) => crop);
}
