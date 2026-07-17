import {
  GoogleGenerativeAI,
  TaskType,
  type BatchEmbedContentsRequest,
  type EmbedContentRequest,
} from "@google/generative-ai";

import { normalizeEmbedding } from "../../chroma.server";
import { requiredEnv } from "../../env.server";
import type {
  EnrichmentRequirement,
  IntentResponse,
  QueryIntent,
} from "../schemas/query";

const INTENT_EMBEDDING_MODEL = "gemini-embedding-001";
const INTENT_EMBEDDING_DIMENSIONS = 768;
const INTENT_EMBEDDING_ACCEPTANCE_THRESHOLD = 0.62;
const INTENT_EMBEDDING_ACCEPTANCE_MARGIN = 0.035;

type ShoppingMode = IntentResponse["shoppingMode"];

type IntentEmbeddingExample = {
  intent: QueryIntent;
  text: string;
  recipeContinuation?: boolean;
  shoppingMode?: ShoppingMode;
  enrichment?: EnrichmentRequirement;
  memoryUpdateRequested?: boolean;
};

export type IntentEmbeddingRecord = IntentEmbeddingExample & {
  embedding: number[];
};

type IntentEmbeddingDependencies = {
  embedDocuments?: (documents: string[]) => Promise<number[][]>;
  embedQuery?: (query: string) => Promise<number[]>;
};

export type IntentEmbeddingRouteCandidate = {
  intent: QueryIntent;
  score: number;
  margin: number;
  example: IntentEmbeddingExample;
};

export type IntentEmbeddingRoutingResult = {
  accepted: IntentResponse | null;
  candidates: IntentEmbeddingRouteCandidate[];
};

const emptyEnrichment: EnrichmentRequirement = { itemNames: [], fields: [] };

export const INTENT_EMBEDDING_EXAMPLES: IntentEmbeddingExample[] = [
  { intent: "inventory", text: "How many eggs are in my fridge?" },
  { intent: "inventory", text: "What do I have on the top shelf?" },
  { intent: "inventory", text: "Where is the yogurt stored?" },
  { intent: "inventory", text: "Do I have any chicken left?" },
  { intent: "inventory", text: "List the visible items in this fridge." },
  { intent: "inventory", text: "How much milk do I have?" },
  { intent: "inventory", text: "Which drinks are in the door?" },
  { intent: "inventory", text: "Show the current recorded freezer inventory." },
  { intent: "inventory", text: "Is there cheese in here?" },
  { intent: "inventory", text: "What produce is available right now?" },

  { intent: "expiry", text: "What should I use before it expires?" },
  { intent: "expiry", text: "Which foods need to be eaten soon?" },
  { intent: "expiry", text: "Plan meals around the items that are going bad first." },
  { intent: "expiry", text: "Help me reduce waste from expiring food." },
  { intent: "expiry", text: "What is closest to spoiling?" },
  { intent: "expiry", text: "Which ingredients are urgent to cook this week?" },
  { intent: "expiry", text: "Find anything past its date." },
  { intent: "expiry", text: "What should I prioritize before it goes bad?" },
  { intent: "expiry", text: "Make a use-soon plan for my fridge." },
  { intent: "expiry", text: "Which items look least fresh?" },

  { intent: "food_knowledge", text: "Is tofu safe to eat after the sell-by date?" },
  { intent: "food_knowledge", text: "How long does opened yogurt last?" },
  { intent: "food_knowledge", text: "Can I freeze cooked rice safely?" },
  { intent: "food_knowledge", text: "What temperature should leftovers be stored at?" },
  { intent: "food_knowledge", text: "Is mold on cheese dangerous?" },
  { intent: "food_knowledge", text: "How much protein is in cottage cheese?" },
  { intent: "food_knowledge", text: "Are peanuts a common allergen?" },
  { intent: "food_knowledge", text: "What does best-by mean?" },
  { intent: "food_knowledge", text: "Can raw chicken touch vegetables?" },
  { intent: "food_knowledge", text: "How do I tell if milk has spoiled?" },

  { intent: "recipe", text: "Suggest three dinner ideas with chicken." },
  { intent: "recipe", text: "What can I cook from the items in my fridge?" },
  { intent: "recipe", text: "Give me a quick breakfast recipe." },
  { intent: "recipe", text: "Find vegetarian meals I can make tonight." },
  { intent: "recipe", text: "Show me more options from those recipes.", recipeContinuation: true },
  { intent: "recipe", text: "I have jasmine rice in the pantry; what can I cook?", memoryUpdateRequested: true },
  { intent: "recipe", text: "Plan a high-protein lunch using what I have." },
  { intent: "recipe", text: "What dessert can I make with eggs and milk?" },
  { intent: "recipe", text: "Recommend a soup recipe for this week." },
  { intent: "recipe", text: "Can you give me meal ideas for the family?" },

  { intent: "shopping", text: "Add milk to my shopping list.", shoppingMode: "direct" },
  { intent: "shopping", text: "What groceries do I need to restock?", shoppingMode: "direct" },
  { intent: "shopping", text: "Buy replacements for the missing ingredients.", shoppingMode: "direct" },
  { intent: "shopping", text: "Make a grocery list for tacos.", shoppingMode: "grocery_planner" },
  { intent: "shopping", text: "Build a shopping trip for the meals you suggested.", shoppingMode: "grocery_planner" },
  { intent: "shopping", text: "Create a meal plan shopping list for this week.", shoppingMode: "grocery_planner" },
  { intent: "shopping", text: "Which pantry staples would unlock more recipes?", shoppingMode: "pantry_completion" },
  { intent: "shopping", text: "What ingredients should I keep stocked to cook more meals?", shoppingMode: "pantry_completion" },
  { intent: "shopping", text: "What should I buy to fill pantry gaps?", shoppingMode: "pantry_completion" },
  { intent: "shopping", text: "What am I missing for dinner?", shoppingMode: "direct" },

  { intent: "space", text: "Will a tall jar fit on the middle shelf?" },
  { intent: "space", text: "How much room is left in the door bin?" },
  { intent: "space", text: "Can this container fit in the freezer?" },
  { intent: "space", text: "Which shelf has enough space for a bottle?" },
  { intent: "space", text: "Is there capacity for another carton?" },
  { intent: "space", text: "How many cans could fit in the drawer?" },
  { intent: "space", text: "Do I have enough room for groceries?" },
  { intent: "space", text: "Where would a large pot fit?" },
  { intent: "space", text: "Can the left side hold a gallon jug?" },
  { intent: "space", text: "Estimate the remaining shelf capacity." },

  { intent: "organization", text: "Create a checklist to organize my refrigerator." },
  { intent: "organization", text: "How should I arrange my fridge more efficiently?" },
  { intent: "organization", text: "Group similar items together." },
  { intent: "organization", text: "Make a reorganization plan for the shelves." },
  { intent: "organization", text: "Where should I move the vegetables?" },
  { intent: "organization", text: "Help me tidy up the freezer layout." },
  { intent: "organization", text: "Put dairy and produce in better places." },
  { intent: "organization", text: "What should go in the drawer?" },
  { intent: "organization", text: "Optimize the fridge for easier scanning." },
  { intent: "organization", text: "Suggest storage groups for everything visible." },

  { intent: "placement_correction", text: "That milk is actually on the top shelf." },
  { intent: "placement_correction", text: "Move the yogurt to the door bin in the inventory." },
  { intent: "placement_correction", text: "The eggs are in the wrong shelf." },
  { intent: "placement_correction", text: "This item should be on the left side, not the right." },
  { intent: "placement_correction", text: "Correct the cheese location to the drawer." },
  { intent: "placement_correction", text: "The bottle is assigned to the wrong zone." },
  { intent: "placement_correction", text: "Put the strawberries in the produce drawer." },
  { intent: "placement_correction", text: "That container is not in the freezer door." },
  { intent: "placement_correction", text: "Update the shelf position for the chicken." },
  { intent: "placement_correction", text: "This visible item belongs in the bottom bin." },

  { intent: "general_chat", text: "I like bright acidic flavors.", memoryUpdateRequested: true },
  { intent: "general_chat", text: "I am vegetarian.", memoryUpdateRequested: true },
  { intent: "general_chat", text: "My household avoids peanuts.", memoryUpdateRequested: true },
  { intent: "general_chat", text: "Remember that I prefer spicy food.", memoryUpdateRequested: true },
  { intent: "general_chat", text: "Thanks for the help." },
  { intent: "general_chat", text: "That sounds good." },
  { intent: "general_chat", text: "I am cooking for two people.", memoryUpdateRequested: true },
  { intent: "general_chat", text: "My goal is reducing food waste.", memoryUpdateRequested: true },
  { intent: "general_chat", text: "No, I meant the other shelf." },
  { intent: "general_chat", text: "Can you remember my breakfast preference?", memoryUpdateRequested: true },

  { intent: "clarification", text: "I do not know what to ask." },
  { intent: "clarification", text: "What about it?" },
  { intent: "clarification", text: "Can you help with the thing?" },
  { intent: "clarification", text: "asdf qwer zxcv" },
  { intent: "clarification", text: "???" },
  { intent: "clarification", text: "Do something with this." },
  { intent: "clarification", text: "It is unclear." },
  { intent: "clarification", text: "Handle the food stuff." },
  { intent: "clarification", text: "Maybe that one." },
  { intent: "clarification", text: "I need help." },
];

type IntentEmbedContentRequest = EmbedContentRequest & {
  outputDimensionality: number;
};

type IntentBatchEmbedContentsRequest = BatchEmbedContentsRequest & {
  requests: IntentEmbedContentRequest[];
};

let embeddedExamplesPromise: Promise<IntentEmbeddingRecord[]> | null = null;

function createIntentEmbeddings() {
  const model = new GoogleGenerativeAI(requiredEnv("GOOGLE_API_KEY")).getGenerativeModel({
    model: INTENT_EMBEDDING_MODEL,
  });

  const requestForText = (text: string, taskType: TaskType): IntentEmbedContentRequest => ({
    content: { role: "user", parts: [{ text: text.replace(/\n/g, " ") }] },
    taskType,
    outputDimensionality: INTENT_EMBEDDING_DIMENSIONS,
  });

  return {
    async embedDocuments(documents: string[]) {
      const response = await model.batchEmbedContents({
        requests: documents.map((document) => requestForText(document, TaskType.RETRIEVAL_DOCUMENT)),
      } as IntentBatchEmbedContentsRequest);

      if (response.embeddings.length !== documents.length) {
        throw new Error(`Intent example embedding returned ${response.embeddings.length} vectors for ${documents.length} examples`);
      }

      return response.embeddings.map((embedding, index) =>
        normalizeIntentEmbedding(embedding.values, `Intent example ${index + 1}`));
    },
    async embedQuery(query: string) {
      const response = await model.embedContent(requestForText(query, TaskType.RETRIEVAL_QUERY));
      return normalizeIntentEmbedding(response.embedding.values, "Intent query");
    },
  };
}

function normalizeIntentEmbedding(values: number[] | undefined, label: string) {
  return normalizeEmbedding(values, INTENT_EMBEDDING_DIMENSIONS, label);
}

function dotProduct(left: number[], right: number[]) {
  if (left.length !== right.length) {
    throw new Error(`Intent embedding dimension mismatch: query has ${left.length}, example has ${right.length}`);
  }

  return left.reduce((sum, value, index) => sum + value * (right[index] ?? 0), 0);
}

async function embeddedExamples(dependencies: IntentEmbeddingDependencies = {}) {
  if (dependencies.embedDocuments) {
    const vectors = await dependencies.embedDocuments(INTENT_EMBEDDING_EXAMPLES.map((example) => example.text));
    return recordsFromVectors(vectors);
  }

  embeddedExamplesPromise ??= createIntentEmbeddings()
    .embedDocuments(INTENT_EMBEDDING_EXAMPLES.map((example) => example.text))
    .then(recordsFromVectors);

  return embeddedExamplesPromise;
}

function recordsFromVectors(vectors: number[][]) {
  if (vectors.length !== INTENT_EMBEDDING_EXAMPLES.length) {
    throw new Error(`Intent example embedding returned ${vectors.length} vectors for ${INTENT_EMBEDDING_EXAMPLES.length} examples`);
  }

  return vectors.map((embedding, index) => ({
    ...INTENT_EMBEDDING_EXAMPLES[index],
    embedding: normalizeIntentEmbedding(embedding, `Intent example ${index + 1}`),
  }));
}

export function selectIntentEmbeddingRoute(
  queryEmbedding: number[],
  examples: IntentEmbeddingRecord[],
): IntentEmbeddingRouteCandidate | null {
  const ranked = selectIntentEmbeddingRouteCandidates(queryEmbedding, examples);
  const best = ranked[0] ?? null;

  if (!best) return null;

  if (
    best.score < INTENT_EMBEDDING_ACCEPTANCE_THRESHOLD ||
    best.margin < INTENT_EMBEDDING_ACCEPTANCE_MARGIN
  ) {
    return null;
  }

  return best;
}

export function selectIntentEmbeddingRouteCandidates(
  queryEmbedding: number[],
  examples: IntentEmbeddingRecord[],
  limit = 3,
): IntentEmbeddingRouteCandidate[] {
  const bestByIntent = new Map<QueryIntent, IntentEmbeddingRouteCandidate>();

  for (const example of examples) {
    const score = dotProduct(queryEmbedding, example.embedding);
    const current = bestByIntent.get(example.intent);

    if (!current || score > current.score) {
      bestByIntent.set(example.intent, {
        intent: example.intent,
        score,
        margin: 0,
        example,
      });
    }
  }

  const ranked = [...bestByIntent.values()].sort((left, right) => right.score - left.score);
  return ranked.map((candidate, index) => ({
    ...candidate,
    margin: candidate.score - (ranked[index + 1]?.score ?? 0),
  })).slice(0, limit);
}

function intentResponseFromCandidate(candidate: IntentEmbeddingRouteCandidate): IntentResponse {
  return {
    intent: candidate.intent,
    recipeContinuation: candidate.example.recipeContinuation ?? false,
    shoppingMode: candidate.example.shoppingMode ?? "direct",
    enrichment: candidate.example.enrichment ?? emptyEnrichment,
    memoryUpdateRequested: candidate.example.memoryUpdateRequested ?? false,
  };
}

export async function routeIntentCandidatesByEmbedding(
  input: { query: string },
  dependencies: IntentEmbeddingDependencies = {},
): Promise<IntentEmbeddingRoutingResult> {
  try {
    const embeddings = dependencies.embedQuery && dependencies.embedDocuments
      ? {
        embedQuery: dependencies.embedQuery,
        embedDocuments: dependencies.embedDocuments,
      }
      : createIntentEmbeddings();
    const [queryEmbedding, examples] = await Promise.all([
      embeddings.embedQuery(input.query),
      embeddedExamples(dependencies),
    ]);
    const normalizedQueryEmbedding = normalizeIntentEmbedding(queryEmbedding, "Intent query");
    const candidates = selectIntentEmbeddingRouteCandidates(normalizedQueryEmbedding, examples);
    const match = selectIntentEmbeddingRoute(normalizedQueryEmbedding, examples);

    return {
      accepted: match ? intentResponseFromCandidate(match) : null,
      candidates,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Intent embedding routing failed for query "${input.query}": ${message}`);
  }
}

export async function routeIntentByEmbedding(
  input: { query: string },
  dependencies: IntentEmbeddingDependencies = {},
): Promise<IntentResponse | null> {
  return (await routeIntentCandidatesByEmbedding(input, dependencies)).accepted;
}
