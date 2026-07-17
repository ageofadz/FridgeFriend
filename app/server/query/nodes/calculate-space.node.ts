import type { QueryGraphDependencies } from "../schemas/query";
import { loadInventoryContext } from "../services/inventory-context.server";
import type { FridgeQueryStateValue } from "../state";

export function createCalculateSpaceNode(deps: QueryGraphDependencies = {}) {
  return async function calculateSpaceNode(state: FridgeQueryStateValue) {
    const inventory = await loadInventoryContext(state, deps);

    return {
      context: {
        ...state.context,
        queryMode: "space",
        zones: inventory?.zones ?? [],
      },
    };
  };
}
