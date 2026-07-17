import { randomUUID } from "node:crypto";
import { z } from "zod";

import { getFridgeImage } from "../../images.server";
import {
  CHAT_VISION_PROVIDER as CHAT_PROVIDER,
  CHAT_VISION_MODEL as VISION_MODEL,
} from "../../ai/chat-model.server";
import {
  getFridgeInventoryForImage,
  saveFridgeInventory,
} from "../../inventories.server";
import { categorizeInventoryForRecipes } from "../../recipes/inventory-generalization";
import {
  BoundingBox,
  type Inventory,
  type InventoryItem,
  type NormalizedBoundingBox,
} from "../../scan/schemas/inventory";
import { createVisionModel } from "../../scan/services/vision-model.server";
import { promptMessages } from "../../scan/services/prompt-messages.server";
import { loadPromptBundle } from "../../prompts/registry.server";
import { inventorySeedCropId } from "../../../workspace/contracts";
import { cropImageBoundingBoxDataUrl } from "./focused-visual-context.server";

const BOX_MATCH_THRESHOLD = 0.3;

const SeededBoxIdentificationSchema = z.object({
  label: z.string().min(1),
  name: z.string().min(1),
  confidence: z.number().min(0).max(1),
  category: z.enum([
    "produce",
    "dairy",
    "meat",
    "seafood",
    "eggs",
    "prepared_food",
    "beverage",
    "condiment",
    "leftovers",
    "other",
  ]),
  subcategory: z.string().nullable(),
  packaging: z.enum([
    "loose",
    "bottle",
    "jar",
    "can",
    "carton",
    "bag",
    "box",
    "tray",
    "container",
    "unknown",
  ]),
  quantity: z.object({
    amount: z.number().nonnegative().nullable(),
    unit: z.enum([
      "count",
      "g",
      "kg",
      "oz",
      "lb",
      "ml",
      "l",
      "package",
      "container",
      "unknown",
    ]),
    precision: z.enum(["exact", "estimated", "unknown"]),
    fillLevel: z.number().min(0).max(1).nullable(),
  }),
  attributes: z.object({
    brand: z.string().nullable(),
    variant: z.string().nullable(),
    opened: z.boolean().nullable(),
    expirationDate: z.string().nullable(),
  }),
  visualSummary: z.string().min(1),
});

type SeededBoxIdentification = z.infer<typeof SeededBoxIdentificationSchema>;

type SeededBoundingBoxResult = {
  status: "known_item" | "created_item";
  cropId: string;
  item: InventoryItem;
  inventory: Inventory;
  draftText: string;
};

type IdentifySeededBox = (input: {
  imageId: string;
  boundingBox: NormalizedBoundingBox;
  cropDataUrl: string;
}) => Promise<SeededBoxIdentification>;

function baseInventoryImageId(imageId: string) {
  const directInventory = getFridgeInventoryForImage(imageId);

  if (directInventory) {
    return imageId;
  }

  const image = getFridgeImage(imageId);
  const baseImageId = image?.baseImageId ?? null;

  if (baseImageId && getFridgeInventoryForImage(baseImageId)) {
    return baseImageId;
  }

  throw new Error(
    `Cannot seed bounding box because inventory for image ${imageId} was not found`,
  );
}

function area(box: NormalizedBoundingBox) {
  return box.width * box.height;
}

function intersectionArea(
  left: NormalizedBoundingBox,
  right: NormalizedBoundingBox,
) {
  const x = Math.max(
    0,
    Math.min(left.x + left.width, right.x + right.width) -
    Math.max(left.x, right.x),
  );
  const y = Math.max(
    0,
    Math.min(left.y + left.height, right.y + right.height) -
    Math.max(left.y, right.y),
  );

  return x * y;
}

function boxMatchScore(
  left: NormalizedBoundingBox,
  right: NormalizedBoundingBox,
) {
  const intersection = intersectionArea(left, right);
  const union = area(left) + area(right) - intersection;
  const selectedContainment = intersection / Math.max(area(left), Number.EPSILON);
  const itemContainment = intersection / Math.max(area(right), Number.EPSILON);
  const iou = union > 0 ? intersection / union : 0;

  return Math.max(iou, selectedContainment, itemContainment);
}

function findKnownItem(input: {
  inventory: Inventory;
  imageId: string;
  boundingBox: NormalizedBoundingBox;
}) {
  return input.inventory.items
    .flatMap((item) =>
      item.loc.observations
        .map((observation, observationIndex) => ({
          item,
          observation,
          observationIndex,
          score: observation.imageId === input.imageId
            ? boxMatchScore(input.boundingBox, observation.boundingBox)
            : 0,
        }))
    )
    .filter((candidate) => candidate.score >= BOX_MATCH_THRESHOLD)
    .sort((left, right) => right.score - left.score)[0] ?? null;
}

function sameBox(
  left: NormalizedBoundingBox,
  right: NormalizedBoundingBox,
) {
  const epsilon = 0.00001;

  return Math.abs(left.x - right.x) < epsilon &&
    Math.abs(left.y - right.y) < epsilon &&
    Math.abs(left.width - right.width) < epsilon &&
    Math.abs(left.height - right.height) < epsilon;
}

function zoneForBox(
  inventory: Inventory,
  imageId: string,
  boundingBox: NormalizedBoundingBox,
) {
  const centerX = boundingBox.x + boundingBox.width / 2;
  const centerY = boundingBox.y + boundingBox.height / 2;

  return inventory.zones
    .filter((zone) => zone.imageIds.includes(imageId))
    .map((zone) => {
      const centerContained =
        centerX >= zone.boundingBox.x &&
        centerX <= zone.boundingBox.x + zone.boundingBox.width &&
        centerY >= zone.boundingBox.y &&
        centerY <= zone.boundingBox.y + zone.boundingBox.height;
      return {
        zone,
        score: centerContained
          ? 1 + boxMatchScore(boundingBox, zone.boundingBox)
          : boxMatchScore(boundingBox, zone.boundingBox),
      };
    })
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score)[0]?.zone ?? null;
}

function depthBackRatioForBoxInZone(
  boundingBox: NormalizedBoundingBox,
  zone: Inventory["zones"][number],
) {
  return Math.min(
    1,
    Math.max(
      0,
      (boundingBox.y + boundingBox.height - zone.boundingBox.y) /
      zone.boundingBox.height,
    ),
  );
}

async function identifySeededBoxWithVision(input: {
  imageId: string;
  boundingBox: NormalizedBoundingBox;
  cropDataUrl: string;
}) {
  const model = createVisionModel();
  const loadedPrompt = (await loadPromptBundle()).seededBoundingBoxIdentification;
  const structuredModel = model.withStructuredOutput<SeededBoxIdentification>(
    SeededBoxIdentificationSchema,
    {
      name: "SeededBoundingBoxInventoryItem",
    },
  );
  const response = await structuredModel.invoke(
    await promptMessages(loadedPrompt, {
      seeded_bounding_box_context_json: JSON.stringify({ imageId: input.imageId, boundingBox: input.boundingBox }),
      image_data_url: input.cropDataUrl,
    }),
    {
      tags: ["query", "seed_bounding_box"],
      metadata: {
        imageId: input.imageId,
        provider: CHAT_PROVIDER,
        model: VISION_MODEL,
        langsmithPromptName: loadedPrompt.name,
        langsmithPromptRef: loadedPrompt.ref,
      },
    },
  );

  return SeededBoxIdentificationSchema.parse(response);
}

function createKnownItemInventory(input: {
  inventory: Inventory;
  itemId: string;
  imageId: string;
  boundingBox: NormalizedBoundingBox;
}) {
  let observationIndex = -1;
  const zone = zoneForBox(input.inventory, input.imageId, input.boundingBox);
  const inventory: Inventory = {
    ...input.inventory,
    items: input.inventory.items.map((item) => {
      if (item.id !== input.itemId) {
        return item;
      }

      const existingIndex = item.loc.observations.findIndex((observation) =>
        observation.imageId === input.imageId &&
        sameBox(observation.boundingBox, input.boundingBox)
      );

      if (existingIndex >= 0) {
        observationIndex = existingIndex;
        return item;
      }

      observationIndex = item.loc.observations.length;
      return {
        ...item,
        loc: {
          ...item.loc,
          observations: [
            ...item.loc.observations,
            {
              imageId: input.imageId,
              depthBackRatio: zone
                ? depthBackRatioForBoxInZone(input.boundingBox, zone)
                : null,
              boundingBox: input.boundingBox,
            },
          ],
        },
      };
    }),
  };

  if (observationIndex < 0) {
    throw new Error(
      `Cannot seed bounding box because matched item ${input.itemId} was not found while updating inventory`,
    );
  }

  return {
    inventory,
    observationIndex,
  };
}

function createSeededInventoryItem(input: {
  imageId: string;
  inventory: Inventory;
  boundingBox: NormalizedBoundingBox;
  identification: SeededBoxIdentification;
}) {
  const recipeCategory = categorizeInventoryForRecipes({
    label: input.identification.label,
    packaging: input.identification.packaging,
  });
  const zone = zoneForBox(input.inventory, input.imageId, input.boundingBox);
  const depthBackRatio = zone
    ? depthBackRatioForBoxInZone(input.boundingBox, zone)
    : null;
  const item: InventoryItem = {
    id: `user-box-${randomUUID()}`,
    name: input.identification.name.trim().toLowerCase(),
    label: input.identification.label.trim(),
    cat: input.identification.category,
    subcat: input.identification.subcategory ?? recipeCategory.recipeIngredient,
    qty: input.identification.quantity,
    pack: input.identification.packaging,
    loc: {
      status: zone ? "matched" : "unmatched",
      zoneId: zone?.id ?? null,
      zoneType: zone?.type ?? null,
      observations: [
        {
          imageId: input.imageId,
          depthBackRatio,
          boundingBox: input.boundingBox,
        },
      ],
      confidence: zone ? input.identification.confidence : null,
    },
    conf: input.identification.confidence,
    src: ["user-selected-bounding-box"],
    attrs: input.identification.attributes,
    visual: [
      {
        query: "User-selected bounding box identification",
        response: input.identification.visualSummary,
        imageId: input.imageId,
        boundingBox: input.boundingBox,
        observedAt: new Date().toISOString(),
      },
    ],
    review: "needs_review",
  };

  return item;
}

export async function seedInventoryBoundingBox(input: {
  imageId: string;
  boundingBox: NormalizedBoundingBox;
  identifySeededBox?: IdentifySeededBox;
}): Promise<SeededBoundingBoxResult> {
  const image = getFridgeImage(input.imageId);

  if (!image) {
    throw new Error(
      `Cannot seed bounding box because image ${input.imageId} was not found`,
    );
  }

  const boundingBox = BoundingBox.parse(input.boundingBox);
  const inventoryImageId = baseInventoryImageId(input.imageId);
  const inventory = getFridgeInventoryForImage(inventoryImageId);

  if (!inventory) {
    throw new Error(
      `Cannot seed bounding box because inventory for image ${inventoryImageId} was not found`,
    );
  }

  const knownItem = findKnownItem({
    inventory,
    imageId: input.imageId,
    boundingBox,
  });

  if (knownItem) {
    const updated = createKnownItemInventory({
      inventory,
      itemId: knownItem.item.id,
      imageId: input.imageId,
      boundingBox,
    });
    const savedInventory = saveFridgeInventory({
      imageId: inventoryImageId,
      inventory: updated.inventory,
    });
    const item = savedInventory.items.find((candidate) =>
      candidate.id === knownItem.item.id
    );

    if (!item) {
      throw new Error(
        `Cannot seed bounding box because known item ${knownItem.item.id} was not found after saving inventory`,
      );
    }

    return {
      status: "known_item",
      cropId: inventorySeedCropId({
        imageId: input.imageId,
        itemId: item.id,
        observationIndex: updated.observationIndex,
      }),
      item,
      inventory: savedInventory,
      draftText: '',
    };
  }

  const cropDataUrl = await cropImageBoundingBoxDataUrl({
    imageId: input.imageId,
    boundingBox,
  });
  const identification = await (input.identifySeededBox ??
    identifySeededBoxWithVision)({
      imageId: input.imageId,
      boundingBox,
      cropDataUrl,
    });
  const item = createSeededInventoryItem({
    imageId: input.imageId,
    inventory,
    boundingBox,
    identification,
  });
  const savedInventory = saveFridgeInventory({
    imageId: inventoryImageId,
    inventory: {
      ...inventory,
      items: [...inventory.items, item],
    },
  });

  return {
    status: "created_item",
    cropId: inventorySeedCropId({
      imageId: input.imageId,
      itemId: item.id,
      observationIndex: 0,
    }),
    item,
    inventory: savedInventory,
    draftText: `Inspect this selected ${item.label} crop and tell me what details should be added to the inventory.`,
  };
}
