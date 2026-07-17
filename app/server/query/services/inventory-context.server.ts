import { getFridgeInventoryForImage } from "../../inventories.server";
import type { Inventory } from "../../scan/schemas/inventory";
import type { ConversationContextSeededItem } from "../../../workspace/contracts";
import type { QueryGraphDependencies } from "../schemas/query";
import type { FridgeQueryStateValue } from "../state";
import { conversationContextFromState } from "./conversation-context.server";

function seededItemsFromState(state?: FridgeQueryStateValue) {
  return state ? conversationContextFromState(state).seededItems : [];
}

function seedMatchesItem(
  item: Inventory["items"][number],
  seed: ConversationContextSeededItem,
) {
  return item.id === seed.itemId &&
    item.loc.observations.some((observation) => observation.imageId === seed.imageId);
}

function orderInventoryItems(
  items: Inventory["items"],
  seededItems: ConversationContextSeededItem[],
) {
  if (seededItems.length === 0) {
    return items.map((item) => ({ item, userSeeded: false }));
  }

  return items
    .map((item, originalIndex) => ({
      item,
      originalIndex,
      seededIndex: seededItems.findIndex((seed) => seedMatchesItem(item, seed)),
    }))
    .sort((left, right) => {
      const leftSeeded = left.seededIndex >= 0;
      const rightSeeded = right.seededIndex >= 0;

      if (leftSeeded || rightSeeded) {
        return (leftSeeded ? left.seededIndex : Number.MAX_SAFE_INTEGER) -
          (rightSeeded ? right.seededIndex : Number.MAX_SAFE_INTEGER);
      }

      return left.originalIndex - right.originalIndex;
    })
    .map(({ item, seededIndex }) => ({ item, userSeeded: seededIndex >= 0 }));
}

export function summarizeInventory(
  inventory: Inventory,
  options: { seededItems?: ConversationContextSeededItem[] } = {},
) {
  const orderedItems = orderInventoryItems(
    inventory.items,
    options.seededItems ?? [],
  );

  return {
    id: inventory.id,
    fridgeId: inventory.fridgeId,
    createdAt: inventory.createdAt,
    items: orderedItems.map(({ item, userSeeded }) => ({
      id: item.id,
      displayName: item.label,
      canonicalName: item.name,
      userSeeded,
      category: item.cat,
      subcategory: item.subcat,
      quantity: item.qty,
      packaging: item.pack,
      location: {
        status: item.loc.status,
        zoneType: item.loc.zoneType,
        zoneId: item.loc.zoneId,
        observations: item.loc.observations.map((observation) => ({
          imageId: observation.imageId,
          depthBackRatio: observation.depthBackRatio,
          boundingBox: observation.boundingBox,
        })),
        confidence: item.loc.confidence,
      },
      attributes: item.attrs,
      confidence: item.conf,
      reviewStatus: item.review,
    })),
    zones: inventory.zones.map((zone) => ({
      id: zone.id,
      type: zone.type,
      label: zone.label,
      order: zone.order,
      confidence: zone.confidence,
      estimatedCapacityRatio: zone.estimatedCapacityRatio,
      estimatedOccupiedRatio: zone.estimatedOccupiedRatio,
    })),
  };
}

export async function loadInventoryContext(
  state: FridgeQueryStateValue,
  deps: Pick<QueryGraphDependencies, "loadInventoryForImage"> = {},
) {
  if (!state.imageId) {
    return null;
  }

  const inventory = await (deps.loadInventoryForImage ?? getFridgeInventoryForImage)(
    state.imageId,
  );

  return inventory
    ? summarizeInventory(inventory, {
      seededItems: seededItemsFromState(state),
    })
    : null;
}
