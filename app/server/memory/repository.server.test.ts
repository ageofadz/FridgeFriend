import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  externalInventoryItems,
  fridgeMemberships,
  fridges,
  users,
} from "../db/schema.server";
import {
  DEFAULT_FRIDGE_ID,
  DEFAULT_USER_ID,
  bootstrapSqlite,
  withDatabase,
} from "../sqlite.server";
import {
  applyMemoryCandidate,
  ensureMemoryProfile,
  listStructuredMemoryContext,
  validateMemoryCandidate,
} from "./repository.server";
import type { MemoryCandidate } from "./schemas";

function setTestDatabase() {
  const databasePath = path.join(
    tmpdir(),
    `fridgefriend-memory-test-${randomUUID()}.sqlite`,
  );
  process.env.DATABASE_PATH = databasePath;
  return databasePath;
}

function removeTestDatabase(databasePath: string) {
  rmSync(databasePath, { force: true });
  rmSync(`${databasePath}-wal`, { force: true });
  rmSync(`${databasePath}-shm`, { force: true });
  delete process.env.DATABASE_PATH;
}

function persist(candidate: MemoryCandidate) {
  return applyMemoryCandidate({
    profile: {
      userId: DEFAULT_USER_ID,
      fridgeId: DEFAULT_FRIDGE_ID,
    },
    validation: validateMemoryCandidate(candidate),
  });
}

describe("memory repository", () => {
  let databasePath: string;

  beforeEach(() => {
    databasePath = setTestDatabase();
  });

  afterEach(() => {
    removeTestDatabase(databasePath);
  });

  it("bootstraps default user, fridge, and membership rows", () => {
    const bootstrap = bootstrapSqlite();

    expect(bootstrap.tables).toContain("users");
    expect(bootstrap.tables).toContain("fridges");
    expect(bootstrap.tables).toContain("fridge_memberships");

    withDatabase((db) => {
      expect(
        db.select().from(users).where(eq(users.id, DEFAULT_USER_ID)).get(),
      ).toMatchObject({ id: DEFAULT_USER_ID });
      expect(
        db.select().from(fridges).where(eq(fridges.id, DEFAULT_FRIDGE_ID)).get(),
      ).toMatchObject({ id: DEFAULT_FRIDGE_ID });
      expect(db.select().from(fridgeMemberships).get()).toMatchObject({
        userId: DEFAULT_USER_ID,
        fridgeId: DEFAULT_FRIDGE_ID,
        role: "owner",
      });
    });
  });

  it("persists explicit pantry inventory idempotently", () => {
    const candidate = {
      kind: "inventory_item",
      scope: "fridge",
      action: "upsert",
      name: "Jasmine rice",
      storageLocation: "pantry",
      quantity: {
        amount: 2,
        unit: "bags",
        precision: "estimated",
      },
      notes: null,
      explicit: true,
    } satisfies MemoryCandidate;

    const first = persist(candidate);
    const second = persist(candidate);
    const context = listStructuredMemoryContext({
      userId: DEFAULT_USER_ID,
      fridgeId: DEFAULT_FRIDGE_ID,
    });

    expect(first.result.status).toBe("persisted");
    expect(second.result.targetId).toBe(first.result.targetId);
    expect(context.externalInventory).toHaveLength(1);
    expect(context.externalInventory[0]).toMatchObject({
      name: "Jasmine rice",
      canonicalName: "jasmine rice",
      storageLocation: "pantry",
      quantity: {
        amount: 2,
        unit: "bags",
        precision: "estimated",
      },
      status: "available",
    });
  });

  it("persists explicit allergies, preferences, and goals", () => {
    persist({
      kind: "dietary_restriction",
      scope: "user",
      action: "upsert",
      restrictionType: "allergy",
      subject: "peanuts",
      severity: "strict_avoid",
      notes: null,
      explicit: true,
    });
    persist({
      kind: "preference",
      scope: "user",
      action: "upsert",
      subject: "mushrooms",
      sentiment: "dislike",
      strength: 4,
      notes: null,
      explicit: true,
    });
    persist({
      kind: "goal",
      scope: "user",
      action: "upsert",
      goalType: "high_protein",
      description: "high protein dinners",
      targetValue: null,
      targetUnit: null,
      priority: 2,
      explicit: true,
    });

    const context = listStructuredMemoryContext({
      userId: DEFAULT_USER_ID,
      fridgeId: DEFAULT_FRIDGE_ID,
    });

    expect(context.dietaryRestrictions).toMatchObject([
      {
        restrictionType: "allergy",
        subject: "peanuts",
        severity: "strict_avoid",
      },
    ]);
    expect(context.dietaryPreferences).toMatchObject([
      {
        subject: "mushrooms",
        sentiment: "dislike",
        strength: 4,
      },
    ]);
    expect(context.activeGoals).toMatchObject([
      {
        goalType: "high_protein",
        description: "high protein dinners",
      },
    ]);
  });

  it("rejects inferred candidates without throwing", () => {
    const validation = validateMemoryCandidate({
      kind: "preference",
      scope: "user",
      action: "upsert",
      subject: "Italian food",
      sentiment: "like",
      strength: 1,
      notes: null,
      explicit: false,
    });
    const write = applyMemoryCandidate({
      profile: {
        userId: DEFAULT_USER_ID,
        fridgeId: DEFAULT_FRIDGE_ID,
      },
      validation,
    });

    expect(validation.accepted).toBe(false);
    expect(write.result).toMatchObject({
      status: "skipped",
      targetId: null,
    });
  });

  it("removes preferences and deactivates goals", () => {
    persist({
      kind: "preference",
      scope: "user",
      action: "upsert",
      subject: "cilantro",
      sentiment: "avoid",
      strength: 5,
      notes: null,
      explicit: true,
    });
    persist({
      kind: "goal",
      scope: "user",
      action: "upsert",
      goalType: "quick_meals",
      description: "quick weeknight meals",
      targetValue: null,
      targetUnit: null,
      priority: 1,
      explicit: true,
    });
    persist({
      kind: "preference",
      scope: "user",
      action: "remove",
      subject: "cilantro",
      sentiment: "avoid",
      strength: 5,
      notes: null,
      explicit: true,
    });
    persist({
      kind: "goal",
      scope: "user",
      action: "deactivate",
      goalType: "quick_meals",
      description: "quick weeknight meals",
      targetValue: null,
      targetUnit: null,
      priority: 1,
      explicit: true,
    });

    const context = listStructuredMemoryContext({
      userId: DEFAULT_USER_ID,
      fridgeId: DEFAULT_FRIDGE_ID,
    });

    expect(context.dietaryPreferences).toEqual([]);
    expect(context.activeGoals).toEqual([]);
  });

  it("throws a specific error for invalid stored external inventory status", () => {
    ensureMemoryProfile();

    withDatabase((db) => {
      const now = new Date().toISOString();

      db.insert(externalInventoryItems)
        .values({
          id: "external-inventory-invalid",
          fridgeId: DEFAULT_FRIDGE_ID,
          name: "Rice",
          canonicalName: "rice",
          storageLocation: "pantry",
          quantityAmount: null,
          quantityUnit: null,
          quantityPrecision: null,
          status: "not-a-status",
          confidence: 1,
          source: "user_explicit",
          notes: null,
          normalizedKey: "inventory:pantry:rice",
          lastConfirmedAt: now,
          createdAt: now,
          updatedAt: now,
        })
        .run();
    });

    expect(() =>
      listStructuredMemoryContext({
        userId: DEFAULT_USER_ID,
        fridgeId: DEFAULT_FRIDGE_ID,
      })
    ).toThrow("Stored external inventory status is invalid: not-a-status");
  });
});
