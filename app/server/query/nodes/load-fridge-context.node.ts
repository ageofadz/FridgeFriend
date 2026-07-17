import { loadMemoryContextForQuery } from "../../memory/context.server";
import type { QueryGraphDependencies } from "../schemas/query";
import type { FridgeQueryStateValue } from "../state";

export function createLoadFridgeContextNode(deps: QueryGraphDependencies) {
  return async function loadFridgeContextNode(state: FridgeQueryStateValue) {
    const memoryContext = await (deps.loadMemoryContext ?? loadMemoryContextForQuery)({
      userId: state.userId,
      fridgeId: state.fridgeId,
      query: state.query,
    });

    return {
      externalInventory: memoryContext.externalInventory,
      dietaryRestrictions: memoryContext.dietaryRestrictions,
      dietaryPreferences: memoryContext.dietaryPreferences,
      activeGoals: memoryContext.activeGoals,
      semanticMemories: memoryContext.semanticMemories,
      context: {
        ...state.context,
        fridgeId: state.fridgeId,
        imageId: state.imageId,
        externalInventory: memoryContext.externalInventory,
        dietaryRestrictions: memoryContext.dietaryRestrictions,
        dietaryPreferences: memoryContext.dietaryPreferences,
        activeGoals: memoryContext.activeGoals,
        semanticMemories: memoryContext.semanticMemories,
      },
    };
  };
}
