import { interrupt } from "@langchain/langgraph";

import { loadMemoryContextForQuery } from "../../memory/context.server";
import { createManageHouseholdInventoryTool } from "../../memory/inventory-tool.server";
import { applyMemoryCandidate } from "../../memory/repository.server";
import { removeItemsFromFridgeInventory } from "../../inventories.server";
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
  scannedInventoryMutation: ScannedInventoryMutationResult | null;
};

type ScannedInventoryMutationResult = {
  status: "updated" | "not_found" | "not_applicable";
  action: "consume" | "remove";
  targetId: string;
  imageId: string;
  itemName: string;
  storageLocation: string;
  removedItemIds: string[];
  inventory: unknown;
  message: string;
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
  scannedInventoryMutations: ScannedInventoryMutationResult[];
}) {
  const { candidate, result, memoryContext, scannedInventoryMutations } = input;
  const targetId = result.targetId;

  if (!targetId) {
    return false;
  }

  if (candidate.kind === "inventory_item") {
    const scannedMutation = scannedInventoryMutations.find((mutation) =>
      mutation.action === candidate.action &&
      mutation.itemName === candidate.name &&
      mutation.storageLocation === candidate.storageLocation
    );

    if (scannedMutation?.imageId && scannedMutation.status !== "updated") {
      return false;
    }

    const visible = memoryContext.externalInventory.some((item) => item.id === targetId);
    if (candidate.action === "upsert") {
      return visible;
    }

    if (targetId.startsWith("fridge_inventory:")) {
      return scannedMutation?.status === "updated";
    }

    return !visible;
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
    if (candidate.action === "deactivate") {
      return !memoryContext.activeGoals.some((memory) => memory.goalType === candidate.goalType);
    }

    const visible = memoryContext.activeGoals.some((memory) => memory.id === targetId);
    return visible;
  }

  const visible = memoryContext.semanticMemories.some((memory) => memory.id === targetId && memory.active);
  return candidate.action === "upsert" ? visible : !visible;
}

function verifyMemoryWrites(input: {
  memoryContext: MemoryContext;
  validations: MemoryValidationResult[];
  writes: MemoryWriteResult[];
  scannedInventoryMutations: ScannedInventoryMutationResult[];
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
      status: "failed",
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
      scannedInventoryMutations: input.scannedInventoryMutations,
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
  imageId: string | null;
  validations: MemoryValidationResult[];
}): Promise<PersistedMemoryWrite[]> {
  const inventoryTool = createManageHouseholdInventoryTool({
    fridgeId: input.fridgeId,
    source: "user_explicit",
  });

  const writes: PersistedMemoryWrite[] = [];

  for (const validation of input.validations) {
    if (!validation.accepted || validation.candidate.kind !== "inventory_item") {
      const write = applyMemoryCandidate({
        profile: {
          userId: input.userId,
          fridgeId: input.fridgeId,
        },
        validation,
      });
      writes.push({
        ...write,
        scannedInventoryMutation: null,
      });
      continue;
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
        writes.push({
          result: {
            kind: candidate.kind,
            action: candidate.action,
            status: "skipped",
            targetId: null,
            message: `${candidate.action === "consume" ? "Consuming" : "Removing"} ${candidate.name} was not approved.`,
          },
          semanticMemory: null,
          scannedInventoryMutation: null,
        });
        continue;
      }
    }
    const scannedInventoryMutation = candidate.action === "consume" || candidate.action === "remove"
      ? input.imageId
        ? (() => {
          const mutation = removeItemsFromFridgeInventory({
            imageId: input.imageId,
            name: candidate.name,
            storageLocation: candidate.storageLocation,
          });
          return {
            status: mutation.status,
            action: candidate.action,
            targetId: `fridge_inventory:${input.imageId}:${candidate.action}:${candidate.storageLocation}:${candidate.name}`,
            imageId: input.imageId,
            itemName: candidate.name,
            storageLocation: candidate.storageLocation,
            removedItemIds: mutation.removedItemIds,
            inventory: mutation.inventory,
            message: mutation.message,
          } satisfies ScannedInventoryMutationResult;
        })()
        : {
          status: "not_applicable" as const,
          action: candidate.action,
          targetId: `fridge_inventory:none:${candidate.action}:${candidate.storageLocation}:${candidate.name}`,
          imageId: "",
          itemName: candidate.name,
          storageLocation: candidate.storageLocation,
          removedItemIds: [],
          inventory: null,
          message: "No active image was available for scanned inventory mutation",
        } satisfies ScannedInventoryMutationResult
      : null;
    const scannedInventoryUpdated = scannedInventoryMutation?.status === "updated";
    const scannedInventoryRequired = Boolean(scannedInventoryMutation?.imageId);
    if (scannedInventoryRequired && !scannedInventoryUpdated) {
      writes.push({
        result: {
          kind: candidate.kind,
          action: candidate.action,
          status: "skipped",
          targetId: scannedInventoryMutation?.targetId ?? null,
          message: scannedInventoryMutation?.message ?? `No scanned inventory item matched ${candidate.name} in ${candidate.storageLocation}`,
        },
        semanticMemory: null,
        scannedInventoryMutation,
      });
      continue;
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
    const householdInventoryUpdated = outcome.status === "ok";
    const householdInventoryAbsent = outcome.status === "not_found";
    const mutationPersisted = candidate.action === "upsert"
      ? householdInventoryUpdated
      : (scannedInventoryUpdated || householdInventoryUpdated || householdInventoryAbsent);

    writes.push({
      result: {
        kind: candidate.kind,
        action: candidate.action,
        status: mutationPersisted ? "persisted" : "skipped",
        targetId: outcome.item?.id ?? scannedInventoryMutation?.targetId ?? null,
        message: householdInventoryUpdated && scannedInventoryUpdated
          ? `${outcome.message}; ${scannedInventoryMutation.message}`
          : scannedInventoryUpdated
          ? scannedInventoryMutation.message
          : outcome.message,
      },
      semanticMemory: null,
      scannedInventoryMutation,
    });
  }

  return writes;
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
      imageId: state.imageId ?? null,
      validations: pendingValidations,
    });
    const scannedInventoryMutations = [
      ...(
        Array.isArray(state.context.scannedInventoryMutations)
          ? state.context.scannedInventoryMutations.filter((mutation): mutation is ScannedInventoryMutationResult =>
            typeof mutation === "object" &&
            mutation !== null &&
            "targetId" in mutation &&
            typeof mutation.targetId === "string"
          )
          : []
      ),
      ...writes.flatMap((write) =>
        "scannedInventoryMutation" in write && write.scannedInventoryMutation
          ? [write.scannedInventoryMutation]
          : []
      ),
    ];

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
        scannedInventoryMutations,
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
      scannedInventoryMutations: Array.isArray(state.context.scannedInventoryMutations)
        ? state.context.scannedInventoryMutations.filter((mutation): mutation is ScannedInventoryMutationResult =>
          typeof mutation === "object" &&
          mutation !== null &&
          "targetId" in mutation &&
          typeof mutation.targetId === "string"
        )
        : [],
    });
    const {
      memoryWriteVerificationError: _memoryWriteVerificationError,
      ...context
    } = state.context;

    return {
      memoryWriteResults: state.memoryWriteResults ?? [],
      externalInventory: memoryContext.externalInventory,
      dietaryRestrictions: memoryContext.dietaryRestrictions,
      dietaryPreferences: memoryContext.dietaryPreferences,
      activeGoals: memoryContext.activeGoals,
      semanticMemories: memoryContext.semanticMemories,
      context: {
        ...context,
        ...(state.memoryWriteResults.length > 0
          ? {
            memoryWriteResults: state.memoryWriteResults,
            memoryWriteVerification,
            ...(memoryWriteVerification.status === "failed"
              ? { memoryWriteVerificationError: memoryWriteVerification.message }
              : {}),
          }
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
