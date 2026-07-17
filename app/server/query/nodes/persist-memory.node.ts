import { interrupt } from "@langchain/langgraph";

import { loadMemoryContextForQuery } from "../../memory/context.server";
import { createManageHouseholdInventoryTool } from "../../memory/inventory-tool.server";
import { applyMemoryCandidate } from "../../memory/repository.server";
import type {
  MemoryCandidate,
  MemoryContext,
  MemoryValidationResult,
  MemoryWriteResult,
  SemanticMemory,
} from "../../memory/schemas";
import { indexSemanticMemory } from "../../memory/vector-store.server";
import { QueryResumeSchema, type QueryGraphDependencies } from "../schemas/query";
import type { FridgeQueryStateValue } from "../state";

type PersistedMemoryWrite = {
  result: MemoryWriteResult;
  semanticMemory: SemanticMemory | null;
};

export type MemoryWriteVerification = {
  status: "verified" | "failed" | "not_applicable";
  persistedCount: number;
  verifiedCount: number;
  missing: Array<{
    kind: MemoryWriteResult["kind"];
    action: MemoryWriteResult["action"];
    targetId: string | null;
    message: string;
  }>;
  skipped: MemoryWriteResult[];
  message: string;
};

function memoryOperationKey(validation: MemoryValidationResult) {
  return `memory:${JSON.stringify(validation)}`;
}

function writeIsVisible(input: {
  candidate: MemoryCandidate;
  result: MemoryWriteResult;
  memoryContext: MemoryContext;
}) {
  const { candidate, result, memoryContext } = input;
  const targetId = result.targetId;

  if (!targetId) {
    return false;
  }

  if (candidate.kind === "inventory_item") {
    const visible = memoryContext.externalInventory.some((item) => item.id === targetId);
    return candidate.action === "upsert" ? visible : !visible;
  }

  if (candidate.kind === "dietary_restriction") {
    const visible = memoryContext.dietaryRestrictions.some((memory) => memory.id === targetId);
    return candidate.action === "upsert" ? visible : !visible;
  }

  if (candidate.kind === "preference") {
    const visible = memoryContext.dietaryPreferences.some((memory) => memory.id === targetId);
    return candidate.action === "upsert" ? visible : !visible;
  }

  if (candidate.kind === "goal") {
    const visible = memoryContext.activeGoals.some((memory) => memory.id === targetId);
    return candidate.action === "upsert" ? visible : !visible;
  }

  const visible = memoryContext.semanticMemories.some((memory) => memory.id === targetId && memory.active);
  return candidate.action === "upsert" ? visible : !visible;
}

function verifyMemoryWrites(input: {
  memoryContext: MemoryContext;
  validations: MemoryValidationResult[];
  writes: MemoryWriteResult[];
}): MemoryWriteVerification {
  const skipped = input.writes.filter((write) => write.status === "skipped");
  const persisted = input.writes.filter((write) => write.status === "persisted");

  if (input.writes.length === 0) {
    return {
      status: "not_applicable",
      persistedCount: 0,
      verifiedCount: 0,
      missing: [],
      skipped,
      message: "No durable memory writes were attempted.",
    };
  }

  if (persisted.length === 0) {
    return {
      status: "not_applicable",
      persistedCount: 0,
      verifiedCount: 0,
      missing: [],
      skipped,
      message: `No durable memory was saved: ${skipped.map((write) => write.message).join("; ")}`,
    };
  }

  const validationQueue = [...input.validations];
  let verifiedCount = 0;
  const missing: MemoryWriteVerification["missing"] = [];

  for (const write of persisted) {
    const validationIndex = validationQueue.findIndex((validation) =>
      validation.candidate.kind === write.kind &&
      validation.candidate.action === write.action
    );
    const validation = validationIndex >= 0 ? validationQueue.splice(validationIndex, 1)[0] : null;

    if (validation && writeIsVisible({
      candidate: validation.candidate,
      result: write,
      memoryContext: input.memoryContext,
    })) {
      verifiedCount += 1;
      continue;
    }

    missing.push({
      kind: write.kind,
      action: write.action,
      targetId: write.targetId,
      message: write.targetId
        ? `Persisted ${write.kind} ${write.action} target ${write.targetId} was not visible after reload.`
        : `Persisted ${write.kind} ${write.action} returned no target id.`,
    });
  }

  if (missing.length > 0) {
    return {
      status: "failed",
      persistedCount: persisted.length,
      verifiedCount,
      missing,
      skipped,
      message: missing.map((entry) => entry.message).join("; "),
    };
  }

  return {
    status: "verified",
    persistedCount: persisted.length,
    verifiedCount,
    missing,
    skipped,
    message: `Verified ${verifiedCount} durable memory update${verifiedCount === 1 ? "" : "s"}.`,
  };
}

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
      if (candidate.action === "consume" || candidate.action === "remove") {
        const resumed = interrupt({
          type: "inventory_mutation_review",
          operation: candidate.action,
          itemName: candidate.name,
          storageLocation: candidate.storageLocation,
        });
        const parsedResume = QueryResumeSchema.safeParse(resumed);
        if (!parsedResume.success || !parsedResume.data.inventoryMutationReview?.approved) {
          return {
            result: {
              kind: candidate.kind,
              action: candidate.action,
              status: "skipped",
              targetId: null,
              message: `${candidate.action === "consume" ? "Consuming" : "Removing"} ${candidate.name} was not approved.`,
            },
            semanticMemory: null,
          };
        }
      }
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

export function createApplyMemoryWritesNode(deps: QueryGraphDependencies) {
  return async function applyMemoryWritesNode(state: FridgeQueryStateValue) {
    const persist = deps.persistMemoryValidations ?? persistValidatedMemory;
    const completedOperationKeys = state.completedOperationKeys ?? [];
    const memoryWriteResults = state.memoryWriteResults ?? [];
    const pendingSemanticMemories = state.pendingSemanticMemories ?? [];
    const pendingValidations = state.memoryValidations.filter((validation) =>
      !completedOperationKeys.includes(memoryOperationKey(validation))
    );
    const writes = await persist({
      userId: state.userId,
      fridgeId: state.fridgeId,
      validations: pendingValidations,
    });

    return {
      memoryWriteResults: [...memoryWriteResults, ...writes.map((write) => write.result)],
      pendingSemanticMemories: [...pendingSemanticMemories, ...writes.flatMap((write) => write.semanticMemory ? [write.semanticMemory] : [])],
      completedOperationKeys: [
        ...completedOperationKeys,
        ...pendingValidations.map(memoryOperationKey),
      ],
      context: {
        ...state.context,
        memoryWriteResults: [...memoryWriteResults, ...writes.map((write) => write.result)],
      },
    };
  };
}

export function createIndexSemanticMemoryNode(deps: QueryGraphDependencies) {
  return async function indexSemanticMemoryNode(state: FridgeQueryStateValue) {
    const indexMemory = deps.indexSemanticMemory ?? indexSemanticMemory;
    const indexed = new Set(state.indexedSemanticMemoryIds ?? []);

    for (const memory of state.pendingSemanticMemories ?? []) {
      if (!indexed.has(memory.id)) {
        await indexMemory(memory);
        indexed.add(memory.id);
      }
    }

    return {
      indexedSemanticMemoryIds: [...indexed],
    };
  };
}

export function createReloadMemoryContextNode(deps: QueryGraphDependencies) {
  return async function reloadMemoryContextNode(state: FridgeQueryStateValue) {
    const memoryContext = await (deps.loadMemoryContext ?? loadMemoryContextForQuery)({
      userId: state.userId,
      fridgeId: state.fridgeId,
      query: state.query,
    });
    const memoryWriteVerification = verifyMemoryWrites({
      memoryContext,
      validations: state.memoryValidations ?? [],
      writes: state.memoryWriteResults ?? [],
    });

    return {
      memoryWriteResults: state.memoryWriteResults ?? [],
      externalInventory: memoryContext.externalInventory,
      dietaryRestrictions: memoryContext.dietaryRestrictions,
      dietaryPreferences: memoryContext.dietaryPreferences,
      activeGoals: memoryContext.activeGoals,
      semanticMemories: memoryContext.semanticMemories,
      context: {
        ...state.context,
        memoryWriteResults: state.memoryWriteResults ?? [],
        memoryWriteVerification,
        ...(memoryWriteVerification.status === "failed"
          ? { memoryWriteVerificationError: memoryWriteVerification.message }
          : {}),
      },
    };
  };
}

export function createPersistMemoryNode(deps: QueryGraphDependencies) {
  const applyWrites = createApplyMemoryWritesNode(deps);
  const indexMemories = createIndexSemanticMemoryNode(deps);
  const reloadContext = createReloadMemoryContextNode(deps);

  return async function persistMemoryNode(state: FridgeQueryStateValue) {
    const writeUpdate = await applyWrites(state);
    const afterWrites = { ...state, ...writeUpdate };
    const indexUpdate = await indexMemories(afterWrites);
    const afterIndex = { ...afterWrites, ...indexUpdate };

    return reloadContext(afterIndex);
  };
}
