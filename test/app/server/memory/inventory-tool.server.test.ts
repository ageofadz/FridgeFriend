import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createManageHouseholdInventoryTool } from "../../../../app/server/memory/inventory-tool.server";
import { listStructuredMemoryContext, validateMemoryCandidate } from "../../../../app/server/memory/repository.server";
import type { MemoryValidationResult } from "../../../../app/server/memory/schemas";
import { createPersistMemoryNode } from "../../../../app/server/query/nodes/persist-memory.node";
import type { FridgeQueryStateValue } from "../../../../app/server/query/state";

function setTestDatabase() {
  const databasePath = path.join(
    tmpdir(),
    `fridgefriend-inventory-tool-test-${randomUUID()}.sqlite`,
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

function requireItem<T extends { item: unknown }>(result: T) {
  if (!result.item) {
    throw new Error("Expected manage_household_inventory to return an item");
  }

  return result.item as { id: string };
}

describe("manage_household_inventory", () => {
  let databasePath: string;

  beforeEach(() => {
    databasePath = setTestDatabase();
  });

  afterEach(() => {
    removeTestDatabase(databasePath);
  });

  it("manages fridge-scoped inventory through every operation", async () => {
    const fridgeATool = createManageHouseholdInventoryTool({
      fridgeId: "fridge-a",
    });
    const fridgeBTool = createManageHouseholdInventoryTool({
      fridgeId: "fridge-b",
    });
    const added = await fridgeATool.invoke({
      operation: "add",
      name: "Jasmine rice",
      storageLocation: "pantry",
      quantity: {
        amount: 2,
        unit: "bags",
        precision: "estimated",
      },
      notes: "open bag",
    });

    expect(added).toMatchObject({
      operation: "add",
      status: "ok",
      item: {
        name: "Jasmine rice",
        storageLocation: "pantry",
        quantity: {
          amount: 2,
          unit: "bags",
          precision: "estimated",
        },
      },
    });

    const listed = await fridgeATool.invoke({
      operation: "list",
      location: "pantry",
      fridgeId: "fridge-b",
    });
    const otherFridge = await fridgeBTool.invoke({ operation: "list" });

    expect(listed.items).toHaveLength(1);
    expect(otherFridge.items).toEqual([]);

    const updated = await fridgeATool.invoke({
      operation: "update",
      id: requireItem(added).id,
      quantity: {
        amount: 1,
        unit: "bag",
        precision: "exact",
      },
      notes: null,
    });

    expect(updated).toMatchObject({
      operation: "update",
      status: "ok",
      item: {
        quantity: {
          amount: 1,
          unit: "bag",
          precision: "exact",
        },
        notes: null,
      },
    });

    const consumed = await fridgeATool.invoke({
      operation: "consume",
      id: requireItem(updated).id,
    });

    expect(consumed).toMatchObject({
      operation: "consume",
      status: "ok",
      item: { status: "consumed" },
    });
    expect((await fridgeATool.invoke({ operation: "list" })).items).toEqual([]);

    const pasta = await fridgeATool.invoke({
      operation: "add",
      name: "Pasta",
      storageLocation: "cupboard",
      quantity: null,
      notes: null,
    });
    const removed = await fridgeATool.invoke({
      operation: "remove",
      id: requireItem(pasta).id,
    });

    expect(removed).toMatchObject({
      operation: "remove",
      status: "ok",
      item: { status: "removed" },
    });
  });

  it("returns structured results for invalid and missing operations", async () => {
    const inventoryTool = createManageHouseholdInventoryTool({
      fridgeId: "fridge-a",
    });

    await expect(
      inventoryTool.invoke({ operation: "replace" }),
    ).resolves.toMatchObject({
      operation: "invalid",
      status: "invalid",
    });
    await expect(
      inventoryTool.invoke({
        operation: "update",
        name: "Rice",
        storageLocation: "pantry",
      }),
    ).resolves.toMatchObject({
      operation: "update",
      status: "invalid",
    });
    await expect(
      inventoryTool.invoke({
        operation: "remove",
        name: "Rice",
        storageLocation: "pantry",
      }),
    ).resolves.toMatchObject({
      operation: "remove",
      status: "not_found",
    });
    await expect(
      createManageHouseholdInventoryTool({ fridgeId: " " }).invoke({
        operation: "list",
      }),
    ).resolves.toMatchObject({
      operation: "invalid",
      status: "invalid",
      message: "manage_household_inventory has no bound fridge ID",
    });
  });

  it("filters, sorts, limits, and projects list results", async () => {
    const inventoryTool = createManageHouseholdInventoryTool({
      fridgeId: "fridge-filters",
    });
    const rice = await inventoryTool.invoke({
      operation: "add",
      name: "Jasmine rice",
      storageLocation: "pantry",
      quantity: {
        amount: 2,
        unit: "bags",
        precision: "estimated",
      },
      notes: "open bag",
    });
    await inventoryTool.invoke({
      operation: "add",
      name: "Greek yogurt",
      storageLocation: "fridge",
      quantity: null,
      notes: "breakfast",
    });
    const oil = await inventoryTool.invoke({
      operation: "add",
      name: "Olive oil",
      storageLocation: "cupboard",
      quantity: {
        amount: 1,
        unit: "bottle",
        precision: "exact",
      },
      notes: null,
    });
    await inventoryTool.invoke({
      operation: "consume",
      id: requireItem(oil).id,
    });

    const projected = await inventoryTool.invoke({
      operation: "list",
      locations: ["pantry", "cupboard"],
      search: "rice",
      hasQuantity: true,
      fields: ["name", "storageLocation", "quantity"],
      limit: 5,
      sortBy: "name",
      sortDirection: "asc",
    });

    expect(projected).toMatchObject({
      operation: "list",
      status: "ok",
      items: [
        {
          id: requireItem(rice).id,
          name: "Jasmine rice",
          storageLocation: "pantry",
          quantity: {
            amount: 2,
            unit: "bags",
            precision: "estimated",
          },
        },
      ],
    });
    expect(projected.items[0]).not.toHaveProperty("notes");
    expect(projected.items[0]).not.toHaveProperty("source");

    const inactive = await inventoryTool.invoke({
      operation: "list",
      statuses: ["consumed"],
      fields: ["name", "status"],
    });

    expect(inactive.items).toEqual([
      {
        id: requireItem(oil).id,
        name: "Olive oil",
        status: "consumed",
      },
    ]);

    const limited = await inventoryTool.invoke({
      operation: "list",
      fields: ["name"],
      limit: 1,
      sortBy: "storageLocation",
      sortDirection: "asc",
    });

    expect(limited.items).toHaveLength(1);
    expect(Object.keys(limited.items[0]).sort()).toEqual(["id", "name"]);
  });

  it("persists accepted explicit inventory memory through the bound tool", async () => {
    const fridgeId = "fridge-memory";
    const node = createPersistMemoryNode({
      loadMemoryContext: () => ({
        ...listStructuredMemoryContext({
          userId: "user-memory",
          fridgeId,
        }),
        semanticMemories: [],
      }),
    });
    const state = {
      userId: "user-memory",
      fridgeId,
      query: "There is olive oil in the cupboard",
      memoryValidations: [
        validateMemoryCandidate({
          kind: "inventory_item",
          scope: "fridge",
          action: "upsert",
          name: "Olive oil",
          storageLocation: "cupboard",
          quantity: null,
          notes: null,
          explicit: true,
        }),
      ],
      context: {},
    } as FridgeQueryStateValue;

    const result = await node(state);
    const context = listStructuredMemoryContext({
      userId: "user-memory",
      fridgeId,
    });

    expect(result.memoryWriteResults).toMatchObject([
      {
        kind: "inventory_item",
        action: "upsert",
        status: "persisted",
      },
    ]);
    expect(context.externalInventory).toMatchObject([
      {
        name: "Olive oil",
        storageLocation: "cupboard",
        source: "user_explicit",
      },
    ]);
  });

  it("keeps the injected memory persistence path compatible", async () => {
    const persistMemoryValidations = vi.fn(async ({
      validations,
    }: {
      validations: MemoryValidationResult[];
    }) =>
      validations.map((validation) => ({
        result: {
          kind: validation.candidate.kind,
          action: validation.candidate.action,
          status: "persisted" as const,
          targetId: "injected-memory-id",
          message: "Injected persistence",
        },
        semanticMemory: null,
      })),
    );
    const node = createPersistMemoryNode({
      persistMemoryValidations,
      loadMemoryContext: () => ({
        externalInventory: [],
        dietaryRestrictions: [],
        dietaryPreferences: [],
        activeGoals: [],
        semanticMemories: [],
      }),
    });
    const state = {
      userId: "user-injected",
      fridgeId: "fridge-injected",
      query: "There is flour in the pantry",
      memoryValidations: [
        validateMemoryCandidate({
          kind: "inventory_item",
          scope: "fridge",
          action: "upsert",
          name: "Flour",
          storageLocation: "pantry",
          quantity: null,
          notes: null,
          explicit: true,
        }),
      ],
      context: {},
    } as FridgeQueryStateValue;

    const result = await node(state);

    expect(persistMemoryValidations).toHaveBeenCalledWith({
      userId: "user-injected",
      fridgeId: "fridge-injected",
      validations: state.memoryValidations,
    });
    expect(result.memoryWriteResults).toMatchObject([
      {
        targetId: "injected-memory-id",
        message: "Injected persistence",
      },
    ]);
  });
});
