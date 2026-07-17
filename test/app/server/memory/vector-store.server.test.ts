import { describe, expect, it } from "vitest";

import {
  MEMORY_EMBEDDING_DIMENSIONS,
  indexSemanticMemory,
  searchSemanticMemoryIds,
} from "../../../../app/server/memory/vector-store.server";
import type { SemanticMemory } from "../../../../app/server/memory/schemas";

function sampleMemory(overrides: Partial<SemanticMemory> = {}): SemanticMemory {
  return {
    id: "memory:1",
    namespaceType: "user",
    namespaceId: "user-1",
    category: "preference",
    content: "Loves spicy food",
    source: "user_explicit",
    confidence: 1,
    active: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function rawVector(first: number, second: number) {
  const vector = new Array(MEMORY_EMBEDDING_DIMENSIONS).fill(0);
  vector[0] = first;
  vector[1] = second;
  return vector;
}

describe("memory vector store", () => {
  it("indexes memories with normalized embeddings and scope metadata", async () => {
    const upserts: Array<{
      ids: string[];
      embeddings: number[][];
      documents: string[];
      metadatas: Array<Record<string, unknown>>;
    }> = [];
    const collection = {
      handle: {
        upsert: async (input: (typeof upserts)[number]) => {
          upserts.push(input);
        },
        count: async () => 0,
        delete: async () => undefined,
        query: async () => ({ rows: () => [] }),
      },
    };

    await indexSemanticMemory(sampleMemory(), {
      embedText: async () => rawVector(3, 4),
      getCollection: async () => collection as never,
    });

    expect(upserts).toHaveLength(1);
    expect(upserts[0].ids).toEqual(["memory:1"]);
    expect(upserts[0].documents).toEqual(["Loves spicy food"]);
    expect(upserts[0].metadatas[0]).toEqual({
      documentType: "memory",
      scopeType: "user",
      scopeId: "user-1",
      category: "preference",
      memoryId: "memory:1",
      active: true,
    });
    // [3, 4, 0, ...] must be L2-normalized to [0.6, 0.8, 0, ...].
    expect(upserts[0].embeddings[0][0]).toBeCloseTo(0.6);
    expect(upserts[0].embeddings[0][1]).toBeCloseTo(0.8);
    expect(Math.hypot(...upserts[0].embeddings[0])).toBeCloseTo(1);
  });

  it("rejects embeddings with the wrong dimensionality", async () => {
    await expect(indexSemanticMemory(sampleMemory(), {
      embedText: async () => [1, 2, 3],
      getCollection: async () => {
        throw new Error("collection should not be loaded for an invalid embedding");
      },
    })).rejects.toThrow(`returned 3 dimensions; expected ${MEMORY_EMBEDDING_DIMENSIONS}`);
  });

  it("queries both scopes together, dedupes, and sorts by distance", async () => {
    const wheres: unknown[] = [];
    const collection = {
      handle: {
        upsert: async () => undefined,
        delete: async () => undefined,
        query: async (input: { where: unknown }) => {
          wheres.push(input.where);
          return { rows: () => [[
            { metadata: { memoryId: "memory:user" }, distance: 0.3 },
            { metadata: { memoryId: "memory:shared" }, distance: 0.2 },
            { metadata: { memoryId: "memory:fridge" }, distance: 0.1 },
          ]] };
        },
      },
    };

    await expect(searchSemanticMemoryIds({
      query: "spicy dinner ideas",
      userId: "user-1",
      fridgeId: "fridge-1",
      limit: 3,
    }, {
      embedText: async () => rawVector(1, 0),
      getCollection: async () => collection as never,
    })).resolves.toEqual(["memory:fridge", "memory:shared", "memory:user"]);
    expect(wheres).toEqual([
      {
        $and: [
          { documentType: "memory" },
          { active: true },
          {
            $or: [
              { scopeType: "user", scopeId: "user-1" },
              { scopeType: "fridge", scopeId: "fridge-1" },
            ],
          },
        ],
      },
    ]);
  });

  it("returns no ids for empty queries", async () => {
    const collection = {
      handle: {
        upsert: async () => undefined,
        delete: async () => undefined,
        query: async () => ({ rows: () => [[]] }),
      },
    };
    const dependencies = {
      embedText: async () => rawVector(1, 0),
      getCollection: async () => collection as never,
    };

    await expect(searchSemanticMemoryIds({
      query: "   ",
      userId: "user-1",
      fridgeId: "fridge-1",
      limit: 3,
    }, dependencies)).resolves.toEqual([]);
  });
});
