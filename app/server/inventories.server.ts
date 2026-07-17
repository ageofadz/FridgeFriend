import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import { fridgeInventories } from "./db/schema.server";
import {
  Inventory as InventorySchema,
  type Inventory,
  type InventoryEnrichment,
} from "./scan/schemas/inventory";
import { withDatabase } from "./sqlite.server";
import type { StorageImageLocation } from "../workspace/contracts";
import type { StorageLocation } from "./memory/schemas";

function storageLocationLabel(storageLocation: StorageImageLocation) {
  return storageLocation[0].toUpperCase() + storageLocation.slice(1);
}

export function coerceInventoryStorageLocation(
  inventory: Inventory,
  storageLocation: StorageImageLocation,
) {
  if (storageLocation === "fridge") {
    return inventory;
  }

  const label = storageLocationLabel(storageLocation);

  return {
    ...inventory,
    zones: inventory.zones.map((zone, index) => ({
      ...zone,
      type: storageLocation,
      label: zone.label.toLowerCase().includes(storageLocation)
        ? zone.label
        : `${label} ${zone.label || `zone ${index + 1}`}`,
    })),
    items: inventory.items.map((item) => ({
      ...item,
      loc: {
        ...item.loc,
        zoneType: storageLocation,
      },
    })),
  } satisfies Inventory;
}

export function inventoryWithoutStorageLocation(
  inventory: Inventory,
  storageLocation: StorageImageLocation,
) {
  if (storageLocation === "fridge") {
    return inventory;
  }

  const keptZoneIds = new Set(
    inventory.zones
      .filter((zone) => zone.type !== storageLocation)
      .map((zone) => zone.id),
  );

  return {
    ...inventory,
    items: inventory.items.filter((item) => item.loc.zoneType !== storageLocation),
    zones: inventory.zones.filter((zone) => keptZoneIds.has(zone.id)),
  } satisfies Inventory;
}

export function mergeStorageInventory(
  baseInventory: Inventory,
  extensionInventory: Inventory,
  storageLocation: StorageImageLocation,
) {
  const baseWithoutLocation = inventoryWithoutStorageLocation(
    baseInventory,
    storageLocation,
  );

  return {
    ...baseWithoutLocation,
    scanId: `${baseInventory.scanId}:${storageLocation}:${extensionInventory.scanId}`,
    items: [
      ...baseWithoutLocation.items,
      ...extensionInventory.items,
    ],
    zones: [
      ...baseWithoutLocation.zones,
      ...extensionInventory.zones,
    ],
  } satisfies Inventory;
}

export function saveFridgeInventory(input: {
  imageId: string;
  inventory: Inventory;
}) {
  const parsedInventory = InventorySchema.parse(input.inventory);
  const now = new Date().toISOString();
  const row = {
    imageId: input.imageId,
    inventoryId: parsedInventory.id,
    inventoryJson: JSON.stringify(parsedInventory),
    createdAt: now,
    updatedAt: now,
  };

  return withDatabase((db) => {
    db.insert(fridgeInventories)
      .values(row)
      .onConflictDoUpdate({
        target: fridgeInventories.imageId,
        set: {
          inventoryId: row.inventoryId,
          inventoryJson: row.inventoryJson,
          updatedAt: row.updatedAt,
        },
      })
      .run();

    return parsedInventory;
  });
}

export function getFridgeInventoryForImage(imageId: string) {
  return withDatabase((db) => {
    const row = db
      .select()
      .from(fridgeInventories)
      .where(eq(fridgeInventories.imageId, imageId))
      .get();

    if (!row) {
      return null;
    }

    try {
      return InventorySchema.parse(JSON.parse(row.inventoryJson));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Stored inventory for image ${imageId} is invalid: ${message}`,
      );
    }
  });
}

export function appendFridgeInventoryEnrichments(input: {
  imageId: string;
  enrichments: Array<InventoryEnrichment & { itemId: string }>;
}) {
  const inventory = getFridgeInventoryForImage(input.imageId);

  if (!inventory) {
    throw new Error(
      `Cannot persist inventory enrichment because inventory was not found for image ${input.imageId}`,
    );
  }

  const enrichmentsByItemId = new Map<string, Array<InventoryEnrichment & { itemId: string }>>();
  for (const enrichment of input.enrichments) {
    const existing = enrichmentsByItemId.get(enrichment.itemId) ?? [];
    existing.push(enrichment);
    enrichmentsByItemId.set(enrichment.itemId, existing);
  }

  const updatedInventory: Inventory = {
    ...inventory,
    items: inventory.items.map((item) => {
      const enrichments = enrichmentsByItemId.get(item.id);
      if (!enrichments?.length) return item;
      const existingEnrichmentKeys = new Set((item.enrichments ?? []).map((enrichment) =>
        JSON.stringify(enrichment)
      ));
      const newEnrichments = enrichments
        .map(({ itemId: _itemId, ...enrichment }) => enrichment)
        .filter((enrichment) => !existingEnrichmentKeys.has(JSON.stringify(enrichment)));

      if (newEnrichments.length === 0) {
        return item;
      }

      const latest = newEnrichments.at(-1)!;
      const expirationEnrichment = [...newEnrichments]
        .reverse()
        .find((enrichment) => enrichment.values.expirationDate !== null);

      return {
        ...item,
        label: latest.values.label ?? item.label,
        qty: {
          ...item.qty,
          amount: latest.values.amount ?? item.qty.amount,
          unit: latest.values.unit ?? item.qty.unit,
          fillLevel: latest.values.fillLevel ?? item.qty.fillLevel,
          precision: latest.values.amount !== null || latest.values.fillLevel !== null
            ? latest.source === "user" ? "exact" : "estimated"
            : item.qty.precision,
        },
        attrs: {
          ...item.attrs,
          variant: latest.values.variant ?? item.attrs.variant,
          expirationDate: expirationEnrichment?.values.expirationDate ?? item.attrs.expirationDate,
          expirationDateSource: expirationEnrichment
            ? expirationEnrichment.source === "user" ? "user" : "observed"
            : item.attrs.expirationDateSource,
          opened: latest.values.opened ?? item.attrs.opened,
        },
        enrichments: [
          ...(item.enrichments ?? []),
          ...newEnrichments,
        ],
      };
    }),
  };

  return saveFridgeInventory({ imageId: input.imageId, inventory: updatedInventory });
}

export function applyFridgeInventorySplit(input: {
  imageId: string;
  replaceItemIds: string[];
  items: Array<{
    name: string;
    label: string;
    category: Inventory["items"][number]["cat"];
    packaging: Inventory["items"][number]["pack"];
    boundingBox: Inventory["items"][number]["loc"]["observations"][number]["boundingBox"];
    zoneId: string | null;
    zoneType: Inventory["items"][number]["loc"]["zoneType"];
  }>;
}) {
  const inventory = getFridgeInventoryForImage(input.imageId);
  if (!inventory) {
    throw new Error(`Cannot apply inventory split because inventory was not found for image ${input.imageId}`);
  }

  const replacedItems = inventory.items.filter((item) => input.replaceItemIds.includes(item.id));
  if (replacedItems.length !== input.replaceItemIds.length) {
    throw new Error("Cannot apply inventory split because one or more proposed source items no longer exist");
  }

  const now = new Date().toISOString();
  const replacementIds = new Set(input.replaceItemIds);
  const splitItems: Inventory["items"] = input.items.map((item) => ({
    id: randomUUID(),
    name: item.name,
    label: item.label,
    cat: item.category,
    subcat: null,
    qty: { amount: null, unit: "unknown", precision: "unknown", fillLevel: null },
    pack: item.packaging,
    loc: {
      status: item.zoneId ? "matched" : "unmatched",
      zoneId: item.zoneId,
      zoneType: item.zoneType,
      observations: [{ imageId: input.imageId, depthBackRatio: null, boundingBox: item.boundingBox }],
      confidence: 0.75,
    },
    conf: 0.75,
    src: [...input.replaceItemIds, `inventory-split:${now}`],
    attrs: { brand: null, variant: null, opened: null, expirationDate: null, expirationDateSource: null },
    review: "confirmed",
  }));

  return saveFridgeInventory({
    imageId: input.imageId,
    inventory: {
      ...inventory,
      items: [...inventory.items.filter((item) => !replacementIds.has(item.id)), ...splitItems],
    },
  });
}

function normalizedInventoryText(value: string) {
  return value
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function normalizedInventoryTokens(value: string) {
  return normalizedInventoryText(value)
    .split(" ")
    .map((token) => token.endsWith("s") && token.length > 3 ? token.slice(0, -1) : token)
    .filter(Boolean);
}

function tokenSetIncludesAll(container: Set<string>, tokens: string[]) {
  return tokens.length > 0 && tokens.every((token) => container.has(token));
}

function inventoryTextMatches(itemValue: string, targetValue: string) {
  const itemText = normalizedInventoryText(itemValue);
  const targetText = normalizedInventoryText(targetValue);

  if (itemText === targetText) {
    return true;
  }

  const itemTokens = normalizedInventoryTokens(itemText);
  const targetTokens = normalizedInventoryTokens(targetText);
  const itemTokenSet = new Set(itemTokens);
  const targetTokenSet = new Set(targetTokens);

  return tokenSetIncludesAll(itemTokenSet, targetTokens) ||
    tokenSetIncludesAll(targetTokenSet, itemTokens);
}

function storageLocationMatchesZoneType(
  storageLocation: StorageLocation,
  zoneType: Inventory["items"][number]["loc"]["zoneType"],
) {
  if (storageLocation === "fridge") {
    return zoneType === null ||
      zoneType === "shelf" ||
      zoneType === "drawer" ||
      zoneType === "door_shelf" ||
      zoneType === "unknown";
  }

  return zoneType === storageLocation;
}

export function removeItemsFromFridgeInventory(input: {
  imageId: string;
  name: string;
  storageLocation: StorageLocation;
}) {
  const inventory = getFridgeInventoryForImage(input.imageId);

  if (!inventory) {
    return {
      status: "not_applicable" as const,
      imageId: input.imageId,
      inventory: null,
      removedItemIds: [],
      message: `Scanned inventory for image ${input.imageId} was not found`,
    };
  }

  const targetName = normalizedInventoryText(input.name);
  const matchingItemIds = new Set(
    inventory.items
      .filter((item) =>
        storageLocationMatchesZoneType(input.storageLocation, item.loc.zoneType) &&
        (
          inventoryTextMatches(item.name, targetName) ||
          inventoryTextMatches(item.label, targetName)
        )
      )
      .map((item) => item.id),
  );

  if (matchingItemIds.size === 0) {
    return {
      status: "not_found" as const,
      imageId: input.imageId,
      inventory,
      removedItemIds: [],
      message: `No scanned inventory item matched ${input.name} in ${input.storageLocation}`,
    };
  }

  const updatedInventory = saveFridgeInventory({
    imageId: input.imageId,
    inventory: {
      ...inventory,
      items: inventory.items.filter((item) => !matchingItemIds.has(item.id)),
    },
  });

  return {
    status: "updated" as const,
    imageId: input.imageId,
    inventory: updatedInventory,
    removedItemIds: [...matchingItemIds],
    message: `Removed ${matchingItemIds.size} scanned inventory item${matchingItemIds.size === 1 ? "" : "s"} matching ${input.name}`,
  };
}
