import { loadMemoryContextForQuery } from "../../memory/context.server";
import { createManageHouseholdInventoryTool } from "../../memory/inventory-tool.server";
import { applyMemoryCandidate } from "../../memory/repository.server";
import type {
  MemoryValidationResult,
  MemoryWriteResult,
  SemanticMemory,
} from "../../memory/schemas";
import { indexSemanticMemory } from "../../memory/vector-store.server";
import type { QueryGraphDependencies } from "../schemas/query";
import type { FridgeQueryStateValue } from "../state";

type PersistedMemoryWrite = {
  result: MemoryWriteResult;
  semanticMemory: SemanticMemory | null;
};

async function persistValidatedMemory(input: {
  userId: string;
  fridgeId: string;
  validations: MemoryValidationResult[];
}): Promise<PersistedMemoryWrite[]> {
  const inventoryTool = createManageHouseholdInventoryTool({
    fridgeId: input.fridgeId,
    source: "user_explicit",
  });

  return Promise.all(
    input.validations.map(async (validation) => {
      if (!validation.accepted || validation.candidate.kind !== "inventory_item") {
        return applyMemoryCandidate({
          profile: {
            userId: input.userId,
            fridgeId: input.fridgeId,
          },
          validation,
        });
      }

      const candidate = validation.candidate;
      const operation =
        candidate.action === "upsert"
          ? {
            operation: "add" as const,
            name: candidate.name,
            storageLocation: candidate.storageLocation,
            quantity: candidate.quantity,
            notes: candidate.notes,
          }
          : {
            operation: candidate.action,
            name: candidate.name,
            storageLocation: candidate.storageLocation,
          };
      const outcome = await inventoryTool.invoke(operation);

      return {
        result: {
          kind: candidate.kind,
          action: candidate.action,
          status: outcome.status === "ok" ? "persisted" : "skipped",
          targetId: outcome.item?.id ?? null,
          message: outcome.message,
        },
        semanticMemory: null,
      };
    }),
  );
}

export function createPersistMemoryNode(deps: QueryGraphDependencies) {
  return async function persistMemoryNode(state: FridgeQueryStateValue) {
    const persist = deps.persistMemoryValidations ?? persistValidatedMemory;
    const writes = await persist({
      userId: state.userId,
      fridgeId: state.fridgeId,
      validations: state.memoryValidations,
    });
    const indexMemory = deps.indexSemanticMemory ?? indexSemanticMemory;

    for (const write of writes) {
      if (write.semanticMemory) {
        await indexMemory(write.semanticMemory);
      }
    }

    const memoryContext = await (deps.loadMemoryContext ?? loadMemoryContextForQuery)({
      userId: state.userId,
      fridgeId: state.fridgeId,
      query: state.query,
    });

    return {
      memoryWriteResults: writes.map((write) => write.result),
      externalInventory: memoryContext.externalInventory,
      dietaryRestrictions: memoryContext.dietaryRestrictions,
      dietaryPreferences: memoryContext.dietaryPreferences,
      activeGoals: memoryContext.activeGoals,
      semanticMemories: memoryContext.semanticMemories,
      context: {
        ...state.context,
        externalInventory: memoryContext.externalInventory,
        dietaryRestrictions: memoryContext.dietaryRestrictions,
        dietaryPreferences: memoryContext.dietaryPreferences,
        activeGoals: memoryContext.activeGoals,
        semanticMemories: memoryContext.semanticMemories,
        memoryWriteResults: writes.map((write) => write.result),
      },
    };
  };
}
