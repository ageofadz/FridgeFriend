import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { createFixtureImageResolver } from "../../../../../app/server/evals/fixtures/fixture-image-resolver";
import { createFixtureInventoryAdapter } from "../../../../../app/server/evals/fixtures/fixture-inventory-adapter";
import { createFixtureMemoryAdapter } from "../../../../../app/server/evals/fixtures/fixture-memory-adapter";
import { createFixtureRecipeAdapter } from "../../../../../app/server/evals/fixtures/fixture-recipe-adapter";
import {
  createFixtureSideEffectLog,
  workspaceGrounding,
} from "../../../../../app/server/evals/fixtures/fixture-workspace-adapter";
import type { MemoryValidationResult } from "../../../../../app/server/memory/schemas";
import { QueryFixturesSchema } from "../../../../../app/server/evals/schemas/query-eval-case";

const FIXTURES_DIR = path.resolve(
  process.cwd(),
  "app/server/evals/fixtures",
);

function restrictionValidation(subject: string, accepted = true): MemoryValidationResult {
  return {
    candidate: {
      kind: "dietary_restriction",
      scope: "user",
      action: "upsert",
      restrictionType: "other",
      subject,
      severity: "strict_avoid",
      notes: null,
      explicit: true,
    },
    accepted,
    reason: accepted ? "Explicit user claim" : "Rejected by validation",
  };
}

describe("fixture adapters", () => {
  it("never import sqlite or chroma modules", () => {
    for (const file of readdirSync(FIXTURES_DIR)) {
      const source = readFileSync(path.join(FIXTURES_DIR, file), "utf8");
      const importLines = source
        .split("\n")
        .filter((line) => /^\s*(import|export .* from)\b/.test(line) || /require\(/.test(line))
        .join("\n");
      expect(importLines, `${file} must stay side-effect free`).not.toMatch(
        /sqlite|chroma|better-sqlite3/i,
      );
      expect(importLines, `${file} must not import server db modules`).not.toMatch(
        /from "\.\.\/\.\.\/(sqlite|inventories|images|checkpointer|memory\/(repository|vector-store|inventory-tool|context))/,
      );
    }
  });

  it("reflects persisted memory writes on subsequent loads with exactly-once counters", async () => {
    const log = createFixtureSideEffectLog();
    const adapter = createFixtureMemoryAdapter({ memories: [], log });

    const before = await adapter.loadMemoryContext!({ userId: "u", fridgeId: "f", query: "q" });
    expect(before.dietaryRestrictions).toEqual([]);

    const writes = await adapter.persistMemoryValidations!({
      userId: "u",
      fridgeId: "f",
      imageId: null,
      validations: [restrictionValidation("shellfish"), restrictionValidation("ignored", false)],
    });

    expect(writes.map((write) => write.result.status)).toEqual(["persisted", "skipped"]);
    expect(log.counters.memoryWrites).toBe(1);
    expect(log.writes).toHaveLength(1);

    const after = await adapter.loadMemoryContext!({ userId: "u", fridgeId: "f", query: "q" });
    expect(after.dietaryRestrictions).toHaveLength(1);
    expect(after.dietaryRestrictions[0]).toMatchObject({
      subject: "shellfish",
      id: writes[0].result.targetId,
    });

    // Snapshots are isolated: mutating a returned context does not touch the store.
    after.dietaryRestrictions.pop();
    const reloaded = await adapter.loadMemoryContext!({ userId: "u", fridgeId: "f", query: "q" });
    expect(reloaded.dietaryRestrictions).toHaveLength(1);
  });

  it("seeds the memory store from fixtures including knowledge documents", async () => {
    const log = createFixtureSideEffectLog();
    const adapter = createFixtureMemoryAdapter({
      memories: [
        { kind: "external_inventory", value: { id: "ext-1", name: "milk", storageLocation: "fridge" } },
        { kind: "dietary_restriction", value: { subject: "peanuts" } },
        { kind: "semantic", value: { id: "sem-1", content: "Likes soup." } },
      ],
      knowledgeDocuments: [
        { id: "doc-1", title: "Egg storage", content: "Store eggs cold.", tags: ["storage"] },
      ],
      log,
    });

    const context = await adapter.loadMemoryContext!({ userId: "u", fridgeId: "f", query: "q" });
    expect(context.externalInventory).toEqual([expect.objectContaining({ id: "ext-1", name: "milk" })]);
    expect(context.dietaryRestrictions).toEqual([expect.objectContaining({ subject: "peanuts" })]);
    expect(context.semanticMemories.map((memory) => memory.id)).toEqual(["doc-1", "sem-1"]);
    expect(log.counters.memoryWrites).toBe(0);
  });

  it("counts semantic memory index writes", async () => {
    const log = createFixtureSideEffectLog();
    const adapter = createFixtureMemoryAdapter({ memories: [], log });

    await adapter.indexSemanticMemory!({
      id: "sem-1",
      namespaceType: "user",
      namespaceId: "u",
      category: "note",
      content: "content",
      source: "user_explicit",
      confidence: 1,
      active: true,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    expect(log.counters.semanticMemoryIndexWrites).toBe(1);
    expect(log.writes).toEqual([{ kind: "semantic_memory_index", target: "sem-1" }]);
  });

  it("lists fixture inventory items without counting writes", async () => {
    const log = createFixtureSideEffectLog();
    const adapter = createFixtureInventoryAdapter({
      inventory: { items: [{ id: "item-1", name: "chicken" }] },
      log,
    });

    const result = await adapter.householdInventoryTool!.invoke({ operation: "list" });
    expect(result.items).toEqual([{ id: "item-1", name: "chicken" }]);
    expect(adapter.applySeededInventoryAssertions!({ seededItems: [], assertions: [] })).toEqual([]);
    expect(log.counters.inventoryWrites).toBe(0);
    expect(log.counters.enrichmentWrites).toBe(0);
  });

  it("counts enrichment persistence through the injected dependency", async () => {
    const log = createFixtureSideEffectLog();
    const adapter = createFixtureInventoryAdapter({ inventory: null, log });

    await adapter.persistInventoryEnrichments!({
      imageId: "image-1",
      enrichments: [
        {
          itemId: "item-1",
          source: "focused_vlm",
          fields: ["quantity"],
          confidence: 0.9,
          observedAt: "2026-01-01T00:00:00.000Z",
          imageId: "image-1",
          boundingBox: null,
          values: {},
        } as never,
      ],
    });

    expect(log.counters.enrichmentWrites).toBe(1);
    expect(log.writes).toEqual([{ kind: "inventory_enrichment", target: "image-1:item-1" }]);
  });

  it("resolves fixture images and throws a fixture error for unknown ids", () => {
    const resolver = createFixtureImageResolver([
      { imageId: "image-1", dataUrl: "data:image/jpeg;base64,abc" },
    ]);

    expect(resolver.loadImageDataUrls(["image-1"])).toEqual(["data:image/jpeg;base64,abc"]);
    expect(resolver.loadImageDataUrlForQuery("image-1")).toBe("data:image/jpeg;base64,abc");
    expect(() => resolver.loadImageDataUrlForQuery("missing"))
      .toThrowError(/Fixture image "missing"/);
  });

  it("serves recipe fixtures through the retrieval dependencies", async () => {
    const adapter = createFixtureRecipeAdapter({
      recipes: [
        { id: "r-1", name: "Soup", tags: ["dinner"] },
        { id: "r-2", name: "Salad", tags: ["lunch"] },
      ],
      recipeCandidates: [{ recipeId: "r-1", semanticScore: 0.9 }],
      recipeTagCandidates: [{ recipeId: "r-2", matchedTags: ["lunch"], tagScore: 1 }],
      recipeIngredientCandidates: [
        { recipeId: "r-1", matchedIngredients: ["carrot"], ingredientScore: 1, missingIngredientCount: 1 },
        { recipeId: "r-2", matchedIngredients: ["kale"], ingredientScore: 1 },
      ],
    });

    await expect(adapter.searchRecipeCandidates!({ query: "soup", limit: 5 }))
      .resolves.toEqual([{ recipeId: "r-1", semanticScore: 0.9 }]);
    expect(await adapter.getRecipesByIds!(["r-2"])).toEqual([
      expect.objectContaining({ id: "r-2" }),
    ]);
    expect(await adapter.listFoodComTags!()).toEqual(["dinner", "lunch"]);
    expect(
      await adapter.getPantryCompletionRecipeCandidates!({
        ingredients: [],
        universalIngredients: [],
        minMissingIngredients: 1,
        maxMissingIngredients: 3,
        limit: 5,
      }),
    ).toEqual([expect.objectContaining({ recipeId: "r-1", missingIngredientCount: 1 })]);
  });

  it("builds workspace grounding from fixture ids", () => {
    const fixtures = QueryFixturesSchema.parse({
      inventory: { items: [{ id: "item-1", name: "milk" }] },
      recipes: [{ id: "r-1", name: "Soup" }],
      images: [{ imageId: "image-1", dataUrl: "data:image/jpeg;base64,abc" }],
      workspace: {
        itemIds: ["item-1", "item-2"],
        zoneIds: ["zone-1"],
        recipeIds: ["r-9"],
        imageIds: [],
        boundingBoxes: [],
      },
    });

    expect(workspaceGrounding(fixtures)).toEqual({
      itemIds: ["item-1", "item-2"],
      zoneIds: ["zone-1"],
      recipeIds: ["r-9", "r-1"],
      imageIds: ["image-1"],
    });
  });
});
