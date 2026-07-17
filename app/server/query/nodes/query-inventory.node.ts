import { createManageHouseholdInventoryTool } from "../../memory/inventory-tool.server";
import type { QueryGraphDependencies } from "../schemas/query";
import { conversationContextFromState } from "../services/conversation-context.server";
import { loadInventoryContext } from "../services/inventory-context.server";
import type { FridgeQueryStateValue } from "../state";

function normalizedTerms(value: string) {
  return value
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((word) =>
      word.length > 1 &&
      !new Set([
        "how",
        "many",
        "much",
        "what",
        "which",
        "do",
        "does",
        "is",
        "are",
        "the",
        "my",
        "in",
        "of",
        "have",
        "there",
        "fridge",
        "inventory",
      ]).has(word)
    );
}

function singularize(word: string) {
  if (word.endsWith("ies") && word.length > 3) {
    return `${word.slice(0, -3)}y`;
  }

  if (word.endsWith("s") && !word.endsWith("ss") && word.length > 2) {
    return word.slice(0, -1);
  }

  return word;
}

function focusedInventoryItemIds(
  inventory: Awaited<ReturnType<typeof loadInventoryContext>>,
  query: string,
) {
  if (!inventory) {
    return [];
  }

  const queryTerms = new Set(normalizedTerms(query).map(singularize));

  if (queryTerms.size === 0) {
    return [];
  }

  return inventory.items
    .filter((item) => {
      const itemTerms = normalizedTerms(
        `${item.displayName} ${item.canonicalName}`,
      ).map(singularize);

      return itemTerms.some((term) => queryTerms.has(term));
    })
    .map((item) => item.id);
}

function seededInventoryItemIds(state: FridgeQueryStateValue) {
  return conversationContextFromState(state).seededItems.map((item) => item.itemId);
}

function selectedZoneItemIds(
  inventory: Awaited<ReturnType<typeof loadInventoryContext>>,
  state: FridgeQueryStateValue,
) {
  if (!inventory) return [];
  const selectedZoneIds = conversationContextFromState(state).selectedZoneIds;
  if (selectedZoneIds.length === 0) return [];
  const zoneIds = new Set(selectedZoneIds);
  return inventory.items
    .filter((item) => item.location.zoneId !== null && zoneIds.has(item.location.zoneId))
    .map((item) => item.id);
}

function orderedUniqueItemIds(...groups: string[][]) {
  const seen = new Set<string>();
  return groups.flatMap((group) =>
    group.filter((itemId) => {
      if (seen.has(itemId)) {
        return false;
      }

      seen.add(itemId);
      return true;
    })
  );
}

export function createQueryInventoryNode(deps: QueryGraphDependencies = {}) {
  return async function queryInventoryNode(state: FridgeQueryStateValue) {
    const inventory = await loadInventoryContext(state, deps);
    const householdInventoryTool = deps.householdInventoryTool ??
      createManageHouseholdInventoryTool({
        fridgeId: state.fridgeId,
      });
    const householdInventory = await householdInventoryTool.invoke({
      operation: "list",
      fields: [
        "id",
        "name",
        "canonicalName",
        "storageLocation",
        "quantity",
        "notes",
        "expirationDate",
        "expirationDateSource",
        "status",
        "confidence",
        "source",
      ],
      sortBy: "name",
      sortDirection: "asc",
    });
    const focusedItemIds = orderedUniqueItemIds(
      seededInventoryItemIds(state),
      selectedZoneItemIds(inventory, state),
      focusedInventoryItemIds(inventory, state.query),
    );
    return {
      context: {
        ...state.context,
        queryMode: "inventory",
        inventoryQuery: {
          source: "current_inventory_tool",
          scannedInventoryId: inventory?.id ?? null,
          householdInventory: householdInventory.items,
          focusedItemIds,
          visibleItemCount: inventory?.items.length ?? 0,
          visibleZoneCount: inventory?.zones.length ?? 0,
          householdItemCount: householdInventory.items.length,
          householdInventoryStatus: householdInventory.status,
        },
      },
    };
  };
}
