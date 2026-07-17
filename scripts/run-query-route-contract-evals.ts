import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Client } from "langsmith";
import { evaluate } from "langsmith/evaluation";

import type { FridgeFriendChatModel } from "../app/server/ai/chat-model.server";
import { getLangSmithConfig } from "../app/server/langsmith.server";
import type { MemoryContext } from "../app/server/memory/schemas";
import type { QueryGraphDependencies, QueryIntent } from "../app/server/query/schemas/query";

const databaseDirectory = mkdtempSync(path.join(tmpdir(), "fridgefriend-query-route-contract-"));
const previousDatabasePath = process.env.DATABASE_PATH;
process.env.DATABASE_PATH = path.join(databaseDirectory, "route-contract.sqlite");

const [{ ChatPromptTemplate }, { createQueryGraph }] = await Promise.all([
  import("@langchain/core/prompts"),
  import("../app/server/query/graph.server"),
]);

const datasetName = "fridgefriend-query-route-contract";
const langSmithConfig = getLangSmithConfig();

if (langSmithConfig === null) {
  throw new Error("LangSmith configuration is required: LANGSMITH_ENDPOINT, LANGSMITH_API_KEY, and LANGSMITH_PROJECT must be set");
}

const client = new Client({
  apiKey: langSmithConfig.apiKey,
  apiUrl: langSmithConfig.endpoint,
});

type ShoppingMode = "direct" | "grocery_planner" | "pantry_completion";
type RouteNode =
  | "query_inventory"
  | "plan_expiry"
  | "build_recipe_search"
  | "retrieve_recipes"
  | "calculate_space"
  | "plan_organization"
  | "request_clarification"
  | "respond";

type RouteContractInput = {
  query: string;
  intent: QueryIntent;
  shoppingMode: ShoppingMode;
};

type RouteContractOutput = {
  expectedRoute: RouteNode[];
};

type RouteContractFixture = {
  caseId: string;
  inputs: RouteContractInput;
  outputs: RouteContractOutput;
};

const fixtures: RouteContractFixture[] = [
  {
    caseId: "inventory-tool",
    inputs: { query: "How many eggs do I have?", intent: "inventory", shoppingMode: "direct" },
    outputs: { expectedRoute: ["query_inventory"] },
  },
  {
    caseId: "expiry-plan",
    inputs: { query: "What should I use before it expires?", intent: "expiry", shoppingMode: "direct" },
    outputs: { expectedRoute: ["query_inventory", "plan_expiry"] },
  },
  {
    caseId: "recipe-retrieval",
    inputs: { query: "Suggest a vegetarian dinner.", intent: "recipe", shoppingMode: "direct" },
    outputs: { expectedRoute: ["query_inventory", "build_recipe_search", "retrieve_recipes"] },
  },
  {
    caseId: "shopping-direct-inventory",
    inputs: { query: "Add milk to my shopping list.", intent: "shopping", shoppingMode: "direct" },
    outputs: { expectedRoute: ["query_inventory"] },
  },
  {
    caseId: "shopping-grocery-retrieval",
    inputs: { query: "Build a grocery list for tacos.", intent: "shopping", shoppingMode: "grocery_planner" },
    outputs: { expectedRoute: ["query_inventory", "build_recipe_search", "retrieve_recipes"] },
  },
  {
    caseId: "shopping-pantry-retrieval",
    inputs: { query: "Which pantry staples unlock more recipes?", intent: "shopping", shoppingMode: "pantry_completion" },
    outputs: { expectedRoute: ["query_inventory", "build_recipe_search", "retrieve_recipes"] },
  },
  {
    caseId: "food-knowledge-lookup",
    inputs: { query: "Is tofu safe to eat after its sell-by date?", intent: "food_knowledge", shoppingMode: "direct" },
    outputs: { expectedRoute: ["respond"] },
  },
  {
    caseId: "space-calculation",
    inputs: { query: "Will a tall jar fit on the middle shelf?", intent: "space", shoppingMode: "direct" },
    outputs: { expectedRoute: ["calculate_space"] },
  },
  {
    caseId: "organization-plan",
    inputs: { query: "Create a checklist to organize my refrigerator.", intent: "organization", shoppingMode: "direct" },
    outputs: { expectedRoute: ["query_inventory", "plan_organization"] },
  },
  {
    caseId: "clarification-response",
    inputs: { query: "", intent: "clarification", shoppingMode: "direct" },
    outputs: { expectedRoute: ["request_clarification"] },
  },
];

const routeNodes: Set<string> = new Set(fixtures.flatMap((fixture) => fixture.outputs.expectedRoute));

function emptyMemoryContext(): MemoryContext {
  return {
    externalInventory: [],
    dietaryRestrictions: [],
    dietaryPreferences: [],
    activeGoals: [],
    semanticMemories: [],
  };
}

function structuredModel(result: unknown): FridgeFriendChatModel {
  return {
    withStructuredOutput: () => ({
      invoke: async () => result,
    }),
  } as unknown as FridgeFriendChatModel;
}

function promptBundle(): NonNullable<QueryGraphDependencies["promptBundle"]> {
  const prompt = {
    name: "fridgefriend-query-route-contract",
    ref: "fridgefriend-query-route-contract:latest",
    prompt: ChatPromptTemplate.fromMessages([["human", "{{query}}"]], { templateFormat: "mustache" }),
  };

  return {
    queryMemoryExtraction: prompt,
    queryRecipeSearch: prompt,
    queryResponse: prompt,
  } as NonNullable<QueryGraphDependencies["promptBundle"]>;
}

function routeContractDependencies(input: RouteContractInput): QueryGraphDependencies {
  return {
    promptBundle: promptBundle(),
    loadMemoryContext: () => emptyMemoryContext(),
    persistMemoryValidations: async () => [],
    seededInventoryAssertionModel: structuredModel({ assertions: [] }),
    memoryExtractionModel: structuredModel({ candidates: [] }),
    responseModel: {
      invoke: async () => ({ content: "route contract response" }),
    } as unknown as FridgeFriendChatModel,
    intentModel: structuredModel({
      intent: input.intent,
      recipeContinuation: false,
      shoppingMode: input.shoppingMode,
      enrichment: { itemNames: [], fields: [] },
    }),
    recipeSearchModel: structuredModel({
      semanticQuery: "route contract recipe search",
      intent: { specific: true, relatedSemanticQuery: null },
      useAvailableIngredients: false,
      excludedIngredients: [],
      dietaryRestrictions: [],
      maxMinutes: null,
      maxCalories: null,
      minProteinDailyValue: null,
      preferredIngredients: [],
      requiredTags: [],
      preferredTags: [],
      excludedTags: [],
    }),
    householdInventoryTool: {
      invoke: async () => ({
        operation: "list" as const,
        status: "ok" as const,
        message: "Listed 0 household inventory items",
        item: null,
        items: [],
      }),
    },
    loadInventoryForImage: () => null,
    listFoodComTags: () => [],
    searchRecipeCandidates: async () => [],
    getRecipeCandidatesByTags: () => [],
    getRecipeCandidatesByIngredients: () => [],
    getPantryCompletionRecipeCandidates: () => [],
    getRecipesByIds: () => [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function taskName(chunk: unknown): string | null {
  if (!isRecord(chunk) || chunk.type !== "task" || !isRecord(chunk.payload)) {
    return null;
  }

  return typeof chunk.payload.name === "string" ? chunk.payload.name : null;
}

async function target(input: RouteContractInput) {
  const graph = createQueryGraph(routeContractDependencies(input));
  const targetNode = fixtureForInput(input).outputs.expectedRoute.at(-1);

  if (!targetNode) {
    throw new Error("Route-contract fixture has no expected terminal node");
  }

  const threadId = `route-contract-${randomUUID()}`;
  const stream = await graph.stream({
    userId: "langsmith-eval-user",
    fridgeId: "langsmith-eval-fridge",
    imageId: null,
    query: input.query,
    threadId,
    requestId: "",
    context: {
      recipeContinuationRequested: false,
      conversationContext: {
        selectedItemIds: [],
        selectedZoneIds: [],
        selectedRecipeId: null,
        seededItems: [],
      },
      workspaceActions: [],
    },
  }, {
    configurable: { thread_id: threadId },
    streamMode: "debug",
    interruptAfter: [targetNode],
  });
  const trajectory: string[] = [];

  for await (const chunk of stream) {
    const name = taskName(chunk);

    if (name && routeNodes.has(name)) {
      trajectory.push(name);
    }
  }

  return { trajectory };
}

function fixtureForInput(input: RouteContractInput): RouteContractFixture {
  const fixture = fixtures.find((candidate) =>
    candidate.inputs.query === input.query &&
    candidate.inputs.intent === input.intent &&
    candidate.inputs.shoppingMode === input.shoppingMode,
  );

  if (!fixture) {
    throw new Error(`No route-contract fixture matches ${JSON.stringify(input)}`);
  }

  return fixture;
}

function stringArray(value: unknown, source: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${source} must be an array of node names`);
  }

  return value;
}

function routeContractEvaluator({ outputs, referenceOutputs }: EvaluationArgs) {
  if (!isRecord(outputs)) {
    throw new Error("Route-contract target returned no outputs object");
  }

  if (!isRecord(referenceOutputs)) {
    throw new Error("Route-contract dataset example returned no outputs object");
  }

  const actual = stringArray(outputs.trajectory, "Route-contract target trajectory");
  const expected = stringArray(referenceOutputs.expectedRoute, "Route-contract expectedRoute");
  const score = Number(JSON.stringify(actual) === JSON.stringify(expected));

  return {
    key: "route_contract_exact_match",
    score,
    comment: `Expected ${expected.join(" -> ")}, received ${actual.join(" -> ")}`,
  };
}

type EvaluationArgs = {
  outputs: Record<string, unknown>;
  referenceOutputs?: Record<string, unknown>;
};

async function dataset() {
  if (await client.hasDataset({ datasetName })) {
    return client.readDataset({ datasetName });
  }

  return client.createDataset(datasetName, {
    description: "Compiled FridgeFriend query-graph routing contracts with model and persistence dependencies isolated.",
    dataType: "kv",
  });
}

async function syncFixtures(datasetId: string) {
  const existingByCaseId = new Map<string, { id: string }>();

  for await (const example of client.listExamples({ datasetId })) {
    const caseId = example.metadata?.caseId;

    if (typeof caseId !== "string") {
      continue;
    }

    if (existingByCaseId.has(caseId)) {
      throw new Error(`Route-contract dataset contains multiple examples for caseId ${caseId}`);
    }

    existingByCaseId.set(caseId, { id: example.id });
  }

  const missing = fixtures.filter((fixture) => !existingByCaseId.has(fixture.caseId));

  if (missing.length > 0) {
    await client.createExamples(missing.map((fixture) => ({
      dataset_id: datasetId,
      inputs: fixture.inputs,
      outputs: fixture.outputs,
      metadata: { caseId: fixture.caseId },
    })));
  }

  for (const fixture of fixtures) {
    const existing = existingByCaseId.get(fixture.caseId);

    if (!existing) {
      continue;
    }

    await client.updateExample({
      id: existing.id,
      inputs: fixture.inputs,
      outputs: fixture.outputs,
      metadata: { caseId: fixture.caseId },
    });
  }
}

async function activeExamples(datasetId: string) {
  const examplesByCaseId = new Map<string, Awaited<ReturnType<typeof client.readExample>>>();

  for await (const example of client.listExamples({ datasetId })) {
    const caseId = example.metadata?.caseId;

    if (typeof caseId !== "string") {
      continue;
    }

    if (examplesByCaseId.has(caseId)) {
      throw new Error(`Route-contract dataset contains multiple examples for caseId ${caseId}`);
    }

    examplesByCaseId.set(caseId, example);
  }

  return fixtures.map((fixture) => {
    const example = examplesByCaseId.get(fixture.caseId);

    if (!example) {
      throw new Error(`Route-contract dataset is missing caseId ${fixture.caseId} after synchronization`);
    }

    return example;
  });
}

try {
  const targetDataset = await dataset();
  await syncFixtures(targetDataset.id);
  const results = await evaluate(target, {
    data: await activeExamples(targetDataset.id),
    client,
    experimentPrefix: "fridgefriend-query-route-contract",
    maxConcurrency: 1,
    metadata: { sourceProject: langSmithConfig.project },
    evaluators: [routeContractEvaluator],
  });

  process.stdout.write(`Completed ${results.length} query route-contract examples in LangSmith experiment ${results.experimentName}\n`);
} finally {
  rmSync(databaseDirectory, { recursive: true, force: true });
  if (previousDatabasePath === undefined) {
    delete process.env.DATABASE_PATH;
  } else {
    process.env.DATABASE_PATH = previousDatabasePath;
  }
}
