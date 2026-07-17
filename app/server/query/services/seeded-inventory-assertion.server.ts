import {
  getFridgeInventoryForImage,
  saveFridgeInventory,
} from "../../inventories.server";
import { getFridgeImage } from "../../images.server";
import type { Inventory } from "../../scan/schemas/inventory";
import type { ConversationContextSeededItem } from "../../../workspace/contracts";
import { parseInventoryCropId } from "./focused-visual-context.server";

export type SeededInventoryAssertion = {
  cropId: string;
  label: string;
};

export type AppliedSeededInventoryAssertion = SeededInventoryAssertion & {
  itemId: string;
};

function inventoryImageIdFor(imageId: string) {
  if (getFridgeInventoryForImage(imageId)) {
    return imageId;
  }

  const baseImageId = getFridgeImage(imageId)?.baseImageId ?? null;

  if (baseImageId && getFridgeInventoryForImage(baseImageId)) {
    return baseImageId;
  }

  throw new Error(
    `Cannot apply selected inventory assertion because inventory for image ${imageId} was not found`,
  );
}

function assertedItemName(label: string) {
  return label.trim().toLocaleLowerCase();
}

function updateInventoryLabel(input: {
  inventory: Inventory;
  assertions: AppliedSeededInventoryAssertion[];
}) {
  const assertionsByItemId = new Map(
    input.assertions.map((assertion) => [assertion.itemId, assertion]),
  );

  return {
    ...input.inventory,
    items: input.inventory.items.map((item) => {
      const assertion = assertionsByItemId.get(item.id);

      if (!assertion) {
        return item;
      }

      return {
        ...item,
        name: assertedItemName(assertion.label),
        label: assertion.label,
        src: [...new Set([...item.src, "user-asserted-label"])],
        review: "confirmed" as const,
      };
    }),
  };
}

function inventoryHasAssertions(input: {
  inventory: Inventory;
  assertions: AppliedSeededInventoryAssertion[];
}) {
  return input.assertions.every((assertion) => {
    const item = input.inventory.items.find((candidate) => candidate.id === assertion.itemId);

    return item?.label === assertion.label &&
      item.name === assertedItemName(assertion.label) &&
      item.review === "confirmed" &&
      item.src.includes("user-asserted-label");
  });
}

export function applySeededInventoryAssertions(input: {
  seededItems: ConversationContextSeededItem[];
  assertions: SeededInventoryAssertion[];
}) {
  const seededItemsByCropId = new Map(
    input.seededItems.map((item) => [item.cropId, item]),
  );
  const assertions = input.assertions.flatMap((assertion) => {
    const seededItem = seededItemsByCropId.get(assertion.cropId);

    if (!seededItem) {
      return [];
    }

    const crop = parseInventoryCropId(seededItem.cropId);

    if (
      crop.imageId !== seededItem.imageId ||
      crop.itemId !== seededItem.itemId
    ) {
      throw new Error(
        `Cannot apply selected inventory assertion because crop ${seededItem.cropId} does not match its selected item context`,
      );
    }

    return [{
      cropId: seededItem.cropId,
      label: assertion.label.trim(),
      itemId: seededItem.itemId,
      imageId: seededItem.imageId,
      observationIndex: crop.observationIndex,
    }];
  });
  const assertionsByInventoryImageId = new Map<string, typeof assertions>();

  for (const assertion of assertions) {
    const inventoryImageId = inventoryImageIdFor(assertion.imageId);
    const existing = assertionsByInventoryImageId.get(inventoryImageId) ?? [];
    assertionsByInventoryImageId.set(inventoryImageId, [...existing, assertion]);
  }

  const applied: AppliedSeededInventoryAssertion[] = [];

  for (const [imageId, inventoryAssertions] of assertionsByInventoryImageId) {
    const inventory = getFridgeInventoryForImage(imageId);

    if (!inventory) {
      throw new Error(
        `Cannot apply selected inventory assertion because inventory for image ${imageId} was not found`,
      );
    }

    for (const assertion of inventoryAssertions) {
      const item = inventory.items.find((candidate) => candidate.id === assertion.itemId);
      const observation = item?.loc.observations[assertion.observationIndex];

      if (!item || !observation || observation.imageId !== assertion.imageId) {
        throw new Error(
          `Cannot apply selected inventory assertion because crop ${assertion.cropId} no longer resolves to its inventory item`,
        );
      }

      applied.push({
        cropId: assertion.cropId,
        itemId: assertion.itemId,
        label: assertion.label,
      });
    }

    const appliedAssertions = inventoryAssertions.map(({ cropId, itemId, label }) => ({
      cropId,
      itemId,
      label,
    }));

    if (!inventoryHasAssertions({ inventory, assertions: appliedAssertions })) {
      saveFridgeInventory({
        imageId,
        inventory: updateInventoryLabel({
          inventory,
          assertions: appliedAssertions,
        }),
      });
    }
  }

  return applied;
}
