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
    const result = await routeIntentCandidatesByEmbedding(
      { query: "Can you help with this?" },
      {
        embedDocuments: async () => INTENT_EMBEDDING_EXAMPLES.map((_, index) =>
          new Array(768).fill(0).map((__, vectorIndex) => vectorIndex === index % 2 ? 1 : 0)),
        embedQuery: async () => new Array(768).fill(0).map((_, index) => index === 0 ? 1 : 0),
      },
    );

    expect(result.accepted).toBeNull();
    expect(result.candidates).toHaveLength(3);
  });

  it("returns static routing metadata from the matched example", async () => {
    const result = await routeIntentByEmbedding(
      { query: "Make a grocery list for tacos." },
      {
        embedDocuments: async (documents) =>
          documents.map((document) =>
            document === "Make a grocery list for tacos."
              ? new Array(768).fill(0).map((_, index) => index === 0 ? 1 : 0)
              : new Array(768).fill(0).map((_, index) => index === 1 ? 1 : 0)),
        embedQuery: async () => new Array(768).fill(0).map((_, index) => index === 0 ? 1 : 0),
      },
    );

    expect(result).toMatchObject({
      intent: "shopping",
      shoppingMode: "grocery_planner",
      memoryUpdateRequested: false,
    });
  });
});
