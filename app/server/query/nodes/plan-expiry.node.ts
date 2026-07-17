import type { QueryGraphDependencies } from "../schemas/query";
import { buildExpiryPlan } from "../services/expiry-plan.server";
import { loadInventoryContext } from "../services/inventory-context.server";
import type { FridgeQueryStateValue } from "../state";

function householdItems(state: FridgeQueryStateValue) {
  const inventoryQuery = state.context.inventoryQuery;
  if (typeof inventoryQuery !== "object" || inventoryQuery === null || !("householdInventory" in inventoryQuery)) {
    return [];
  }

  return (Array.isArray(inventoryQuery.householdInventory) ? inventoryQuery.householdInventory : []) as Parameters<typeof buildExpiryPlan>[0]["householdItems"];
}

export function createPlanExpiryNode(deps: QueryGraphDependencies = {}) {
  return async function planExpiryNode(state: FridgeQueryStateValue) {
    const inventory = await loadInventoryContext(state, deps);
    const expiryPlan = buildExpiryPlan({
      scannedItems: inventory?.items ?? [],
      householdItems: [...householdItems(state), ...state.externalInventory],
    });

    return {
      context: {
        ...state.context,
        expiryPlan,
      },
    };
  };
}
