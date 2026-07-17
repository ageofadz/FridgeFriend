import { Client } from "langsmith";
import { evaluate } from "langsmith/evaluation";

import { getLangSmithConfig } from "../app/server/langsmith.server";
import { createDetermineIntentNode } from "../app/server/query/nodes/determine-intent.node";
import { QueryIntentSchema, type QueryIntent } from "../app/server/query/schemas/query";
import type { FridgeQueryStateValue } from "../app/server/query/state";

const datasetName = "fridgefriend-query-intent-routing";
const langSmithConfig = getLangSmithConfig();

if (langSmithConfig === null) {
  throw new Error("LangSmith configuration is required: LANGSMITH_ENDPOINT, LANGSMITH_API_KEY, and LANGSMITH_PROJECT must be set");
}

const client = new Client({
  apiKey: langSmithConfig.apiKey,
  apiUrl: langSmithConfig.endpoint,
});

type ShoppingMode = "direct" | "grocery_planner" | "pantry_completion";

type IntentEvalInput = {
  query: string;
  recipeContinuationRequested?: boolean;
  recipeSearchSession?: boolean;
  selectedItemId?: string;
};

type IntentEvalOutput = {
  intent: QueryIntent;
  recipeContinuation: boolean | null;
  shoppingMode: ShoppingMode | null;
};

type IntentEvalFixture = {
  caseId: string;
  inputs: IntentEvalInput;
  outputs: IntentEvalOutput;
};

const fixtures: IntentEvalFixture[] = [
  {
    caseId: "inventory-location",
    inputs: { query: "Where did I put the yogurt?" },
    outputs: { intent: "inventory", recipeContinuation: false, shoppingMode: "direct" },
  },
  {
    caseId: "recipe-recommendation",
    inputs: { query: "Suggest three dinner ideas with chicken." },
    outputs: { intent: "recipe", recipeContinuation: false, shoppingMode: "direct" },
  },
  {
    caseId: "expiry-plan",
    inputs: { query: "What should I use before it expires?" },
    outputs: { intent: "expiry", recipeContinuation: false, shoppingMode: "direct" },
  },
  {
    caseId: "grocery-planner",
    inputs: { query: "Make a grocery list for tacos." },
    outputs: { intent: "shopping", recipeContinuation: false, shoppingMode: "grocery_planner" },
  },
  {
    caseId: "pantry-completion",
    inputs: { query: "Which pantry staples would unlock more recipes?" },
    outputs: { intent: "shopping", recipeContinuation: false, shoppingMode: "pantry_completion" },
  },
  {
    caseId: "storage-space",
    inputs: { query: "Will a tall jar fit on the middle shelf?" },
    outputs: { intent: "space", recipeContinuation: false, shoppingMode: "direct" },
  },
  {
    caseId: "organization-plan",
    inputs: { query: "Create a checklist to organize my refrigerator." },
    outputs: { intent: "organization", recipeContinuation: false, shoppingMode: "direct" },
  },
  {
    caseId: "food-safety",
    inputs: { query: "Is tofu safe to eat after its sell-by date?" },
    outputs: { intent: "food_knowledge", recipeContinuation: false, shoppingMode: "direct" },
  },
  {
    caseId: "blank-request",
    inputs: { query: "" },
    outputs: { intent: "clarification", recipeContinuation: null, shoppingMode: null },
  },
  {
    caseId: "recipe-session-continuation",
    inputs: { query: "Show me other options.", recipeSearchSession: true },
    outputs: { intent: "recipe", recipeContinuation: true, shoppingMode: "direct" },
  },
  {
    caseId: "explicit-recipe-continuation",
    inputs: {
      query: "Show me more dinner ideas.",
      recipeContinuationRequested: true,
      recipeSearchSession: true,
    },
    outputs: { intent: "recipe", recipeContinuation: true, shoppingMode: "direct" },
  },
  {
    caseId: "selected-item-detail",
    inputs: { query: "Get more detail about this.", selectedItemId: "milk" },
    outputs: { intent: "inventory", recipeContinuation: false, shoppingMode: "direct" },
  },
];

function recipeSearchSession() {
  return {
    profile: {
      semanticQuery: "weekday dinners",
      useAvailableIngredients: true,
      excludedIngredients: [],
      dietaryRestrictions: [],
      maxMinutes: null,
      maxCalories: null,
      minProteinDailyValue: null,
      preferredIngredients: [],
      requiredTags: [],
      preferredTags: [],
      excludedTags: [],
      memoryPreferredTags: [],
      memoryExcludedTags: [],
      memoryGoalTags: [],
      continuation: false,
    },
    inventoryFingerprint: "eggs|tortillas",
    shownRecipeIds: ["recipe-1", "recipe-2"],
  };
}

function stateForInput(input: IntentEvalInput): FridgeQueryStateValue {
  return {
    userId: "langsmith-eval-user",
    fridgeId: "langsmith-eval-fridge",
    imageId: null,
    query: input.query,
    context: {
      recipeContinuationRequested: input.recipeContinuationRequested === true,
      conversationContext: {
        selectedItemIds: input.selectedItemId ? [input.selectedItemId] : [],
        selectedZoneIds: [],
        selectedRecipeId: null,
        seededItems: input.selectedItemId
          ? [{
            itemId: input.selectedItemId,
            imageId: "langsmith-eval-image",
            cropId: `langsmith-eval-crop:${input.selectedItemId}`,
            userSeeded: true,
          }]
          : [],
      },
    },
    recipeSearchSession: input.recipeSearchSession ? recipeSearchSession() : null,
    lastRecipeSearch: null,
    recipeSearchExhausted: false,
  } as unknown as FridgeQueryStateValue;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function routingOutput(value: unknown): IntentEvalOutput {
  if (!isRecord(value)) {
    throw new Error("Determine-intent evaluation target returned a non-object result");
  }

  const parsedIntent = QueryIntentSchema.safeParse(value.intent);

  if (!parsedIntent.success) {
    throw new Error(`Determine-intent evaluation target returned an invalid intent: ${parsedIntent.error.message}`);
  }

  if (!("context" in value)) {
    return { intent: parsedIntent.data, recipeContinuation: null, shoppingMode: null };
  }

  if (!isRecord(value.context)) {
    throw new Error("Determine-intent evaluation target returned a non-object context");
  }

  if (!("intentRouting" in value.context)) {
    return { intent: parsedIntent.data, recipeContinuation: null, shoppingMode: null };
  }

  if (!isRecord(value.context.intentRouting)) {
    throw new Error("Determine-intent evaluation target returned a non-object intentRouting value");
  }

  const { recipeContinuation, shoppingMode } = value.context.intentRouting;

  if (typeof recipeContinuation !== "boolean") {
    throw new Error("Determine-intent evaluation target omitted intentRouting.recipeContinuation");
  }

  if (
    shoppingMode !== "direct" &&
    shoppingMode !== "grocery_planner" &&
    shoppingMode !== "pantry_completion"
  ) {
    throw new Error("Determine-intent evaluation target returned an invalid intentRouting.shoppingMode");
  }

  return { intent: parsedIntent.data, recipeContinuation, shoppingMode };
}

async function dataset() {
  if (await client.hasDataset({ datasetName })) {
    return client.readDataset({ datasetName });
  }

  return client.createDataset(datasetName, {
    description: "Exact-match intent routing coverage for FridgeFriend's query graph.",
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
      throw new Error(`Intent-routing dataset contains multiple examples for caseId ${caseId}`);
    }

    existingByCaseId.set(caseId, { id: example.id });
  }

  const missingFixtures = fixtures.filter((fixture) => !existingByCaseId.has(fixture.caseId));

  if (missingFixtures.length > 0) {
    await client.createExamples(missingFixtures.map((fixture) => ({
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
      throw new Error(`Intent-routing dataset contains multiple examples for caseId ${caseId}`);
    }

    examplesByCaseId.set(caseId, example);
  }

  return fixtures.map((fixture) => {
    const example = examplesByCaseId.get(fixture.caseId);

    if (!example) {
      throw new Error(`Intent-routing dataset is missing caseId ${fixture.caseId} after synchronization`);
    }

    return example;
  });
}

const determineIntent = createDetermineIntentNode({});

async function target(input: IntentEvalInput) {
  return routingOutput(await determineIntent(stateForInput(input)));
}

const targetDataset = await dataset();
await syncFixtures(targetDataset.id);
const results = await evaluate(target, {
  data: await activeExamples(targetDataset.id),
  client,
  experimentPrefix: "fridgefriend-query-intent-routing",
  maxConcurrency: 3,
  metadata: { sourceProject: langSmithConfig.project },
});

process.stdout.write(`Completed ${results.length} query intent-routing examples in LangSmith experiment ${results.experimentName}\n`);
