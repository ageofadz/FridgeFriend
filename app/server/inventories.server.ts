import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import { fridgeInventories } from "./db/schema.server";
import {
  Inventory as InventorySchema,
  type Inventory,
  type InventoryEnrichment,
  type VisualEnrichment,
} from "./scan/schemas/inventory";
import { withDatabase } from "./sqlite.server";

export type FridgeInventory = typeof fridgeInventories.$inferSelect;

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

export function appendFridgeInventoryVisualEnrichment(input: {
  imageId: string;
  itemIds: string[];
  query: string;
  response: string;
  crops: Array<Pick<VisualEnrichment, "imageId" | "boundingBox"> & { itemId: string }>;
  observedAt?: string;
  updates?: Array<{
    itemId: string;
    amount: number | null;
    unit: Inventory["items"][number]["qty"]["unit"] | null;
    fillLevel: number | null;
    expirationDate: string | null;
  }>;
}) {
  const inventory = getFridgeInventoryForImage(input.imageId);

  if (!inventory) {
    throw new Error(
      `Cannot persist visual enrichment because inventory was not found for image ${input.imageId}`,
    );
  }

  const cropByItemId = new Map(input.crops.map((crop) => [crop.itemId, crop]));
  const observedAt = input.observedAt ?? new Date().toISOString();
  const itemIds = new Set(input.itemIds);
  const updateByItemId = new Map(input.updates?.map((update) => [update.itemId, update]) ?? []);
  const updatedInventory: Inventory = {
    ...inventory,
    items: inventory.items.map((item) => {
      const crop = cropByItemId.get(item.id);
      const update = updateByItemId.get(item.id);

      if (!itemIds.has(item.id) || !crop) {
        return item;
      }

      return {
        ...item,
        qty: update ? {
          ...item.qty,
          amount: update.amount ?? item.qty.amount,
          unit: update.unit ?? item.qty.unit,
          fillLevel: update.fillLevel ?? item.qty.fillLevel,
          precision: update.amount !== null || update.fillLevel !== null
            ? "estimated"
            : item.qty.precision,
        } : item.qty,
        attrs: update?.expirationDate ? {
          ...item.attrs,
          expirationDate: update.expirationDate,
        } : item.attrs,
        visual: [
          ...(item.visual ?? []),
          {
            query: input.query,
            response: input.response,
            imageId: crop.imageId,
            boundingBox: crop.boundingBox,
            observedAt,
          },
        ],
      };
    }),
  };

  return saveFridgeInventory({
    imageId: input.imageId,
    inventory: updatedInventory,
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

      const latest = enrichments.at(-1)!;
      const expirationEnrichment = [...enrichments]
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
          ...enrichments.map(({ itemId: _itemId, ...enrichment }) => enrichment),
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
    zoneId: string;
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
    src: [...input.replaceItemIds, `drawer-split:${now}`],
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

export function deleteFridgeInventoryForImage(imageId: string) {
  return withDatabase((db) => {
    db.delete(fridgeInventories)
      .where(eq(fridgeInventories.imageId, imageId))
      .run();
  });
}
