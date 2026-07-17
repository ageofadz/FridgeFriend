import { describe, expect, it } from "vitest";

import {
  INTENT_EMBEDDING_EXAMPLES,
  routeIntentByEmbedding,
  routeIntentCandidatesByEmbedding,
  selectIntentEmbeddingRoute,
  selectIntentEmbeddingRouteCandidates,
  type IntentEmbeddingRecord,
} from "../../../../../app/server/query/services/intent-embedding-router.server";

function vector(first: number, second: number) {
  return [first, second];
}

function fullVector(index: number) {
  return new Array(768).fill(0).map((_, vectorIndex) => vectorIndex === index ? 1 : 0);
}

function queryRowsFromUpserts(upserts: Array<{
  ids: string[];
  documents: string[];
  metadatas: Array<Record<string, unknown>>;
}>, distances: number[]) {
  return upserts.flatMap((upsert) =>
    upsert.ids.map((_, index) => ({
      document: upsert.documents[index],
      metadata: upsert.metadatas[index],
      distance: distances[index] ?? 1,
    }))
  );
}

describe("intent embedding router", () => {
  it("has ten examples per intent", () => {
    const counts = new Map<string, number>();

    for (const example of INTENT_EMBEDDING_EXAMPLES) {
      counts.set(example.intent, (counts.get(example.intent) ?? 0) + 1);
    }

    expect([...counts.entries()].sort()).toEqual([
      ["clarification", 10],
      ["expiry", 10],
      ["food_knowledge", 10],
      ["general_chat", 10],
      ["inventory", 10],
      ["organization", 10],
      ["placement_correction", 10],
      ["recipe", 10],
      ["shopping", 10],
      ["space", 10],
    ]);
  });

  it("accepts a high-confidence route with enough margin", () => {
    const examples: IntentEmbeddingRecord[] = [
      { intent: "recipe", text: "recipe", embedding: vector(1, 0) },
      { intent: "inventory", text: "inventory", embedding: vector(0.7, 0.714142842) },
    ];

    const result = selectIntentEmbeddingRoute(vector(1, 0), examples);

    expect(result).toMatchObject({
      intent: "recipe",
      score: 1,
    });
  });

  it("rejects close intent matches", () => {
    const examples: IntentEmbeddingRecord[] = [
      { intent: "recipe", text: "recipe", embedding: vector(0.9, 0.4358898944) },
      { intent: "inventory", text: "inventory", embedding: vector(0.875, 0.4841229183) },
    ];

    expect(selectIntentEmbeddingRoute(vector(1, 0), examples)).toBeNull();
  });

  it("returns the top three nearest intent choices by each intent's best example", () => {
    const examples: IntentEmbeddingRecord[] = [
      { intent: "recipe", text: "weaker recipe", embedding: vector(0.7, 0.714142842) },
      { intent: "recipe", text: "best recipe", embedding: vector(0.95, 0.3122498999) },
      { intent: "inventory", text: "inventory", embedding: vector(0.9, 0.4358898944) },
      { intent: "shopping", text: "shopping", embedding: vector(0.85, 0.5267826876) },
      { intent: "space", text: "space", embedding: vector(0.5, 0.8660254038) },
    ];

    const result = selectIntentEmbeddingRouteCandidates(vector(1, 0), examples);

    expect(result.map((candidate) => candidate.intent)).toEqual(["recipe", "inventory", "shopping"]);
    expect(result[0]?.example.text).toBe("best recipe");
  });

  it("returns unresolved routing with candidates when embedding confidence is below the direct route margin", async () => {
    const upserts: Array<{
      ids: string[];
      documents: string[];
      metadatas: Array<Record<string, unknown>>;
    }> = [];
    const collection = {
      handle: {
        get: async () => ({ ids: [] }),
        upsert: async (input: {
          ids: string[];
          documents: string[];
          metadatas: Array<Record<string, unknown>>;
        }) => {
          upserts.push(input);
        },
        query: async () => ({
          rows: () => [queryRowsFromUpserts(upserts, INTENT_EMBEDDING_EXAMPLES.map(() => 1))],
        }),
      },
    };
    const result = await routeIntentCandidatesByEmbedding(
      { query: "blue triangle cabinet" },
      {
        embedDocuments: async () => INTENT_EMBEDDING_EXAMPLES.map((_, index) => fullVector(index % 2)),
        embedQuery: async () => fullVector(0),
        getCollection: async () => collection as never,
      },
    );

    expect(result.accepted).toBeNull();
    expect(result.candidates).toHaveLength(3);
  });

  it("returns static routing metadata from the matched example", async () => {
    const upserts: Array<{
      ids: string[];
      documents: string[];
      metadatas: Array<Record<string, unknown>>;
    }> = [];
    const collection = {
      handle: {
        get: async () => ({ ids: [] }),
        upsert: async (input: {
          ids: string[];
          documents: string[];
          metadatas: Array<Record<string, unknown>>;
        }) => {
          upserts.push(input);
        },
        query: async () => ({
          rows: () => [
            queryRowsFromUpserts(
              upserts,
              INTENT_EMBEDDING_EXAMPLES.map((example) =>
                example.text === "Make a grocery list for tacos." ? 0 : 2),
            ),
          ],
        }),
      },
    };
    const result = await routeIntentByEmbedding(
      { query: "Make a grocery list for tacos." },
      {
        embedDocuments: async (documents) =>
          documents.map((document) =>
            document === "Make a grocery list for tacos."
              ? fullVector(0)
              : fullVector(1)),
        embedQuery: async () => fullVector(0),
        getCollection: async () => collection as never,
      },
    );

    expect(result).toMatchObject({
      intent: "shopping",
      shoppingMode: "grocery_planner",
      memoryUpdateRequested: false,
    });
  });

  it("routes explicit scanned inventory consumption as a memory update", async () => {
    const upserts: Array<{
      ids: string[];
      documents: string[];
      metadatas: Array<Record<string, unknown>>;
    }> = [];
    const collection = {
      handle: {
        get: async () => ({ ids: [] }),
        upsert: async (input: {
          ids: string[];
          documents: string[];
          metadatas: Array<Record<string, unknown>>;
        }) => {
          upserts.push(input);
        },
        query: async () => ({
          rows: () => [
            queryRowsFromUpserts(
              upserts,
              INTENT_EMBEDDING_EXAMPLES.map((example) =>
                example.text === "I ate the carrots." ? 0 : 2),
            ),
          ],
        }),
      },
    };
    const result = await routeIntentByEmbedding(
      { query: "I ate the carrots" },
      {
        embedDocuments: async (documents) =>
          documents.map((document) =>
            document === "I ate the carrots."
              ? fullVector(0)
              : fullVector(1)),
        embedQuery: async () => fullVector(0),
        getCollection: async () => collection as never,
      },
    );

    expect(result).toMatchObject({
      intent: "inventory",
      memoryUpdateRequested: true,
    });
  });

  it("routes clear intent requests locally without embedding or Chroma", async () => {
    const result = await routeIntentCandidatesByEmbedding(
      { query: "Make a grocery list for tacos." },
      {
        embedDocuments: async () => {
          throw new Error("intent examples should not be embedded for a clear local route");
        },
        embedQuery: async () => {
          throw new Error("query should not be embedded for a clear local route");
        },
        getCollection: async () => {
          throw new Error("Chroma should not be loaded for a clear local route");
        },
      },
    );

    expect(result.accepted).toMatchObject({
      intent: "shopping",
      shoppingMode: "grocery_planner",
    });
  });

  it("does not re-embed intent examples already present in Chroma", async () => {
    let embedDocumentCalls = 0;
    const collection = {
      handle: {
        get: async (input: { ids: string[] }) => ({ ids: input.ids }),
        upsert: async () => {
          throw new Error("upsert should not run when every intent example is already indexed");
        },
        query: async () => ({
          rows: () => [[{
            document: "Make a grocery list for tacos.",
            metadata: {
              documentType: "intent_example",
              corpusVersion: "2026-07-18-delete-mutations",
              intent: "shopping",
              exampleIndex: 43,
              recipeContinuation: false,
              shoppingMode: "grocery_planner",
              memoryUpdateRequested: false,
            },
            distance: 0,
          }, {
            document: "Suggest three dinner ideas with chicken.",
            metadata: {
              documentType: "intent_example",
              corpusVersion: "2026-07-18-delete-mutations",
              intent: "recipe",
              exampleIndex: 30,
              recipeContinuation: false,
              shoppingMode: "direct",
              memoryUpdateRequested: false,
            },
            distance: 1,
          }]],
        }),
      },
    };

    const result = await routeIntentCandidatesByEmbedding({ query: "Supplies for next week." }, {
      embedDocuments: async () => {
        embedDocumentCalls += 1;
        return [];
      },
      embedQuery: async () => fullVector(0),
      getCollection: async () => collection as never,
    });

    expect(embedDocumentCalls).toBe(0);
    expect(result.accepted).toMatchObject({
      intent: "shopping",
      shoppingMode: "grocery_planner",
    });
  });
});
