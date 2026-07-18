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
  status: "created_item";
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
          ? 1 + boxOverlapScore(boundingBox, zone.boundingBox)
          : boxOverlapScore(boundingBox, zone.boundingBox),
      };
    })
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score)[0]?.zone ?? null;
}

function boxOverlapScore(
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
  const intersection = x * y;
  const leftArea = left.width * left.height;
  const rightArea = right.width * right.height;
  const union = leftArea + rightArea - intersection;
  const leftContainment = intersection / Math.max(leftArea, Number.EPSILON);
  const rightContainment = intersection / Math.max(rightArea, Number.EPSILON);

  return Math.max(union > 0 ? intersection / union : 0, leftContainment, rightContainment);
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
