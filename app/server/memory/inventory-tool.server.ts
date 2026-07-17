import { tool } from "@langchain/core/tools";
import { z } from "zod";

import {
  HOUSEHOLD_INVENTORY_LIST_FIELDS,
  HOUSEHOLD_INVENTORY_STATUSES,
  manageHouseholdInventory,
  type HouseholdInventoryOperation,
  type HouseholdInventoryOperationResult,
} from "./repository.server";
import { QuantitySchema, STORAGE_LOCATIONS, StorageLocationSchema } from "./schemas";

const ManageHouseholdInventoryToolInputSchema = z.object({
  operation: z.unknown().optional().describe(
    "One of list, add, update, consume, or remove.",
  ),
  id: z.unknown().optional().describe(
    "Persistent inventory item id. Use list to get it. For update, consume, and remove, provide this or both name and storageLocation.",
  ),
  name: z.unknown().optional().describe(
    "Item name. Required for add and usable with storageLocation to identify an existing item.",
  ),
  storageLocation: z.unknown().optional().describe(
    "One of fridge, freezer, pantry, cupboard, counter, or other. Required for add and name-based item selection.",
  ),
  location: z.unknown().optional().describe(
    "Optional location filter for list: fridge, freezer, pantry, cupboard, counter, or other.",
  ),
  locations: z.unknown().optional().describe(
    "Optional list filter with multiple storage locations.",
  ),
  ids: z.unknown().optional().describe(
    "Optional list filter with persistent inventory item ids.",
  ),
  names: z.unknown().optional().describe(
    "Optional list filter with item names. Matching is canonicalized.",
  ),
  search: z.unknown().optional().describe(
    "Optional case-insensitive list search across name, canonical name, and notes.",
  ),
  statuses: z.unknown().optional().describe(
    "Optional list filter for statuses: available, possibly_available, consumed, or removed. Defaults to active statuses only.",
  ),
  hasQuantity: z.unknown().optional().describe(
    "Optional list filter. True returns only items with quantity; false returns only items without quantity.",
  ),
  hasNotes: z.unknown().optional().describe(
    "Optional list filter. True returns only items with notes; false returns only items without notes.",
  ),
  expiringBefore: z.unknown().optional().describe(
    "Optional YYYY-MM-DD list filter for items with expirationDate on or before the date.",
  ),
  fields: z.unknown().optional().describe(
    "Optional list projection. Choose fields from id, fridgeId, name, canonicalName, storageLocation, quantity, status, confidence, source, notes, expirationDate, expirationDateSource, lastConfirmedAt, createdAt, updatedAt. id is always included.",
  ),
  limit: z.unknown().optional().describe(
    "Optional list limit from 1 to 200.",
  ),
  sortBy: z.unknown().optional().describe(
    "Optional list sort key: name, storageLocation, updatedAt, or expirationDate.",
  ),
  sortDirection: z.unknown().optional().describe(
    "Optional list sort direction: asc or desc.",
  ),
  newName: z.unknown().optional().describe(
    "Replacement name for update.",
  ),
  newStorageLocation: z.unknown().optional().describe(
    "Replacement storage location for update.",
  ),
  quantity: z.unknown().optional().describe(
    "For add or update, either null or an object with amount, unit, and precision of exact, estimated, or unknown.",
  ),
  notes: z.unknown().optional().describe(
    "For add or update, either null or a note string.",
  ),
}).passthrough();

const ItemSelectorSchema = z.object({
  id: z.string().trim().min(1).optional(),
  name: z.string().trim().min(1).optional(),
  storageLocation: StorageLocationSchema.optional(),
}).refine(
  (input) => Boolean(input.id) || Boolean(input.name && input.storageLocation),
  "Provide an item id or both name and storageLocation",
);

const ListOperationSchema = z.object({
  operation: z.literal("list"),
  location: StorageLocationSchema.optional(),
  locations: z.array(StorageLocationSchema).max(STORAGE_LOCATIONS.length).optional(),
  ids: z.array(z.string().trim().min(1)).max(100).optional(),
  names: z.array(z.string().trim().min(1)).max(100).optional(),
  search: z.string().trim().min(1).optional(),
  statuses: z.array(z.enum(HOUSEHOLD_INVENTORY_STATUSES)).max(HOUSEHOLD_INVENTORY_STATUSES.length).optional(),
  hasQuantity: z.boolean().optional(),
  hasNotes: z.boolean().optional(),
  expiringBefore: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  fields: z.array(z.enum(HOUSEHOLD_INVENTORY_LIST_FIELDS)).max(HOUSEHOLD_INVENTORY_LIST_FIELDS.length).optional(),
  limit: z.number().int().min(1).max(200).optional(),
  sortBy: z.enum(["name", "storageLocation", "updatedAt", "expirationDate"]).optional(),
  sortDirection: z.enum(["asc", "desc"]).optional(),
});

const AddOperationSchema = z.object({
  operation: z.literal("add"),
  name: z.string().trim().min(1),
  storageLocation: StorageLocationSchema,
  quantity: QuantitySchema.nullable().optional().default(null),
  notes: z.string().nullable().optional().default(null),
});

const UpdateOperationSchema = ItemSelectorSchema.extend({
  operation: z.literal("update"),
  newName: z.string().trim().min(1).optional(),
  newStorageLocation: StorageLocationSchema.optional(),
  quantity: QuantitySchema.nullable().optional(),
  notes: z.string().nullable().optional(),
}).refine(
  (input) =>
    input.newName !== undefined ||
    input.newStorageLocation !== undefined ||
    input.quantity !== undefined ||
    input.notes !== undefined,
  "Update requires newName, newStorageLocation, quantity, or notes",
);

const ConsumeOrRemoveOperationSchema = ItemSelectorSchema.extend({
  operation: z.enum(["consume", "remove"]),
});

function invalidResult(
  operation: HouseholdInventoryOperationResult["operation"],
  message: string,
): HouseholdInventoryOperationResult {
  return {
    operation,
    status: "invalid",
    message,
    item: null,
    items: [],
  };
}

function validationMessage(error: z.ZodError) {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`)
    .join("; ");
}

function parseOperation(input: Record<string, unknown>):
  | { success: true; operation: HouseholdInventoryOperation }
  | { success: false; result: HouseholdInventoryOperationResult } {
  const operation = input.operation;

  if (operation === "list") {
    const parsed = ListOperationSchema.safeParse(input);
    return parsed.success
      ? {
        success: true,
        operation: {
          operation: "list",
          storageLocation: parsed.data.location,
          storageLocations: parsed.data.locations,
          ids: parsed.data.ids,
          names: parsed.data.names,
          search: parsed.data.search,
          statuses: parsed.data.statuses,
          hasQuantity: parsed.data.hasQuantity,
          hasNotes: parsed.data.hasNotes,
          expiringBefore: parsed.data.expiringBefore,
          fields: parsed.data.fields,
          limit: parsed.data.limit,
          sortBy: parsed.data.sortBy,
          sortDirection: parsed.data.sortDirection,
        },
      }
      : {
        success: false,
        result: invalidResult("list", validationMessage(parsed.error)),
      };
  }

  if (operation === "add") {
    const parsed = AddOperationSchema.safeParse(input);
    return parsed.success
      ? { success: true, operation: parsed.data }
      : {
        success: false,
        result: invalidResult("add", validationMessage(parsed.error)),
      };
  }

  if (operation === "update") {
    const parsed = UpdateOperationSchema.safeParse(input);
    return parsed.success
      ? { success: true, operation: parsed.data }
      : {
        success: false,
        result: invalidResult("update", validationMessage(parsed.error)),
      };
  }

  if (operation === "consume" || operation === "remove") {
    const parsed = ConsumeOrRemoveOperationSchema.safeParse(input);
    return parsed.success
      ? { success: true, operation: parsed.data }
      : {
        success: false,
        result: invalidResult(operation, validationMessage(parsed.error)),
      };
  }

  return {
    success: false,
    result: invalidResult(
      "invalid",
      "operation must be one of list, add, update, consume, or remove",
    ),
  };
}

export function createManageHouseholdInventoryTool(input: {
  fridgeId: string;
  source?: string;
}) {
  const fridgeId = input.fridgeId.trim();

  return tool(
    async (rawInput) => {
      if (fridgeId.length === 0) {
        return invalidResult(
          "invalid",
          "manage_household_inventory has no bound fridge ID",
        );
      }

      const parsed = parseOperation(rawInput);

      if (!parsed.success) {
        return parsed.result;
      }

      return manageHouseholdInventory({
        fridgeId,
        operation: parsed.operation,
        source: input.source,
      });
    },
    {
      name: "manage_household_inventory",
      description:
        "Manage persistent household inventory for the current fridge. The fridge is already bound server-side: never send a fridgeId. For reads, list supports filters: location, locations, ids, names, search, statuses, hasQuantity, hasNotes, expiringBefore, limit, sortBy, and sortDirection. For compact reads, pass fields to request only specific fields; id is always included. Use list with fields before update, consume, or remove when an item id is unknown. Invalid operations return structured results instead of errors.",
      schema: ManageHouseholdInventoryToolInputSchema,
    },
  );
}
