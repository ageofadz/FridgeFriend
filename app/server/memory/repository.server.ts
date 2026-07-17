import { randomUUID } from "node:crypto";

import { and, eq, inArray, or } from "drizzle-orm";

import {
  dietaryPreferences,
  dietaryRestrictions,
  externalInventoryItems,
  fridgeMemberships,
  fridges,
  goals,
  memories,
  users,
} from "../db/schema.server";
import {
  DEFAULT_FRIDGE_ID,
  DEFAULT_USER_ID,
  withDatabase,
} from "../sqlite.server";
import {
  DietaryPreferenceCandidateSchema,
  DietaryRestrictionCandidateSchema,
  GoalCandidateSchema,
  StorageLocationSchema,
  type DietaryPreferenceMemory,
  type DietaryRestrictionMemory,
  type ExternalInventoryMemory,
  type GoalMemory,
  type MemoryCandidate,
  type MemoryContext,
  type MemoryValidationResult,
  type MemoryWriteResult,
  type Quantity,
  type SemanticMemory,
  type StorageLocation,
} from "./schemas";

export const HOUSEHOLD_INVENTORY_LIST_FIELDS = [
  "id",
  "fridgeId",
  "name",
  "canonicalName",
  "storageLocation",
  "quantity",
  "status",
  "confidence",
  "source",
  "notes",
  "expirationDate",
  "expirationDateSource",
  "lastConfirmedAt",
  "createdAt",
  "updatedAt",
] as const;

export type HouseholdInventoryListField = typeof HOUSEHOLD_INVENTORY_LIST_FIELDS[number];

export const HOUSEHOLD_INVENTORY_STATUSES = [
  "available",
  "possibly_available",
  "consumed",
  "removed",
] as const;

export type HouseholdInventoryStatus = typeof HOUSEHOLD_INVENTORY_STATUSES[number];

export type MemoryProfile = {
  userId: string;
  fridgeId: string;
};

export type HouseholdInventoryOperation =
  | {
    operation: "list";
    storageLocation?: StorageLocation;
    storageLocations?: StorageLocation[];
    ids?: string[];
    names?: string[];
    search?: string;
    statuses?: HouseholdInventoryStatus[];
    hasQuantity?: boolean;
    hasNotes?: boolean;
    expiringBefore?: string;
    fields?: HouseholdInventoryListField[];
    limit?: number;
    sortBy?: "name" | "storageLocation" | "updatedAt" | "expirationDate";
    sortDirection?: "asc" | "desc";
  }
  | {
    operation: "add";
    name: string;
    storageLocation: StorageLocation;
    quantity: Quantity | null;
    notes: string | null;
  }
  | {
    operation: "update";
    id?: string;
    name?: string;
    storageLocation?: StorageLocation;
    newName?: string;
    newStorageLocation?: StorageLocation;
    quantity?: Quantity | null;
    notes?: string | null;
  }
  | {
    operation: "consume" | "remove";
    id?: string;
    name?: string;
    storageLocation?: StorageLocation;
  };

export type HouseholdInventoryOperationResult = {
  operation: HouseholdInventoryOperation["operation"] | "invalid";
  status: "ok" | "invalid" | "not_found";
  message: string;
  item: ExternalInventoryMemory | null;
  items: Array<Partial<ExternalInventoryMemory> & { id: string }>;
};

export function normalizeMemoryKey(value: string) {
  return value
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function scopedKey(...parts: string[]) {
  return parts.map((part) => normalizeMemoryKey(part)).join(":");
}

function createRowId(prefix: string) {
  return `${prefix}:${randomUUID()}`;
}

function nowIso() {
  return new Date().toISOString();
}

function assertStatus(
  value: string,
): ExternalInventoryMemory["status"] {
  if (
    value === "available" ||
    value === "possibly_available" ||
    value === "consumed" ||
    value === "removed"
  ) {
    return value;
  }

  throw new Error(`Stored external inventory status is invalid: ${value}`);
}

function quantityFromRow(row: typeof externalInventoryItems.$inferSelect) {
  if (
    row.quantityAmount === null &&
    row.quantityUnit === null &&
    row.quantityPrecision === null
  ) {
    return null;
  }

  if (row.quantityUnit === null || row.quantityPrecision === null) {
    throw new Error(`Stored external inventory quantity is incomplete: ${row.id}`);
  }

  if (
    row.quantityPrecision !== "exact" &&
    row.quantityPrecision !== "estimated" &&
    row.quantityPrecision !== "unknown"
  ) {
    throw new Error(
      `Stored external inventory quantity precision is invalid: ${row.quantityPrecision}`,
    );
  }

  return {
    amount: row.quantityAmount,
    unit: row.quantityUnit,
    precision: row.quantityPrecision,
  } satisfies Quantity;
}

function externalInventoryFromRow(
  row: typeof externalInventoryItems.$inferSelect,
): ExternalInventoryMemory {
  return {
    id: row.id,
    fridgeId: row.fridgeId,
    name: row.name,
    canonicalName: row.canonicalName,
    storageLocation: StorageLocationSchema.parse(row.storageLocation),
    quantity: quantityFromRow(row),
    status: assertStatus(row.status),
    confidence: row.confidence,
    source: row.source,
    notes: row.notes,
    expirationDate: row.expirationDate,
    expirationDateSource: row.expirationDateSource === "user" || row.expirationDateSource === "observed"
      ? row.expirationDateSource
      : null,
    lastConfirmedAt: row.lastConfirmedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function restrictionFromRow(
  row: typeof dietaryRestrictions.$inferSelect,
): DietaryRestrictionMemory {
  const parsed = DietaryRestrictionCandidateSchema.omit({
    kind: true,
    scope: true,
    action: true,
    explicit: true,
  }).parse({
    restrictionType: row.restrictionType,
    subject: row.subject,
    severity: row.severity,
    notes: row.notes,
  });

  return {
    id: row.id,
    userId: row.userId,
    restrictionType: parsed.restrictionType,
    subject: parsed.subject,
    severity: parsed.severity,
    notes: parsed.notes,
    source: row.source,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function preferenceFromRow(
  row: typeof dietaryPreferences.$inferSelect,
): DietaryPreferenceMemory {
  const parsed = DietaryPreferenceCandidateSchema.omit({
    kind: true,
    scope: true,
    action: true,
    explicit: true,
  }).parse({
    subject: row.subject,
    sentiment: row.sentiment,
    strength: row.strength,
    notes: row.notes,
  });

  return {
    id: row.id,
    userId: row.userId,
    subject: parsed.subject,
    sentiment: parsed.sentiment,
    strength: parsed.strength,
    notes: parsed.notes,
    source: row.source,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function goalFromRow(row: typeof goals.$inferSelect): GoalMemory {
  const parsed = GoalCandidateSchema.omit({
    kind: true,
    scope: true,
    action: true,
    explicit: true,
  }).parse({
    goalType: row.goalType,
    description: row.description,
    targetValue: row.targetValue,
    targetUnit: row.targetUnit,
    priority: row.priority,
  });

  return {
    id: row.id,
    userId: row.userId,
    goalType: parsed.goalType,
    description: parsed.description,
    targetValue: parsed.targetValue,
    targetUnit: parsed.targetUnit,
    priority: parsed.priority,
    active: row.active === 1,
    source: row.source,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function semanticMemoryFromRow(row: typeof memories.$inferSelect): SemanticMemory {
  if (row.namespaceType !== "user" && row.namespaceType !== "fridge") {
    throw new Error(`Stored memory namespace type is invalid: ${row.namespaceType}`);
  }

  return {
    id: row.id,
    namespaceType: row.namespaceType,
    namespaceId: row.namespaceId,
    category: row.category,
    content: row.content,
    source: row.source,
    confidence: row.confidence,
    active: row.active === 1,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function ensureMemoryProfile(input: Partial<MemoryProfile> = {}) {
  const profile = {
    userId: input.userId?.trim() || DEFAULT_USER_ID,
    fridgeId: input.fridgeId?.trim() || DEFAULT_FRIDGE_ID,
  };

  return withDatabase((db) => {
    const now = nowIso();

    db.insert(users)
      .values({
        id: profile.userId,
        createdAt: now,
      })
      .onConflictDoNothing()
      .run();

    db.insert(fridges)
      .values({
        id: profile.fridgeId,
        name: profile.fridgeId === DEFAULT_FRIDGE_ID ? "Default Fridge" : profile.fridgeId,
        createdAt: now,
      })
      .onConflictDoNothing()
      .run();

    db.insert(fridgeMemberships)
      .values({
        fridgeId: profile.fridgeId,
        userId: profile.userId,
        role: "owner",
      })
      .onConflictDoUpdate({
        target: [fridgeMemberships.fridgeId, fridgeMemberships.userId],
        set: {
          role: "owner",
        },
      })
      .run();

    return profile;
  });
}

export function listStructuredMemoryContext(input: MemoryProfile): Omit<
  MemoryContext,
  "semanticMemories"
> {
  const profile = ensureMemoryProfile(input);

  return withDatabase((db) => {
    const inventory = db
      .select()
      .from(externalInventoryItems)
      .where(eq(externalInventoryItems.fridgeId, profile.fridgeId))
      .all()
      .map(externalInventoryFromRow)
      .filter((item) =>
        item.status === "available" || item.status === "possibly_available"
      );

    const restrictions = db
      .select()
      .from(dietaryRestrictions)
      .where(eq(dietaryRestrictions.userId, profile.userId))
      .all()
      .map(restrictionFromRow);

    const preferences = db
      .select()
      .from(dietaryPreferences)
      .where(eq(dietaryPreferences.userId, profile.userId))
      .all()
      .map(preferenceFromRow);

    const activeGoals = db
      .select()
      .from(goals)
      .where(and(eq(goals.userId, profile.userId), eq(goals.active, 1)))
      .all()
      .map(goalFromRow);

    return {
      externalInventory: inventory,
      dietaryRestrictions: restrictions,
      dietaryPreferences: preferences,
      activeGoals,
    };
  });
}

export function listUserSemanticMemories(input: MemoryProfile): SemanticMemory[] {
  const profile = ensureMemoryProfile(input);

  return withDatabase((db) =>
    db
      .select()
      .from(memories)
      .where(
        and(
          eq(memories.namespaceType, "user"),
          eq(memories.namespaceId, profile.userId),
          eq(memories.active, 1),
        ),
      )
      .all()
      .map(semanticMemoryFromRow)
  );
}

export function hasActiveSemanticMemories(input: MemoryProfile) {
  const profile = ensureMemoryProfile(input);

  return withDatabase((db) =>
    db
      .select({ id: memories.id })
      .from(memories)
      .where(
        and(
          eq(memories.active, 1),
          or(
            and(eq(memories.namespaceType, "user"), eq(memories.namespaceId, profile.userId)),
            and(eq(memories.namespaceType, "fridge"), eq(memories.namespaceId, profile.fridgeId)),
          ),
        ),
      )
      .limit(1)
      .get() !== undefined,
  );
}

export function resetUserProfileMemories(input: MemoryProfile) {
  const profile = ensureMemoryProfile(input);

  return withDatabase((db) => {
    db.delete(dietaryRestrictions)
      .where(eq(dietaryRestrictions.userId, profile.userId))
      .run();

    db.delete(dietaryPreferences)
      .where(eq(dietaryPreferences.userId, profile.userId))
      .run();

    db.delete(goals)
      .where(eq(goals.userId, profile.userId))
      .run();

    db.delete(memories)
      .where(
        and(
          eq(memories.namespaceType, "user"),
          eq(memories.namespaceId, profile.userId),
        ),
      )
      .run();
  });
}

function householdInventoryResult(
  operation: HouseholdInventoryOperationResult["operation"],
  status: HouseholdInventoryOperationResult["status"],
  message: string,
  item: ExternalInventoryMemory | null = null,
  items: Array<Partial<ExternalInventoryMemory> & { id: string }> = [],
): HouseholdInventoryOperationResult {
  return {
    operation,
    status,
    message,
    item,
    items,
  };
}

function activeInventoryStatuses() {
  return new Set<HouseholdInventoryStatus>(["available", "possibly_available"]);
}

function normalizeListFieldSet(fields: HouseholdInventoryListField[] | undefined) {
  if (!fields || fields.length === 0) {
    return null;
  }

  return new Set<HouseholdInventoryListField>(["id", ...fields]);
}

function projectInventoryItem(
  item: ExternalInventoryMemory,
  fields: Set<HouseholdInventoryListField> | null,
) {
  if (!fields) {
    return item;
  }

  return HOUSEHOLD_INVENTORY_LIST_FIELDS.reduce<Partial<ExternalInventoryMemory> & { id: string }>(
    (projected, field) => {
      if (fields.has(field)) {
        projected[field] = item[field] as never;
      }

      return projected;
    },
    { id: item.id },
  );
}

function compareNullableText(left: string | null, right: string | null) {
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return left.localeCompare(right);
}

function inventorySelectorMessage(operation: HouseholdInventoryOperation["operation"]) {
  return `${operation} requires an item id or both name and storageLocation`;
}

export function manageHouseholdInventory(input: {
  fridgeId: string;
  operation: HouseholdInventoryOperation;
  source?: string;
}): HouseholdInventoryOperationResult {
  const fridgeId = input.fridgeId.trim();

  if (fridgeId.length === 0) {
    throw new Error("Household inventory requires a non-empty fridge ID");
  }

  ensureMemoryProfile({ fridgeId });

  return withDatabase((db) => {
    const operation = input.operation;

    if (operation.operation === "list") {
      const storageLocations = new Set([
        ...(operation.storageLocation ? [operation.storageLocation] : []),
        ...(operation.storageLocations ?? []),
      ]);
      const ids = new Set(operation.ids ?? []);
      const names = new Set((operation.names ?? []).map(normalizeMemoryKey));
      const statuses = operation.statuses && operation.statuses.length > 0
        ? new Set(operation.statuses)
        : activeInventoryStatuses();
      const search = operation.search ? normalizeMemoryKey(operation.search) : null;
      const fields = normalizeListFieldSet(operation.fields);
      const sortBy = operation.sortBy ?? "name";
      const sortDirection = operation.sortDirection ?? "asc";
      const rows = db
        .select()
        .from(externalInventoryItems)
        .where(eq(externalInventoryItems.fridgeId, fridgeId))
        .all()
        .map(externalInventoryFromRow)
        .filter((item) => {
          const canonicalName = item.canonicalName ?? normalizeMemoryKey(item.name);
          const expirationDate = item.expirationDate ?? null;

          return statuses.has(item.status) &&
            (storageLocations.size === 0 || storageLocations.has(item.storageLocation)) &&
            (ids.size === 0 || ids.has(item.id)) &&
            (names.size === 0 || names.has(canonicalName)) &&
            (search === null ||
              canonicalName.includes(search) ||
              normalizeMemoryKey(item.name).includes(search) ||
              normalizeMemoryKey(item.notes ?? "").includes(search)) &&
            (operation.hasQuantity === undefined ||
              (operation.hasQuantity ? item.quantity !== null : item.quantity === null)) &&
            (operation.hasNotes === undefined ||
              (operation.hasNotes ? item.notes !== null : item.notes === null)) &&
            (operation.expiringBefore === undefined ||
              (expirationDate !== null && expirationDate <= operation.expiringBefore));
        })
        .sort((left, right) => {
          const direction = sortDirection === "asc" ? 1 : -1;
          const primary = sortBy === "storageLocation"
            ? left.storageLocation.localeCompare(right.storageLocation)
            : sortBy === "updatedAt"
            ? left.updatedAt.localeCompare(right.updatedAt)
            : sortBy === "expirationDate"
            ? compareNullableText(left.expirationDate ?? null, right.expirationDate ?? null)
            : left.name.localeCompare(right.name);
          return (primary || left.name.localeCompare(right.name) || left.id.localeCompare(right.id)) * direction;
        })
        .slice(0, operation.limit ?? Number.MAX_SAFE_INTEGER)
        .map((item) => projectInventoryItem(item, fields));

      return householdInventoryResult(
        "list",
        "ok",
        `Listed ${rows.length} household inventory item${rows.length === 1 ? "" : "s"}`,
        null,
        rows,
      );
    }

    const now = nowIso();
    const source = input.source ?? "agent_tool";

    if (operation.operation === "add") {
      const name = operation.name.trim();
      const normalizedKey = scopedKey("inventory", operation.storageLocation, name);
      const existing = db
        .select()
        .from(externalInventoryItems)
        .where(
          and(
            eq(externalInventoryItems.fridgeId, fridgeId),
            eq(externalInventoryItems.normalizedKey, normalizedKey),
          ),
        )
        .get();
      const row = {
        id: existing?.id ?? createRowId("external-inventory"),
        fridgeId,
        name,
        canonicalName: normalizeMemoryKey(name),
        storageLocation: operation.storageLocation,
        quantityAmount: operation.quantity?.amount ?? null,
        quantityUnit: operation.quantity?.unit ?? null,
        quantityPrecision: operation.quantity?.precision ?? null,
        status: "available" as const,
        confidence: 1,
        source,
        notes: operation.notes,
        expirationDate: existing?.expirationDate ?? null,
        expirationDateSource: existing?.expirationDateSource ?? null,
        normalizedKey,
        lastConfirmedAt: now,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };

      db.insert(externalInventoryItems)
        .values(row)
        .onConflictDoUpdate({
          target: [
            externalInventoryItems.fridgeId,
            externalInventoryItems.normalizedKey,
          ],
          set: {
            name: row.name,
            canonicalName: row.canonicalName,
            storageLocation: row.storageLocation,
            quantityAmount: row.quantityAmount,
            quantityUnit: row.quantityUnit,
            quantityPrecision: row.quantityPrecision,
            status: row.status,
            confidence: row.confidence,
            source: row.source,
            notes: row.notes,
            expirationDate: row.expirationDate,
            expirationDateSource: row.expirationDateSource,
            lastConfirmedAt: row.lastConfirmedAt,
            updatedAt: row.updatedAt,
          },
        })
        .run();

      return householdInventoryResult(
        "add",
        "ok",
        existing ? "Updated household inventory item" : "Added household inventory item",
        externalInventoryFromRow(row),
      );
    }

    const byId = operation.id?.trim();
    const byName = operation.name?.trim();

    if (!byId && (!byName || !operation.storageLocation)) {
      return householdInventoryResult(
        operation.operation,
        "invalid",
        inventorySelectorMessage(operation.operation),
      );
    }

    const existing = byId
      ? db
        .select()
        .from(externalInventoryItems)
        .where(
          and(
            eq(externalInventoryItems.fridgeId, fridgeId),
            eq(externalInventoryItems.id, byId),
          ),
        )
        .get()
      : db
        .select()
        .from(externalInventoryItems)
        .where(
          and(
            eq(externalInventoryItems.fridgeId, fridgeId),
            eq(
              externalInventoryItems.normalizedKey,
              scopedKey("inventory", operation.storageLocation!, byName!),
            ),
          ),
        )
        .get();

    if (!existing) {
      const identifier = byId ? `id ${byId}` : `${byName} in ${operation.storageLocation}`;

      return householdInventoryResult(
        operation.operation,
        "not_found",
        `No household inventory item matched ${identifier}`,
      );
    }

    if (operation.operation === "consume" || operation.operation === "remove") {
      const status = operation.operation === "consume" ? "consumed" : "removed";

      db.update(externalInventoryItems)
        .set({
          status,
          updatedAt: now,
        })
        .where(eq(externalInventoryItems.id, existing.id))
        .run();

      return householdInventoryResult(
        operation.operation,
        "ok",
        operation.operation === "consume"
          ? "Marked household inventory item as consumed"
          : "Removed household inventory item",
        externalInventoryFromRow({
          ...existing,
          status,
          updatedAt: now,
        }),
      );
    }

    const updateOperation = operation as Extract<
      HouseholdInventoryOperation,
      { operation: "update" }
    >;
    const name = updateOperation.newName?.trim() || existing.name;
    const storageLocation =
      updateOperation.newStorageLocation ?? existing.storageLocation;
    const normalizedKey = scopedKey("inventory", storageLocation, name);
    const conflict = db
      .select()
      .from(externalInventoryItems)
      .where(
        and(
          eq(externalInventoryItems.fridgeId, fridgeId),
          eq(externalInventoryItems.normalizedKey, normalizedKey),
        ),
      )
      .get();

    if (conflict && conflict.id !== existing.id) {
      return householdInventoryResult(
        "update",
        "invalid",
        `A household inventory item named ${name} already exists in ${storageLocation}`,
      );
    }

    const row = {
      ...existing,
      name,
      canonicalName: normalizeMemoryKey(name),
      storageLocation,
      quantityAmount:
        updateOperation.quantity === undefined
          ? existing.quantityAmount
          : updateOperation.quantity?.amount ?? null,
      quantityUnit:
        updateOperation.quantity === undefined
          ? existing.quantityUnit
          : updateOperation.quantity?.unit ?? null,
      quantityPrecision:
        updateOperation.quantity === undefined
          ? existing.quantityPrecision
          : updateOperation.quantity?.precision ?? null,
      status: "available" as const,
      confidence: 1,
      source,
      notes:
        updateOperation.notes === undefined ? existing.notes : updateOperation.notes,
      normalizedKey,
      lastConfirmedAt: now,
      updatedAt: now,
    };

    db.update(externalInventoryItems)
      .set({
        name: row.name,
        canonicalName: row.canonicalName,
        storageLocation: row.storageLocation,
        quantityAmount: row.quantityAmount,
        quantityUnit: row.quantityUnit,
        quantityPrecision: row.quantityPrecision,
        status: row.status,
        confidence: row.confidence,
        source: row.source,
        notes: row.notes,
        normalizedKey: row.normalizedKey,
        lastConfirmedAt: row.lastConfirmedAt,
        updatedAt: row.updatedAt,
      })
      .where(eq(externalInventoryItems.id, existing.id))
      .run();

    return householdInventoryResult(
      "update",
      "ok",
      "Updated household inventory item",
      externalInventoryFromRow(row),
    );
  });
}

export function listSemanticMemoriesByIds(ids: string[]) {
  if (ids.length === 0) {
    return [];
  }

  return withDatabase((db) => {
    const rows = db
      .select()
      .from(memories)
      .where(inArray(memories.id, ids))
      .all()
      .map(semanticMemoryFromRow)
      .filter((memory) => memory.active);
    const byId = new Map(rows.map((row) => [row.id, row]));

    return ids.flatMap((id) => {
      const row = byId.get(id);
      return row ? [row] : [];
    });
  });
}

export function listMemoryContext(input: MemoryProfile & {
  semanticMemories?: SemanticMemory[];
}): MemoryContext {
  return {
    ...listStructuredMemoryContext(input),
    semanticMemories: input.semanticMemories ?? [],
  };
}

export function validateMemoryCandidate(
  candidate: MemoryCandidate,
): MemoryValidationResult {
  if (!candidate.explicit) {
    return {
      candidate,
      accepted: false,
      reason: "Candidate was not an explicit user claim",
    };
  }

  if (candidate.kind === "inventory_item" && candidate.name.trim().length === 0) {
    return {
      candidate,
      accepted: false,
      reason: "Inventory item name was empty",
    };
  }

  if (
    candidate.kind === "dietary_restriction" &&
    candidate.subject.trim().length === 0
  ) {
    return {
      candidate,
      accepted: false,
      reason: "Dietary restriction subject was empty",
    };
  }

  if (candidate.kind === "preference" && candidate.subject.trim().length === 0) {
    return {
      candidate,
      accepted: false,
      reason: "Preference subject was empty",
    };
  }

  if (candidate.kind === "goal" && candidate.description.trim().length === 0) {
    return {
      candidate,
      accepted: false,
      reason: "Goal description was empty",
    };
  }

  if (candidate.kind === "misc" && candidate.content.trim().length === 0) {
    return {
      candidate,
      accepted: false,
      reason: "Memory content was empty",
    };
  }

  return {
    candidate,
    accepted: true,
    reason: "Accepted explicit memory candidate",
  };
}

function writeResult(
  candidate: MemoryCandidate,
  status: MemoryWriteResult["status"],
  targetId: string | null,
  message: string,
): MemoryWriteResult {
  return {
    kind: candidate.kind,
    action: candidate.action,
    status,
    targetId,
    message,
  };
}

export function applyMemoryCandidate(input: {
  profile: MemoryProfile;
  validation: MemoryValidationResult;
}): {
  result: MemoryWriteResult;
  semanticMemory: SemanticMemory | null;
} {
  if (!input.validation.accepted) {
    return {
      result: writeResult(
        input.validation.candidate,
        "skipped",
        null,
        input.validation.reason,
      ),
      semanticMemory: null,
    };
  }

  const profile = ensureMemoryProfile(input.profile);
  const candidate = input.validation.candidate;

  return withDatabase((db) => {
    const now = nowIso();

    if (candidate.kind === "inventory_item") {
      const normalizedKey = scopedKey(
        "inventory",
        candidate.storageLocation,
        candidate.name,
      );
      const existing = db
        .select()
        .from(externalInventoryItems)
        .where(
          and(
            eq(externalInventoryItems.fridgeId, profile.fridgeId),
            eq(externalInventoryItems.normalizedKey, normalizedKey),
          ),
        )
        .get();

      if (candidate.action === "remove" || candidate.action === "consume") {
        if (!existing) {
          return {
            result: writeResult(
              candidate,
              "skipped",
              null,
              `No external inventory item matched ${candidate.name}`,
            ),
            semanticMemory: null,
          };
        }

        const status = candidate.action === "remove" ? "removed" : "consumed";

        db.update(externalInventoryItems)
          .set({
            status,
            updatedAt: now,
          })
          .where(eq(externalInventoryItems.id, existing.id))
          .run();

        return {
          result: writeResult(candidate, "persisted", existing.id, status),
          semanticMemory: null,
        };
      }

      const row = {
        id: existing?.id ?? createRowId("external-inventory"),
        fridgeId: profile.fridgeId,
        name: candidate.name.trim(),
        canonicalName: normalizeMemoryKey(candidate.name),
        storageLocation: candidate.storageLocation,
        quantityAmount: candidate.quantity?.amount ?? null,
        quantityUnit: candidate.quantity?.unit ?? null,
        quantityPrecision: candidate.quantity?.precision ?? null,
        status: "available",
        confidence: 1,
        source: "user_explicit",
        notes: candidate.notes,
        normalizedKey,
        lastConfirmedAt: now,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };

      db.insert(externalInventoryItems)
        .values(row)
        .onConflictDoUpdate({
          target: [
            externalInventoryItems.fridgeId,
            externalInventoryItems.normalizedKey,
          ],
          set: {
            name: row.name,
            canonicalName: row.canonicalName,
            storageLocation: row.storageLocation,
            quantityAmount: row.quantityAmount,
            quantityUnit: row.quantityUnit,
            quantityPrecision: row.quantityPrecision,
            status: row.status,
            confidence: row.confidence,
            source: row.source,
            notes: row.notes,
            lastConfirmedAt: row.lastConfirmedAt,
            updatedAt: row.updatedAt,
          },
        })
        .run();

      return {
        result: writeResult(candidate, "persisted", row.id, "Saved inventory item"),
        semanticMemory: null,
      };
    }

    if (candidate.kind === "dietary_restriction") {
      const normalizedKey = scopedKey(
        "restriction",
        candidate.restrictionType,
        candidate.subject,
      );
      const existing = db
        .select()
        .from(dietaryRestrictions)
        .where(
          and(
            eq(dietaryRestrictions.userId, profile.userId),
            eq(dietaryRestrictions.normalizedKey, normalizedKey),
          ),
        )
        .get();

      if (candidate.action === "remove") {
        if (!existing) {
          return {
            result: writeResult(
              candidate,
              "skipped",
              null,
              `No dietary restriction matched ${candidate.subject}`,
            ),
            semanticMemory: null,
          };
        }

        db.delete(dietaryRestrictions)
          .where(eq(dietaryRestrictions.id, existing.id))
          .run();

        return {
          result: writeResult(candidate, "persisted", existing.id, "Removed restriction"),
          semanticMemory: null,
        };
      }

      const row = {
        id: existing?.id ?? createRowId("dietary-restriction"),
        userId: profile.userId,
        restrictionType: candidate.restrictionType,
        subject: candidate.subject.trim(),
        severity: candidate.severity,
        notes: candidate.notes,
        source: "user_explicit",
        normalizedKey,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };

      db.insert(dietaryRestrictions)
        .values(row)
        .onConflictDoUpdate({
          target: [
            dietaryRestrictions.userId,
            dietaryRestrictions.normalizedKey,
          ],
          set: {
            restrictionType: row.restrictionType,
            subject: row.subject,
            severity: row.severity,
            notes: row.notes,
            source: row.source,
            updatedAt: row.updatedAt,
          },
        })
        .run();

      return {
        result: writeResult(candidate, "persisted", row.id, "Saved dietary restriction"),
        semanticMemory: null,
      };
    }

    if (candidate.kind === "preference") {
      const normalizedKey = scopedKey(
        "preference",
        candidate.sentiment,
        candidate.subject,
      );
      const existing = db
        .select()
        .from(dietaryPreferences)
        .where(
          and(
            eq(dietaryPreferences.userId, profile.userId),
            eq(dietaryPreferences.normalizedKey, normalizedKey),
          ),
        )
        .get();

      if (candidate.action === "remove") {
        if (!existing) {
          return {
            result: writeResult(
              candidate,
              "skipped",
              null,
              `No dietary preference matched ${candidate.subject}`,
            ),
            semanticMemory: null,
          };
        }

        db.delete(dietaryPreferences)
          .where(eq(dietaryPreferences.id, existing.id))
          .run();

        return {
          result: writeResult(candidate, "persisted", existing.id, "Removed preference"),
          semanticMemory: null,
        };
      }

      const row = {
        id: existing?.id ?? createRowId("dietary-preference"),
        userId: profile.userId,
        subject: candidate.subject.trim(),
        sentiment: candidate.sentiment,
        strength: candidate.strength,
        notes: candidate.notes,
        source: "user_explicit",
        normalizedKey,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };

      db.insert(dietaryPreferences)
        .values(row)
        .onConflictDoUpdate({
          target: [
            dietaryPreferences.userId,
            dietaryPreferences.normalizedKey,
          ],
          set: {
            subject: row.subject,
            sentiment: row.sentiment,
            strength: row.strength,
            notes: row.notes,
            source: row.source,
            updatedAt: row.updatedAt,
          },
        })
        .run();

      return {
        result: writeResult(candidate, "persisted", row.id, "Saved preference"),
        semanticMemory: null,
      };
    }

    if (candidate.kind === "goal") {
      const normalizedKey = scopedKey("goal", candidate.goalType, candidate.description);
      const existing = db
        .select()
        .from(goals)
        .where(
          and(
            eq(goals.userId, profile.userId),
            eq(goals.normalizedKey, normalizedKey),
          ),
        )
        .get();

      if (candidate.action === "deactivate") {
        if (!existing) {
          return {
            result: writeResult(
              candidate,
              "skipped",
              null,
              `No active goal matched ${candidate.description}`,
            ),
            semanticMemory: null,
          };
        }

        db.update(goals)
          .set({
            active: 0,
            updatedAt: now,
          })
          .where(eq(goals.id, existing.id))
          .run();

        return {
          result: writeResult(candidate, "persisted", existing.id, "Deactivated goal"),
          semanticMemory: null,
        };
      }

      const row = {
        id: existing?.id ?? createRowId("goal"),
        userId: profile.userId,
        goalType: candidate.goalType,
        description: candidate.description.trim(),
        targetValue: candidate.targetValue,
        targetUnit: candidate.targetUnit,
        priority: candidate.priority,
        active: 1,
        source: "user_explicit",
        normalizedKey,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };

      db.insert(goals)
        .values(row)
        .onConflictDoUpdate({
          target: [goals.userId, goals.normalizedKey],
          set: {
            goalType: row.goalType,
            description: row.description,
            targetValue: row.targetValue,
            targetUnit: row.targetUnit,
            priority: row.priority,
            active: row.active,
            source: row.source,
            updatedAt: row.updatedAt,
          },
        })
        .run();

      return {
        result: writeResult(candidate, "persisted", row.id, "Saved goal"),
        semanticMemory: null,
      };
    }

    const namespaceId = candidate.scope === "user" ? profile.userId : profile.fridgeId;
    const normalizedKey = scopedKey("memory", candidate.category, candidate.content);
    const existing = db
      .select()
      .from(memories)
      .where(
        and(
          eq(memories.namespaceType, candidate.scope),
          eq(memories.namespaceId, namespaceId),
          eq(memories.normalizedKey, normalizedKey),
        ),
      )
      .get();

    if (candidate.action === "remove") {
      if (!existing) {
        return {
          result: writeResult(
            candidate,
            "skipped",
            null,
            `No semantic memory matched ${candidate.content}`,
          ),
          semanticMemory: null,
        };
      }

      db.update(memories)
        .set({
          active: 0,
          updatedAt: now,
        })
        .where(eq(memories.id, existing.id))
        .run();

      return {
        result: writeResult(candidate, "persisted", existing.id, "Removed semantic memory"),
        semanticMemory: semanticMemoryFromRow({
          ...existing,
          active: 0,
          updatedAt: now,
        }),
      };
    }

    const row = {
      id: existing?.id ?? createRowId("memory"),
      namespaceType: candidate.scope,
      namespaceId,
      category: candidate.category.trim(),
      content: candidate.content.trim(),
      normalizedKey,
      source: "user_explicit",
      confidence: 1,
      active: 1,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    db.insert(memories)
      .values(row)
      .onConflictDoUpdate({
        target: [
          memories.namespaceType,
          memories.namespaceId,
          memories.normalizedKey,
        ],
        set: {
          category: row.category,
          content: row.content,
          source: row.source,
          confidence: row.confidence,
          active: row.active,
          updatedAt: row.updatedAt,
        },
      })
      .run();

    return {
      result: writeResult(candidate, "persisted", row.id, "Saved semantic memory"),
      semanticMemory: semanticMemoryFromRow(row),
    };
  });
}
