import { interrupt } from "@langchain/langgraph";

import type {
  DietaryPreferenceMemory,
  DietaryRestrictionMemory,
  ExternalInventoryMemory,
  GoalMemory,
  MemoryContext,
  MemoryValidationResult,
  MemoryWriteResult,
  SemanticMemory,
} from "../../memory/schemas";
import { QueryResumeSchema, type QueryGraphDependencies } from "../../query/schemas/query";
import type { KnowledgeFixture, MemoryFixture } from "../schemas/query-eval-case";
import type { FixtureSideEffectLog } from "./fixture-workspace-adapter";

const FIXTURE_TIMESTAMP = "2026-01-01T00:00:00.000Z";
const FIXTURE_SOURCE = "user_explicit";

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function text(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function toExternalInventory(value: Record<string, unknown>, index: number): ExternalInventoryMemory {
  return {
    id: text(value.id, `fixture-external-${index}`),
    fridgeId: text(value.fridgeId, "fixture-fridge"),
    name: text(value.name, `item-${index}`),
    canonicalName: typeof value.canonicalName === "string" ? value.canonicalName : null,
    storageLocation: (value.storageLocation as ExternalInventoryMemory["storageLocation"]) ?? "fridge",
    quantity: (value.quantity as ExternalInventoryMemory["quantity"]) ?? null,
    status: (value.status as ExternalInventoryMemory["status"]) ?? "available",
    confidence: typeof value.confidence === "number" ? value.confidence : 1,
    source: text(value.source, FIXTURE_SOURCE),
    notes: typeof value.notes === "string" ? value.notes : null,
    lastConfirmedAt: text(value.lastConfirmedAt, FIXTURE_TIMESTAMP),
    createdAt: text(value.createdAt, FIXTURE_TIMESTAMP),
    updatedAt: text(value.updatedAt, FIXTURE_TIMESTAMP),
  };
}

function toRestriction(value: Record<string, unknown>, index: number): DietaryRestrictionMemory {
  return {
    id: text(value.id, `fixture-restriction-${index}`),
    userId: text(value.userId, "eval-user"),
    restrictionType: (value.restrictionType as DietaryRestrictionMemory["restrictionType"]) ?? "other",
    subject: text(value.subject, `restriction-${index}`),
    severity: (value.severity as DietaryRestrictionMemory["severity"]) ?? "strict_avoid",
    notes: typeof value.notes === "string" ? value.notes : null,
    source: text(value.source, FIXTURE_SOURCE),
    createdAt: text(value.createdAt, FIXTURE_TIMESTAMP),
    updatedAt: text(value.updatedAt, FIXTURE_TIMESTAMP),
  };
}

function toPreference(value: Record<string, unknown>, index: number): DietaryPreferenceMemory {
  return {
    id: text(value.id, `fixture-preference-${index}`),
    userId: text(value.userId, "eval-user"),
    subject: text(value.subject, `preference-${index}`),
    sentiment: (value.sentiment as DietaryPreferenceMemory["sentiment"]) ?? "prefer",
    strength: typeof value.strength === "number" ? value.strength : 3,
    notes: typeof value.notes === "string" ? value.notes : null,
    source: text(value.source, FIXTURE_SOURCE),
    createdAt: text(value.createdAt, FIXTURE_TIMESTAMP),
    updatedAt: text(value.updatedAt, FIXTURE_TIMESTAMP),
  };
}

function toGoal(value: Record<string, unknown>, index: number): GoalMemory {
  return {
    id: text(value.id, `fixture-goal-${index}`),
    userId: text(value.userId, "eval-user"),
    goalType: (value.goalType as GoalMemory["goalType"]) ?? "other",
    description: text(value.description, `goal-${index}`),
    targetValue: typeof value.targetValue === "number" ? value.targetValue : null,
    targetUnit: typeof value.targetUnit === "string" ? value.targetUnit : null,
    priority: typeof value.priority === "number" ? value.priority : 1,
    active: value.active !== false,
    source: text(value.source, FIXTURE_SOURCE),
    createdAt: text(value.createdAt, FIXTURE_TIMESTAMP),
    updatedAt: text(value.updatedAt, FIXTURE_TIMESTAMP),
  };
}

function toSemanticMemory(value: Record<string, unknown>, index: number): SemanticMemory {
  return {
    id: text(value.id, `fixture-semantic-${index}`),
    namespaceType: value.namespaceType === "fridge" ? "fridge" : "user",
    namespaceId: text(value.namespaceId, "eval-user"),
    category: text(value.category, "general"),
    content: text(value.content, `semantic-${index}`),
    source: text(value.source, FIXTURE_SOURCE),
    confidence: typeof value.confidence === "number" ? value.confidence : 1,
    active: value.active !== false,
    createdAt: text(value.createdAt, FIXTURE_TIMESTAMP),
    updatedAt: text(value.updatedAt, FIXTURE_TIMESTAMP),
  };
}

function knowledgeToSemanticMemory(document: KnowledgeFixture): SemanticMemory {
  return {
    id: document.id,
    namespaceType: "user",
    namespaceId: "eval-user",
    category: document.tags[0] ?? "knowledge",
    content: `${document.title}: ${document.content}`,
    source: "knowledge_fixture",
    confidence: 1,
    active: true,
    createdAt: FIXTURE_TIMESTAMP,
    updatedAt: FIXTURE_TIMESTAMP,
  };
}

function seedStore(memories: MemoryFixture[], knowledgeDocuments: KnowledgeFixture[]): MemoryContext {
  const store: MemoryContext = {
    externalInventory: [],
    dietaryRestrictions: [],
    dietaryPreferences: [],
    activeGoals: [],
    semanticMemories: knowledgeDocuments.map(knowledgeToSemanticMemory),
  };

  memories.forEach((memory, index) => {
    const value = record(memory.value);
    if (memory.kind === "external_inventory") store.externalInventory.push(toExternalInventory(value, index));
    if (memory.kind === "dietary_restriction") store.dietaryRestrictions.push(toRestriction(value, index));
    if (memory.kind === "dietary_preference") store.dietaryPreferences.push(toPreference(value, index));
    if (memory.kind === "goal") store.activeGoals.push(toGoal(value, index));
    if (memory.kind === "semantic") store.semanticMemories.push(toSemanticMemory(value, index));
  });

  return store;
}

function snapshot(store: MemoryContext): MemoryContext {
  return structuredClone(store);
}

type PersistedWrite = { result: MemoryWriteResult; semanticMemory: SemanticMemory | null };

/**
 * Pure in-memory memory repository. Persisted validations mutate the internal
 * store so a subsequent loadMemoryContext (reload_memory_context) observes the
 * write, which is what the production verification step requires. Every
 * persisted write increments counters.memoryWrites exactly once; skipped and
 * rejected validations record nothing.
 *
 * Inventory consume/remove candidates raise the production
 * `inventory_mutation_review` interrupt so approval flows behave exactly like
 * the real persist path. Because the whole node re-executes after a resume,
 * store mutation and counting happen strictly after the interrupt returns.
 */
export function createFixtureMemoryAdapter(input: {
  memories: MemoryFixture[];
  knowledgeDocuments?: KnowledgeFixture[];
  log: FixtureSideEffectLog;
}): Pick<
  QueryGraphDependencies,
  "loadMemoryContext" | "persistMemoryValidations" | "indexSemanticMemory"
> {
  const { log } = input;
  const store = seedStore(input.memories, input.knowledgeDocuments ?? []);
  let writeSequence = 0;

  function persisted(input: {
    validation: MemoryValidationResult;
    targetId: string;
    message: string;
    semanticMemory?: SemanticMemory | null;
  }): PersistedWrite {
    log.counters.memoryWrites += 1;
    log.writes.push({
      kind: "memory",
      target: `${input.validation.candidate.kind}:${input.validation.candidate.action}:${memoryWriteSubject(input.validation.candidate)}:${input.targetId}`,
    });

    return {
      result: {
        kind: input.validation.candidate.kind,
        action: input.validation.candidate.action,
        status: "persisted",
        targetId: input.targetId,
        message: input.message,
      },
      semanticMemory: input.semanticMemory ?? null,
    };
  }

  function skipped(validation: MemoryValidationResult, message: string): PersistedWrite {
    return {
      result: {
        kind: validation.candidate.kind,
        action: validation.candidate.action,
        status: "skipped",
        targetId: null,
        message,
      },
      semanticMemory: null,
    };
  }

  function applyValidation(validation: MemoryValidationResult): PersistedWrite {
    if (!validation.accepted) {
      return skipped(validation, validation.reason);
    }

    const candidate = validation.candidate;
    writeSequence += 1;

    if (candidate.kind === "inventory_item") {
      if (candidate.action === "consume" || candidate.action === "remove") {
        const resumed = interrupt({
          type: "inventory_mutation_review",
          operation: candidate.action,
          itemName: candidate.name,
          storageLocation: candidate.storageLocation,
        });
        const parsedResume = QueryResumeSchema.safeParse(resumed);

        if (!parsedResume.success || !parsedResume.data.inventoryMutationReview?.approved) {
          return skipped(
            validation,
            `${candidate.action === "consume" ? "Consuming" : "Removing"} ${candidate.name} was not approved.`,
          );
        }

        const match = store.externalInventory.find(
          (item) =>
            item.name.toLowerCase() === candidate.name.toLowerCase() &&
            item.storageLocation === candidate.storageLocation,
        );
        store.externalInventory = store.externalInventory.filter((item) => item !== match);
        return persisted({
          validation,
          targetId: match?.id ?? `fixture-write-${writeSequence}`,
          message: `${candidate.action === "consume" ? "Consumed" : "Removed"} ${candidate.name} from the fixture inventory.`,
        });
      }

      const item = toExternalInventory(
        {
          id: `fixture-write-${writeSequence}`,
          name: candidate.name,
          storageLocation: candidate.storageLocation,
          quantity: candidate.quantity ?? null,
          notes: candidate.notes,
        },
        writeSequence,
      );
      store.externalInventory.push(item);
      return persisted({ validation, targetId: item.id, message: `Added ${candidate.name}.` });
    }

    if (candidate.kind === "dietary_restriction") {
      if (candidate.action === "remove") {
        const match = store.dietaryRestrictions.find(
          (memory) => memory.subject.toLowerCase() === candidate.subject.toLowerCase(),
        );
        store.dietaryRestrictions = store.dietaryRestrictions.filter((memory) => memory !== match);
        return persisted({
          validation,
          targetId: match?.id ?? `fixture-write-${writeSequence}`,
          message: `Removed the ${candidate.subject} restriction.`,
        });
      }

      const memory = toRestriction(
        {
          id: `fixture-write-${writeSequence}`,
          restrictionType: candidate.restrictionType,
          subject: candidate.subject,
          severity: candidate.severity,
          notes: candidate.notes,
        },
        writeSequence,
      );
      store.dietaryRestrictions = [
        ...store.dietaryRestrictions.filter(
          (existing) => existing.subject.toLowerCase() !== candidate.subject.toLowerCase(),
        ),
        memory,
      ];
      return persisted({ validation, targetId: memory.id, message: `Saved the ${candidate.subject} restriction.` });
    }

    if (candidate.kind === "preference") {
      if (candidate.action === "remove") {
        const match = store.dietaryPreferences.find(
          (memory) => memory.subject.toLowerCase() === candidate.subject.toLowerCase(),
        );
        store.dietaryPreferences = store.dietaryPreferences.filter((memory) => memory !== match);
        return persisted({
          validation,
          targetId: match?.id ?? `fixture-write-${writeSequence}`,
          message: `Removed the ${candidate.subject} preference.`,
        });
      }

      const memory = toPreference(
        {
          id: `fixture-write-${writeSequence}`,
          subject: candidate.subject,
          sentiment: candidate.sentiment,
          strength: candidate.strength,
          notes: candidate.notes,
        },
        writeSequence,
      );
      store.dietaryPreferences = [
        ...store.dietaryPreferences.filter(
          (existing) => existing.subject.toLowerCase() !== candidate.subject.toLowerCase(),
        ),
        memory,
      ];
      return persisted({ validation, targetId: memory.id, message: `Saved the ${candidate.subject} preference.` });
    }

    if (candidate.kind === "goal") {
      if (candidate.action === "deactivate") {
        const match = store.activeGoals.find((memory) => memory.goalType === candidate.goalType);
        store.activeGoals = store.activeGoals.filter((memory) => memory !== match);
        return persisted({
          validation,
          targetId: match?.id ?? `fixture-write-${writeSequence}`,
          message: `Deactivated the ${candidate.goalType} goal.`,
        });
      }

      const memory = toGoal(
        {
          id: `fixture-write-${writeSequence}`,
          goalType: candidate.goalType,
          description: candidate.description,
          targetValue: candidate.targetValue,
          targetUnit: candidate.targetUnit,
          priority: candidate.priority,
        },
        writeSequence,
      );
      store.activeGoals.push(memory);
      return persisted({ validation, targetId: memory.id, message: `Saved the ${candidate.goalType} goal.` });
    }

    // misc — persisted as a semantic memory and returned so the graph's
    // index_semantic_memory node indexes it.
    if (candidate.action === "remove") {
      const match = store.semanticMemories.find(
        (memory) => memory.category === candidate.category && memory.content === candidate.content,
      );
      store.semanticMemories = store.semanticMemories.filter((memory) => memory !== match);
      return persisted({
        validation,
        targetId: match?.id ?? `fixture-write-${writeSequence}`,
        message: `Removed the ${candidate.category} note.`,
      });
    }

    const memory = toSemanticMemory(
      {
        id: `fixture-write-${writeSequence}`,
        namespaceType: candidate.scope,
        category: candidate.category,
        content: candidate.content,
      },
      writeSequence,
    );
    store.semanticMemories.push(memory);
    return persisted({
      validation,
      targetId: memory.id,
      message: `Saved the ${candidate.category} note.`,
      semanticMemory: memory,
    });
  }

  return {
    loadMemoryContext: () => snapshot(store),
    persistMemoryValidations: async ({ validations }) => validations.map(applyValidation),
    indexSemanticMemory: async (memory) => {
      log.counters.semanticMemoryIndexWrites += 1;
      log.writes.push({ kind: "semantic_memory_index", target: memory.id });
    },
  };
}

function memoryWriteSubject(candidate: MemoryValidationResult["candidate"]) {
  if (candidate.kind === "inventory_item") return candidate.name;
  if (candidate.kind === "dietary_restriction" || candidate.kind === "preference") return candidate.subject;
  if (candidate.kind === "goal") return candidate.description;
  return candidate.content;
}
