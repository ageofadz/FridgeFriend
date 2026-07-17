import { AIMessage } from "@langchain/core/messages";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import type { FridgeFriendChatModel } from "../../../../app/server/ai/chat-model.server";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { encode as encodeJpeg } from "jpeg-js";
import path from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

import {
  isVisibleResponseMessageMetadata,
  resumeQueryForFridgeImage,
  runQueryForFridgeImage,
  streamQueryForFridgeImage,
} from "../../../../app/server/query/graph.server";
import { shouldExtractMemoryCandidates } from "../../../../app/server/query/nodes/extract-memory-candidates.node";
import type { FridgeQueryStateValue } from "../../../../app/server/query/state";
import {
  QUERY_VISIBLE_RESPONSE_TAG,
  type IntentRoutingChoice,
  type QueryGraphDependencies,
  type QueryIntent,
  type QueryStreamEvent,
} from "../../../../app/server/query/schemas/query";
import type { MemoryCandidate, MemoryContext, MemoryValidationResult } from "../../../../app/server/memory/schemas";
import { listStructuredMemoryContext } from "../../../../app/server/memory/repository.server";
import { PromptName } from "../../../../app/server/prompts/registry.server";
import type { Recipe } from "../../../../app/server/recipes/types";
import { createFridgeImage } from "../../../../app/server/images.server";
import { getFridgeInventoryForImage, saveFridgeInventory } from "../../../../app/server/inventories.server";
import type { Inventory } from "../../../../app/server/scan/schemas/inventory";

function setLangSmithEnv() {
  process.env.LANGSMITH_API_KEY = "test-key";
  process.env.LANGSMITH_TRACING = "true";
  process.env.LANGSMITH_PROJECT = "test-project";
  process.env.LANGSMITH_PROMPT_ENVIRONMENT = "dev";
  process.env.LANGSMITH_ENDPOINT = "https://api.smith.langchain.com";
}

function createJpegDataUrl() {
  const jpeg = encodeJpeg(
    {
      data: Buffer.from([
        255, 0, 0, 255,
        0, 255, 0, 255,
        0, 0, 255, 255,
        255, 255, 255, 255,
      ]),
      width: 2,
      height: 2,
    },
    100,
  );

  return `data:image/jpeg;base64,${Buffer.from(jpeg.data).toString("base64")}`;
}

function createInventory(input: {
  observations?: Inventory["items"][number]["loc"]["observations"];
  item?: Partial<Inventory["items"][number]>;
} = {}): Inventory {
  const item = input.item ?? {};

  return {
    id: "inventory-1",
    fridgeId: "fridge-1",
    scanId: "scan-1",
    source: "mocked-vision",
    model: "test-model",
    createdAt: "2026-07-16T00:00:00.000Z",
    items: [
      {
        id: item.id ?? "item-1",
        name: item.name ?? "chicken",
        label: item.label ?? "Chicken",
        cat: item.cat ?? "meat",
        subcat: item.subcat ?? null,
        qty: {
          amount: item.qty && "amount" in item.qty ? item.qty.amount : 1,
          unit: item.qty && "unit" in item.qty ? item.qty.unit : "package",
          precision: item.qty && "precision" in item.qty ? item.qty.precision : "estimated",
          fillLevel: item.qty && "fillLevel" in item.qty ? item.qty.fillLevel : null,
        },
        pack: item.pack ?? "tray",
        loc: {
          status: "matched",
          zoneId: "zone-1",
          zoneType: "shelf",
          observations: input.observations ?? [],
          confidence: 0.9,
        },
        conf: item.conf ?? 0.9,
        src: ["detection-1"],
        attrs: item.attrs ?? {
          brand: null,
          variant: null,
          opened: null,
          expirationDate: null,
        },
        review: "inferred",
      },
    ],
    zones: [],
  };
}

function withTestDatabase<T>(callback: () => Promise<T>) {
  const databasePath = path.join(
    tmpdir(),
    `fridgefriend-query-graph-test-${randomUUID()}.sqlite`,
  );
  const previousTracing = process.env.LANGSMITH_TRACING;
  process.env.DATABASE_PATH = databasePath;
  delete process.env.LANGSMITH_TRACING;

  return callback().finally(() => {
    rmSync(databasePath, { force: true });
    rmSync(`${databasePath}-wal`, { force: true });
    rmSync(`${databasePath}-shm`, { force: true });
    delete process.env.DATABASE_PATH;
    if (previousTracing === undefined) {
      delete process.env.LANGSMITH_TRACING;
    } else {
      process.env.LANGSMITH_TRACING = previousTracing;
    }
  });
}

function createRecipe(input: {
  id: string;
  name: string;
  ingredients: string[];
  semanticDescription?: string;
  minutes?: number;
  tags?: string[];
}): Recipe {
  return {
    id: input.id,
    name: input.name,
    description: input.semanticDescription ?? `${input.name} description.`,
    ingredients: input.ingredients.map((ingredient) => ({
      rawName: ingredient,
      canonicalName: ingredient,
    })),
    tags: input.tags ?? ["dinner"],
    steps: ["Cook."],
    minutes: input.minutes ?? 20,
    stepCount: 1,
    ingredientCount: input.ingredients.length,
    nutrition: {
      calories: 400,
      totalFatDailyValue: null,
      sugarDailyValue: null,
      sodiumDailyValue: null,
      proteinDailyValue: 20,
      saturatedFatDailyValue: null,
      carbohydratesDailyValue: null,
    },
    rating: { average: 4, count: 5 },
  };
}

function emptyMemoryContext(): MemoryContext {
  return {
    externalInventory: [],
    dietaryRestrictions: [],
    dietaryPreferences: [],
    activeGoals: [],
    semanticMemories: [],
  };
}

function createStructuredModel(result: unknown) {
  return {
    withStructuredOutput: () => ({
      invoke: async () => result,
    }),
  } as unknown as FridgeFriendChatModel;
}

function intentChoicesForResult(result: unknown): IntentRoutingChoice[] {
  const intent = typeof result === "object" &&
    result !== null &&
    "intent" in result &&
    typeof result.intent === "string"
    ? result.intent as QueryIntent
    : "inventory";
  const intents = [
    intent,
    "recipe",
    "organization",
    "inventory",
  ].filter((candidate, index, candidates) => candidates.indexOf(candidate) === index).slice(0, 3) as QueryIntent[];

  return intents.map((candidate, index) => ({
    intent: candidate,
    score: 0.9 - index * 0.1,
    margin: 0.1,
    example: {
      intent: candidate,
      text: `${candidate} example`,
    },
  }));
}

function testPromptBundle(): NonNullable<QueryGraphDependencies["promptBundle"]> {
  return {
    queryMemoryExtraction: {
      name: PromptName.QueryMemoryExtraction,
      ref: "fridgefriend-query-memory-extraction:latest",
      prompt: ChatPromptTemplate.fromMessages([
        ["system", "Extract only durable memory candidates from the user's message."],
        ["human", "{{query}}"],
      ], { templateFormat: "mustache" }),
    },
    queryRecipeSearch: {
      name: PromptName.QueryRecipeSearch,
      ref: "fridgefriend-query-recipe-search:latest",
      prompt: ChatPromptTemplate.fromMessages([
        ["system", "Extract recipe-search constraints from the user's request."],
        ["human", "{{query}}"],
      ], { templateFormat: "mustache" }),
    },
    recipeRetrievalGrade: {
      name: PromptName.RecipeRetrievalGrade,
      ref: "fridgefriend-recipe-retrieval-grade:latest",
      prompt: ChatPromptTemplate.fromMessages([["human", "{{recipe_retrieval_context_json}}"]], { templateFormat: "mustache" }),
    },
    recipeTournamentEvaluation: {
      name: PromptName.RecipeTournamentEvaluation,
      ref: "fridgefriend-recipe-tournament-evaluation:latest",
      prompt: ChatPromptTemplate.fromMessages([["human", "{{recipe_tournament_context_json}}"]], { templateFormat: "mustache" }),
    },
    groceryRecipeSelection: {
      name: PromptName.GroceryRecipeSelection,
      ref: "fridgefriend-grocery-recipe-selection:latest",
      prompt: ChatPromptTemplate.fromMessages([["human", "{{grocery_recipe_selection_context_json}}"]], { templateFormat: "mustache" }),
    },
    groceryAisleAssignment: {
      name: PromptName.GroceryAisleAssignment,
      ref: "fridgefriend-grocery-aisle-assignment:latest",
      prompt: ChatPromptTemplate.fromMessages([["human", "{{grocery_aisle_assignment_context_json}}"]], { templateFormat: "mustache" }),
    },
    intentRouting: {
      name: PromptName.IntentRouting,
      ref: "fridgefriend-intent-routing:latest",
      prompt: ChatPromptTemplate.fromMessages([["human", "{{intent_routing_context_json}}"]], { templateFormat: "mustache" }),
    },
    seededInventoryAssertions: {
      name: PromptName.SeededInventoryAssertions,
      ref: "fridgefriend-seeded-inventory-assertions:latest",
      prompt: ChatPromptTemplate.fromMessages([["human", "{{seeded_inventory_assertion_context_json}}"]], { templateFormat: "mustache" }),
    },
    focusedInventoryEnrichment: {
      name: PromptName.FocusedInventoryEnrichment,
      ref: "fridgefriend-focused-inventory-enrichment:latest",
      prompt: ChatPromptTemplate.fromMessages([["human", "{{focused_inventory_enrichment_context_json}}"]], { templateFormat: "mustache" }),
    },
    inventoryClarificationUser: {
      name: PromptName.InventoryClarificationUser,
      ref: "fridgefriend-inventory-clarification-user:latest",
      prompt: ChatPromptTemplate.fromMessages([["human", "{{inventory_clarification_context_json}}"]], { templateFormat: "mustache" }),
    },
    inventoryClarificationInference: {
      name: PromptName.InventoryClarificationInference,
      ref: "fridgefriend-inventory-clarification-inference:latest",
      prompt: ChatPromptTemplate.fromMessages([["human", "{{inventory_clarification_context_json}}"]], { templateFormat: "mustache" }),
    },
    queryResponse: {
      name: PromptName.QueryResponse,
      ref: "fridgefriend-query-response:latest",
      prompt: ChatPromptTemplate.fromMessages([
        [
          "system",
          "You are the FridgeFriend inventory agent. For quantity questions, distinguish the number of packages or cartons from the number of items inside them.",
        ],
        ["human", "{{query_context_json}}"],
      ], { templateFormat: "mustache" }),
    },
  };
}

function fakeDeps(input: {
  intent?: QueryIntent;
  intentResult?: unknown;
  recipeSearch?: unknown;
  memoryCandidates?: MemoryCandidate[];
  memoryContext?: MemoryContext;
  responseModel?: FridgeFriendChatModel;
  overrides?: Partial<QueryGraphDependencies>;
} = {}): QueryGraphDependencies {
  const intentModel = {
    withStructuredOutput: () => ({
      invoke: async () => {
        const result = input.intentResult ?? { intent: input.intent ?? "inventory" };

        if (typeof result !== "object" || result === null || "memoryUpdateRequested" in result) {
          return result;
        }

        return {
          ...result,
          memoryUpdateRequested: (input.memoryCandidates?.length ?? 0) > 0,
        };
      },
    }),
  } as unknown as FridgeFriendChatModel;
  const responseModel = {
    invoke: async () => new AIMessage("Final streamed answer"),
  } as unknown as FridgeFriendChatModel;

  return {
    promptBundle: testPromptBundle(),
    loadInventoryForImage: () => createInventory(),
    householdInventoryTool: {
      invoke: async () => ({
        operation: "list",
        status: "ok",
        message: "Listed 0 household inventory items",
        item: null,
        items: [],
      }),
    },
    loadMemoryContext: () => input.memoryContext ?? emptyMemoryContext(),
    intentEmbeddingRouter: async () => ({
      accepted: null,
      candidates: intentChoicesForResult(input.intentResult ?? { intent: input.intent ?? "inventory" }),
    }),
    persistMemoryValidations: async ({ validations }) =>
      validations.map((validation) => ({
        result: {
          kind: validation.candidate.kind,
          action: validation.candidate.action,
          status: validation.accepted ? "persisted" : "skipped",
          targetId: validation.accepted ? "memory-target-1" : null,
          message: validation.reason,
        },
        semanticMemory: null,
      })),
    memoryExtractionModel: createStructuredModel({
      candidates: input.memoryCandidates ?? [],
    }),
    intentModel,
    seededInventoryAssertionModel: createStructuredModel({ assertions: [] }),
    recipeSearchModel: createStructuredModel(input.recipeSearch ?? {
      facets: [],
      intent: { specific: false },
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
    recipeRetrievalGradeModel: createStructuredModel({ relevant: true, reason: "Relevant recipe set" }),
    recipeTournamentModel: createStructuredModel({
      nutrition: 8,
      ingredientCoverage: 8,
      difficulty: 8,
      wasteReduction: 8,
      preferenceMatch: 8,
    }),
    responseModel: input.responseModel ?? responseModel,
    ...input.overrides,
  };
}

describe("query graph streaming", () => {
  it("streams smart pantry completion without recipe tournament events", async () => {
    const recipes = [
      createRecipe({ id: "one", name: "Garlic chicken", ingredients: ["chicken", "garlic"] }),
      createRecipe({ id: "two", name: "Ginger chicken", ingredients: ["chicken", "ginger"] }),
      createRecipe({ id: "three", name: "Garlic ginger chicken", ingredients: ["chicken", "garlic", "ginger"] }),
    ];
    const events: QueryStreamEvent[] = [];

    for await (const event of streamQueryForFridgeImage(
      {
        fridgeId: "fridge-1",
        imageId: "image-1",
        query: "Which pantry staples unlock more recipes?",
        threadId: `test-${randomUUID()}`,
      },
      fakeDeps({
        intent: "shopping",
        intentResult: { intent: "shopping", shoppingMode: "pantry_completion", enrichment: { itemNames: [], fields: [] } },
        memoryCandidates: [
          {
            kind: "dietary_restriction",
            scope: "user",
            action: "upsert",
            restrictionType: "other",
            subject: "vegetarian",
            severity: "strict_avoid",
            notes: null,
            explicit: true,
          },
        ],
        overrides: {
          searchRecipeCandidates: async () => [],
          getRecipeCandidatesByTags: () => [],
          getPantryCompletionRecipeCandidates: () => recipes.map((recipe) => ({
            recipeId: recipe.id,
            ingredientScore: 1,
            matchedIngredients: ["chicken"],
            missingIngredientCount: recipe.ingredients.length - 1,
          })),
          getRecipesByIds: () => recipes,
          listFoodComTags: () => [],
          groceryAisleAssignmentModel: createStructuredModel({
            assignments: [
              { ingredient: "garlic", aisle: "produce" },
              { ingredient: "ginger", aisle: "produce" },
            ],
          }),
        },
      }),
    )) {
      events.push(event);
    }

    expect(events.some((event) => event.type === "pantry_completion")).toBe(true);
    expect(events.some((event) => event.type === "recipe_tournament_started")).toBe(false);
    expect(events.at(-1)).toMatchObject({
      type: "final",
      pantryCompletionPlan: { unlockedRecipeCount: 3 },
    });
  });

  it("streams pantry completion when fewer than three relevant completions exist", async () => {
    const recipes = [
      createRecipe({ id: "one", name: "Garlic chicken", ingredients: ["chicken", "garlic"] }),
      createRecipe({ id: "two", name: "Ginger chicken", ingredients: ["chicken", "ginger"] }),
    ];
    const events: QueryStreamEvent[] = [];

    for await (const event of streamQueryForFridgeImage(
      {
        fridgeId: "fridge-1",
        imageId: "image-1",
        query: "Which pantry staples unlock more recipes?",
        threadId: `test-${randomUUID()}`,
      },
      fakeDeps({
        intent: "shopping",
        intentResult: { intent: "shopping", shoppingMode: "pantry_completion", enrichment: { itemNames: [], fields: [] } },
        memoryCandidates: [
          {
            kind: "dietary_restriction",
            scope: "user",
            action: "upsert",
            restrictionType: "other",
            subject: "vegetarian",
            severity: "strict_avoid",
            notes: null,
            explicit: true,
          },
        ],
        overrides: {
          searchRecipeCandidates: async () => [],
          getRecipeCandidatesByTags: () => [],
          getPantryCompletionRecipeCandidates: () => recipes.map((recipe) => ({
            recipeId: recipe.id,
            ingredientScore: 1,
            matchedIngredients: ["chicken"],
            missingIngredientCount: 1,
          })),
          getRecipesByIds: () => recipes,
          listFoodComTags: () => [],
          groceryAisleAssignmentModel: createStructuredModel({
            assignments: [
              { ingredient: "garlic", aisle: "produce" },
              { ingredient: "ginger", aisle: "produce" },
            ],
          }),
        },
      }),
    )) {
      events.push(event);
    }

    expect(events.find((event) => event.type === "pantry_completion")).toMatchObject({
      type: "pantry_completion",
      plan: { unlockedRecipeCount: 2 },
    });
    expect(events.some((event) => event.type === "pantry_completion_clarification")).toBe(false);
    expect(events.some((event) => event.type === "pantry_completion_error")).toBe(false);
    expect(events.at(-1)).toMatchObject({
      type: "final",
      pantryCompletionPlan: { unlockedRecipeCount: 2 },
      pantryCompletionError: undefined,
      pantryCompletionClarification: undefined,
    });
  });

  it("streams smart pantry completion for a vegetarian grocery request after durable memory reload", async () => {
    const vegetarianRestriction = {
      id: "restriction-vegetarian",
      userId: "default-user",
      restrictionType: "other" as const,
      subject: "vegetarian",
      severity: "strict_avoid" as const,
      notes: null,
      source: "user_explicit",
      createdAt: "2026-07-17T00:00:00.000Z",
      updatedAt: "2026-07-17T00:00:00.000Z",
    };
    const recipes = [
      createRecipe({ id: "veg-one", name: "Tofu Garlic Bowl", ingredients: ["tofu", "garlic", "water"], tags: ["dinner", "vegetarian"] }),
      createRecipe({ id: "veg-two", name: "Ginger Tofu Stir Fry", ingredients: ["tofu", "ginger", "kosher salt"], tags: ["dinner", "vegetarian"] }),
      createRecipe({ id: "veg-three", name: "Garlic Ginger Tofu", ingredients: ["tofu", "garlic", "ginger"], tags: ["dinner", "vegetarian"] }),
      createRecipe({ id: "meat-one", name: "Garlic Chicken", ingredients: ["chicken", "garlic"], tags: ["dinner"] }),
    ];
    let memoryLoadCount = 0;
    const persistedValidations: MemoryValidationResult[] = [];
    const events: QueryStreamEvent[] = [];

    for await (const event of streamQueryForFridgeImage(
      {
        fridgeId: "fridge-1",
        imageId: "image-1",
        query: "What can I get from the grocery store to make a lot of recipes? I'm vegetarian.",
        threadId: `test-${randomUUID()}`,
      },
      fakeDeps({
        intent: "shopping",
        intentResult: { intent: "shopping", shoppingMode: "pantry_completion", enrichment: { itemNames: [], fields: [] } },
        memoryCandidates: [
          {
            kind: "dietary_restriction",
            scope: "user",
            action: "upsert",
            restrictionType: "other",
            subject: "vegetarian",
            severity: "strict_avoid",
            notes: null,
            explicit: true,
          },
        ],
        overrides: {
          loadInventoryForImage: () => createInventory({
            item: {
              name: "tofu",
              label: "Tofu",
              cat: "other",
              subcat: "tofu",
              pack: "box",
            },
          }),
          loadMemoryContext: () => {
            memoryLoadCount += 1;
            return memoryLoadCount === 1
              ? emptyMemoryContext()
              : { ...emptyMemoryContext(), dietaryRestrictions: [vegetarianRestriction] };
          },
          persistMemoryValidations: async ({ validations }) => {
            persistedValidations.push(...validations);
            return validations.map((validation) => ({
              result: {
                kind: validation.candidate.kind,
                action: validation.candidate.action,
                status: validation.accepted ? "persisted" : "skipped",
                targetId: validation.accepted ? "restriction-vegetarian" : null,
                message: validation.reason,
              },
              semanticMemory: null,
            }));
          },
          searchRecipeCandidates: async () => [],
          getRecipeCandidatesByTags: () => recipes.map((recipe) => ({
            recipeId: recipe.id,
            tagScore: recipe.tags.includes("vegetarian") ? 1 : 0,
            matchedTags: recipe.tags,
          })),
          getPantryCompletionRecipeCandidates: () => recipes.map((recipe) => ({
            recipeId: recipe.id,
            ingredientScore: 1,
            matchedIngredients: ["tofu"],
            missingIngredientCount: recipe.ingredients.length - 1,
          })),
          getRecipesByIds: () => recipes,
          listFoodComTags: () => ["vegetarian"],
          groceryAisleAssignmentModel: createStructuredModel({
            assignments: [
              { ingredient: "garlic", aisle: "produce" },
              { ingredient: "ginger", aisle: "produce" },
            ],
          }),
        },
      }),
    )) {
      events.push(event);
    }

    const statusNodes = events.flatMap((event) => event.type === "status" && event.node ? [event.node] : []);
    const pantryEvent = events.find((event) => event.type === "pantry_completion");
    const finalEvent = events.at(-1);

    expect(statusNodes).toContain("extract_memory_candidates");
    expect(statusNodes).toContain("reload_memory_context");
    expect(statusNodes).toContain("plan_pantry_completion");
    expect(persistedValidations).toEqual([
      expect.objectContaining({
        accepted: true,
        candidate: expect.objectContaining({ kind: "dietary_restriction", subject: "vegetarian" }),
      }),
    ]);
    expect(pantryEvent).toMatchObject({
      type: "pantry_completion",
      plan: {
        unlockedRecipeCount: 3,
        suggestions: [
          { ingredient: "garlic" },
          { ingredient: "ginger" },
        ],
        unlockedRecipes: [
          { id: "veg-one", name: "Tofu Garlic Bowl" },
          { id: "veg-two", name: "Ginger Tofu Stir Fry" },
          { id: "veg-three", name: "Garlic Ginger Tofu" },
        ],
      },
    });
    if (!pantryEvent || pantryEvent.type !== "pantry_completion") {
      throw new Error("Expected pantry completion event");
    }
    expect(pantryEvent.plan.suggestions.map((suggestion) => suggestion.ingredient)).not.toContain("water");
    expect(pantryEvent.plan.suggestions.map((suggestion) => suggestion.ingredient)).not.toContain("kosher salt");
    expect(finalEvent).toMatchObject({
      type: "final",
      pantryCompletionPlan: {
        unlockedRecipes: [
          { name: "Tofu Garlic Bowl" },
          { name: "Ginger Tofu Stir Fry" },
          { name: "Garlic Ginger Tofu" },
        ],
      },
      dietaryRestrictions: [expect.objectContaining({ subject: "vegetarian" })],
    });
  });

  it("only streams message chunks from the visible response model call", () => {
    expect(isVisibleResponseMessageMetadata({
      langgraph_node: "respond",
      tags: ["query", "focused_enrichment"],
    })).toBe(false);
    expect(isVisibleResponseMessageMetadata({
      langgraph_node: "respond",
      tags: ["query", "respond", QUERY_VISIBLE_RESPONSE_TAG],
    })).toBe(true);
  });

  it("streams graph status updates before final output", async () => {
    setLangSmithEnv();

    const events: QueryStreamEvent[] = [];

    for await (const event of streamQueryForFridgeImage(
      {
        fridgeId: "fridge-1",
        imageId: "image-1",
        query: "What is in here?",
        threadId: `test-${randomUUID()}`,
      },
      fakeDeps({
        memoryContext: {
          ...emptyMemoryContext(),
          dietaryRestrictions: [{
            id: "restriction-1",
            userId: "default-user",
            restrictionType: "allergy",
            subject: "peanuts",
            severity: "strict_avoid",
            notes: null,
            source: "user_explicit",
            createdAt: "2026-07-17T00:00:00.000Z",
            updatedAt: "2026-07-17T00:00:00.000Z",
          }],
          dietaryPreferences: [{
            id: "preference-1",
            userId: "default-user",
            subject: "vegetarian",
            sentiment: "prefer",
            strength: 5,
            notes: null,
            source: "user_explicit",
            createdAt: "2026-07-17T00:00:00.000Z",
            updatedAt: "2026-07-17T00:00:00.000Z",
          }],
        },
      }),
    )) {
      events.push(event);
    }

    expect(events[0]).toEqual({
      type: "status",
      node: "load_context",
      message: "Loading query context.",
    });
    expect(events.some((event) => event.type === "status")).toBe(true);
    expect(events.at(-1)).toEqual({
      type: "final",
      answer: "Final streamed answer",
      intent: "inventory",
      recipes: [],
      visualEvidence: [],
      dietaryRestrictions: [expect.objectContaining({ subject: "peanuts" })],
      dietaryPreferences: [expect.objectContaining({ subject: "vegetarian" })],
      workspaceActions: [],
      agentEvents: [],
    });
  });

  it("streams workspace actions after the visible response node", async () => {
    setLangSmithEnv();

    const promptBundle = {
      ...testPromptBundle(),
      workspaceActionPlan: {
        name: PromptName.WorkspaceActionPlan,
        ref: "fridgefriend-workspace-action-plan:latest",
        prompt: ChatPromptTemplate.fromMessages([["human", "{{workspace_action_context_json}}"]], { templateFormat: "mustache" }),
      },
    };
    const events: QueryStreamEvent[] = [];

    for await (const event of streamQueryForFridgeImage(
      {
        fridgeId: "fridge-1",
        imageId: "image-1",
        query: "Show me the chicken.",
        threadId: `test-${randomUUID()}`,
      },
      fakeDeps({
        overrides: {
          promptBundle,
          workspaceActionModel: createStructuredModel({
            actions: [{ type: "focus_items", itemIds: ["item-1"], emphasis: "highlight", reason: "Requested item" }],
          }),
        },
      }),
    )) {
      events.push(event);
    }

    const respondStatusIndex = events.findIndex((event) =>
      event.type === "status" &&
      event.node === "respond" &&
      event.message === "Drafting the answer."
    );
    const workspaceStatusIndex = events.findIndex((event) =>
      event.type === "status" &&
      event.node === "plan_workspace_actions"
    );
    const workspaceActionIndex = events.findIndex((event) => event.type === "workspace_action");

    expect(respondStatusIndex).toBeGreaterThanOrEqual(0);
    expect(workspaceStatusIndex).toBeGreaterThan(respondStatusIndex);
    expect(workspaceActionIndex).toBeGreaterThan(respondStatusIndex);
    expect(events[workspaceActionIndex]).toEqual({
      type: "workspace_action",
      action: {
        type: "focus_items",
        itemIds: ["item-1"],
        emphasis: "highlight",
        reason: "Requested item",
      },
    });
  });

  it("does not emit recipe tournament events when there are no recipe candidates", async () => {
    setLangSmithEnv();

    const events: QueryStreamEvent[] = [];

    for await (const event of streamQueryForFridgeImage(
      {
        fridgeId: "fridge-1",
        imageId: "image-1",
        query: "What recipes can I make from the items in my fridge?",
        threadId: `test-${randomUUID()}`,
      },
      fakeDeps({
        intent: "recipe",
        memoryCandidates: [
          {
            kind: "dietary_restriction",
            scope: "user",
            action: "upsert",
            restrictionType: "other",
            subject: "vegetarian",
            severity: "strict_avoid",
            notes: null,
            explicit: true,
          },
        ],
        overrides: {
          searchRecipeCandidates: async () => [],
          getRecipeCandidatesByTags: () => [],
          getRecipeCandidatesByIngredients: () => [],
        },
      }),
    )) {
      events.push(event);
    }

    expect(events.some((event) => event.type.startsWith("recipe_tournament_"))).toBe(false);
    expect(events.at(-1)).toMatchObject({
      type: "final",
      recipes: [],
    });
  }, 10000);

  it("answers an empty recipe retrieval through the grounded response model", async () => {
    setLangSmithEnv();

    let responseModelCalls = 0;
    const result = await runQueryForFridgeImage(
      {
        fridgeId: "fridge-1",
        imageId: "image-1",
        query: "What recipes can I make from the items in my fridge?",
        threadId: `test-${randomUUID()}`,
      },
      fakeDeps({
        intent: "recipe",
        responseModel: {
          invoke: async () => {
            responseModelCalls += 1;
            return new AIMessage("I could not verify a recipe from the recorded ingredients.");
          },
        } as unknown as FridgeFriendChatModel,
        overrides: {
          searchRecipeCandidates: async () => [],
          getRecipeCandidatesByTags: () => [],
          getRecipeCandidatesByIngredients: () => [],
        },
      }),
    );

    expect(responseModelCalls).toBe(1);
    expect(result.answer).toBe("I could not verify a recipe from the recorded ingredients.");
  }, 10000);

  it("streams recipe tournament started, update, finished, and final recipe cards", async () => {
    setLangSmithEnv();

    const recipes = [
      createRecipe({ id: "recipe-1", name: "Egg Dinner", ingredients: ["egg", "cheese"] }),
      createRecipe({ id: "recipe-2", name: "Cheese Tortilla", ingredients: ["cheese", "tortilla"] }),
      createRecipe({ id: "recipe-3", name: "Butter Eggs", ingredients: ["egg", "butter"] }),
    ];
    const events: QueryStreamEvent[] = [];

    for await (const event of streamQueryForFridgeImage(
      {
        fridgeId: "fridge-1",
        imageId: "image-1",
        query: "Give me dinner ideas.",
        threadId: `test-${randomUUID()}`,
      },
      fakeDeps({
        intent: "recipe",
        responseModel: {
          invoke: async () => new AIMessage("Recipe suggestions"),
        } as unknown as FridgeFriendChatModel,
        overrides: {
          loadInventoryForImage: () =>
            createInventory({
              item: {
                name: "eggs",
                label: "Eggs",
                cat: "eggs",
                subcat: "egg",
                pack: "carton",
              },
            }),
          searchRecipeCandidates: async () => [
            { recipeId: "recipe-1", semanticScore: 0.9 },
            { recipeId: "recipe-2", semanticScore: 0.8 },
            { recipeId: "recipe-3", semanticScore: 0.7 },
          ],
          listFoodComTags: () => [],
          getRecipeCandidatesByTags: () => [],
          getRecipeCandidatesByIngredients: () => [],
          getRecipesByIds: () => recipes,
        },
      }),
    )) {
      events.push(event);
    }

    const started = events.find((event) => event.type === "recipe_tournament_started");
    const updates = events.filter((event) => event.type === "recipe_tournament_update");
    const finished = events.find((event) => event.type === "recipe_tournament_finished");
    const final = events.at(-1);

    expect(started).toEqual({
      type: "recipe_tournament_started",
      candidateCount: 2,
      displaySlotCount: 2,
    });
    expect(updates).toHaveLength(2);
    expect(updates.map((event) => event.evaluatedCount)).toEqual([1, 2]);
    expect(updates[0].recipes).toHaveLength(1);
    expect(updates[1].recipes).toHaveLength(2);
    expect(finished?.type).toBe("recipe_tournament_finished");
    expect(finished && "recipes" in finished ? finished.recipes : []).toHaveLength(2);
    expect(finished && "recipes" in finished ? finished.recipes : []).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: expect.any(String) }),
        expect.objectContaining({ id: expect.any(String) }),
      ]),
    );
    expect(final).toMatchObject({
      type: "final",
      answer: "Recipe suggestions",
      intent: "recipe",
      retrievalAudit: {
        tournamentCandidates: 2,
        terminalReason: "tournament_complete",
      },
    });
    expect(final && "recipes" in final ? final.recipes : []).toHaveLength(2);
    expect(final && "recipes" in final ? final.recipes : []).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: expect.any(String) }),
        expect.objectContaining({ id: expect.any(String) }),
      ]),
    );
  }, 10000);

  it("uses the response model for inventory count questions", async () => {
    setLangSmithEnv();

    let intentModelCalls = 0;
    let responseModelCalls = 0;
    let householdToolCalls = 0;
    const result = await runQueryForFridgeImage(
      {
        fridgeId: "fridge-1",
        imageId: "image-1",
        query: "How many eggs do I have?",
        threadId: `test-${randomUUID()}`,
      },
      fakeDeps({
        responseModel: {
          invoke: async (messages: Array<{ content: unknown }>) => {
            responseModelCalls += 1;
            const payload = JSON.parse(messages[1].content as string);

            expect(payload.context.inventoryQuery).toMatchObject({
              source: "current_inventory_tool",
              scannedInventoryId: "inventory-1",
              visibleItemCount: 1,
            });
            expect(payload.context.inventoryQuery.scannedInventory).toBeUndefined();
            expect(payload.context.inventory.items).toEqual([
              expect.objectContaining({
                displayName: "Eggs",
                quantity: expect.objectContaining({
                  amount: 12,
                  unit: "count",
                }),
              }),
            ]);

            return new AIMessage("You have 12 eggs.");
          },
        } as unknown as FridgeFriendChatModel,
        overrides: {
          intentModel: {
            withStructuredOutput: () => ({
              invoke: async () => {
                intentModelCalls += 1;
                return { intent: "inventory" };
              },
            }),
          } as unknown as FridgeFriendChatModel,
          loadInventoryForImage: () =>
            createInventory({
              item: {
                name: "eggs",
                label: "Eggs",
                cat: "eggs",
                pack: "carton",
                qty: {
                  amount: 12,
                  unit: "count",
                  precision: "estimated",
                  fillLevel: null,
                },
              },
            }),
          householdInventoryTool: {
            invoke: async () => {
              householdToolCalls += 1;
              return {
                operation: "list",
                status: "ok",
                message: "Listed 0 household inventory items",
                item: null,
                items: [],
              };
            },
          },
        },
      }),
    );

    expect(result.intent).toBe("inventory");
    expect(result.answer).toBe("You have 12 eggs.");
    expect(intentModelCalls).toBe(1);
    expect(responseModelCalls).toBe(1);
    expect(householdToolCalls).toBe(1);
  });

  it("answers the newest query when a chat thread already has an answer", async () => {
    setLangSmithEnv();

    const threadId = `test-${randomUUID()}`;
    const responseModel = {
      invoke: async (messages: Array<{ content: unknown }>) => {
        const payload = JSON.parse(String(messages[1].content));
        return new AIMessage(`Answering: ${payload.query}`);
      },
    } as unknown as FridgeFriendChatModel;
    const deps = fakeDeps({ responseModel });

    const first = await runQueryForFridgeImage(
      {
        fridgeId: "fridge-1",
        imageId: "image-1",
        query: "How many eggs do I have?",
        threadId,
      },
      deps,
    );
    const second = await runQueryForFridgeImage(
      {
        fridgeId: "fridge-1",
        imageId: "image-1",
        query: "How much lemonade do I have?",
        threadId,
      },
      deps,
    );

    expect(first.answer).toBe("Answering: How many eggs do I have?");
    expect(second.answer).toBe("Answering: How much lemonade do I have?");
  });

  it("uses focused visual evidence instead of treating egg cartons as egg counts", async () => {
    setLangSmithEnv();

    let capturedMessages: Array<{ content: unknown }> = [];
    const result = await runQueryForFridgeImage(
      {
        fridgeId: "fridge-1",
        imageId: "image-1",
        query: "How many eggs do I have?",
        threadId: `test-${randomUUID()}`,
      },
      fakeDeps({
        responseModel: {
          invoke: async (messages: Array<{ content: unknown }>) => {
            capturedMessages = messages;
            return new AIMessage("I can't tell how many eggs are in the two cartons from this image.");
          },
        } as unknown as FridgeFriendChatModel,
        overrides: {
          loadInventoryForImage: () =>
            createInventory({
              observations: [
                {
                  imageId: "image-1",
                  depthBackRatio: 0.5,
                  boundingBox: {
                    x: 0,
                    y: 0,
                    width: 0.5,
                    height: 0.5,
                  },
                },
              ],
              item: {
                name: "eggs",
                label: "Egg carton",
                cat: "eggs",
                pack: "carton",
                qty: {
                  amount: 2,
                  unit: "package",
                  precision: "estimated",
                  fillLevel: null,
                },
              },
            }),
          loadImageDataUrlForQuery: () => createJpegDataUrl(),
        },
      }),
    );

    const instructions = capturedMessages[0].content as string;
    const payload = JSON.parse(String(capturedMessages[1].content));

    expect(instructions).toContain(
      "distinguish the number of packages or cartons from the number of items inside them",
    );
    expect(payload.context.inventoryQuery).toMatchObject({
      scannedInventoryId: "inventory-1",
      visibleItemCount: 1,
    });
    expect(payload.context.inventoryQuery.scannedInventory).toBeUndefined();
    expect(payload.context.inventory.items).toEqual([
      expect.objectContaining({
        displayName: "Egg carton",
        quantity: expect.objectContaining({
          amount: 2,
          unit: "package",
        }),
      }),
    ]);
    expect(result.answer).toBe(
      "I can't tell how many eggs are in the two cartons from this image.",
    );
    expect(result.visualEvidence).toEqual([]);
  });

  it("answers focused visual questions without a separate enrichment model call", async () => {
    setLangSmithEnv();

    let structuredCalls = 0;
    let capturedContent: unknown;
    const responseModel = {
      withStructuredOutput: () => ({
        invoke: async () => {
          structuredCalls += 1;
          throw new Error("Focused visual enrichment should not run");
        },
      }),
      invoke: async (messages: Array<{ content: unknown }>) => {
        capturedContent = messages[1].content;
        return new AIMessage("The package looks visible.");
      },
    } as unknown as FridgeFriendChatModel;

    const result = await runQueryForFridgeImage(
      {
        fridgeId: "fridge-1",
        imageId: "image-1",
        query: "Is the chicken package open?",
        threadId: `test-${randomUUID()}`,
      },
      fakeDeps({
        responseModel,
        overrides: {
          loadInventoryForImage: () =>
            createInventory({
              observations: [
                {
                  imageId: "image-1",
                  depthBackRatio: 0.5,
                  boundingBox: {
                    x: 0,
                    y: 0,
                    width: 0.5,
                    height: 0.5,
                  },
                },
              ],
            }),
          loadImageDataUrlForQuery: () => createJpegDataUrl(),
        },
      }),
    );

    expect(structuredCalls).toBe(0);
    expect(result.answer).toBe("The package looks visible.");
    expect(typeof capturedContent).toBe("string");
  });

  it("moves user seeded items to the front of inventory context and focused crops", async () => {
    setLangSmithEnv();

    let capturedMessages: Array<{ content: unknown }> = [];
    const inventory = createInventory({
      item: {
        id: "item-1",
        name: "milk",
        label: "Milk",
        cat: "dairy",
        pack: "carton",
      },
      observations: [
        {
          imageId: "image-1",
          depthBackRatio: 0.5,
          boundingBox: {
            x: 0,
            y: 0,
            width: 0.5,
            height: 0.5,
          },
        },
      ],
    });
    const seededItem = {
      ...inventory.items[0],
      id: "item-2",
      name: "yogurt",
      label: "Yogurt",
      cat: "dairy" as const,
      pack: "container" as const,
      loc: {
        ...inventory.items[0].loc,
        observations: [
          {
            imageId: "image-1",
            depthBackRatio: 0.5,
            boundingBox: {
              x: 0.5,
              y: 0.5,
              width: 0.5,
              height: 0.5,
            },
          },
        ],
      },
    };
    inventory.items.push(seededItem);

    await runQueryForFridgeImage(
      {
        fridgeId: "fridge-1",
        imageId: "image-1",
        query: "How much milk is left?",
        threadId: `test-${randomUUID()}`,
        conversationContext: {
          selectedItemIds: [],
          selectedZoneIds: [],
          selectedRecipeId: null,
          seededItems: [
            {
              itemId: "item-2",
              imageId: "image-1",
              cropId: "image-1:item-2:0",
              userSeeded: true,
            },
          ],
          seededBoundingBoxes: [],
        },
      },
      fakeDeps({
        responseModel: {
          invoke: async (messages: Array<{ content: unknown }>) => {
            capturedMessages = messages;
            return new AIMessage("The seeded yogurt is first, and milk is still considered.");
          },
        } as unknown as FridgeFriendChatModel,
        overrides: {
          loadInventoryForImage: () => inventory,
          loadImageDataUrlForQuery: () => createJpegDataUrl(),
        },
      }),
    );

    const content = capturedMessages[1].content as Array<{
      type: string;
      text?: string;
      image_url?: { url: string };
    }>;
    const payload = JSON.parse(content[0].text ?? "");

    expect(payload.context.inventoryQuery.scannedInventory).toBeUndefined();
    expect(payload.context.inventory.items.map((item: { id: string }) => item.id)).toEqual([
      "item-2",
      "item-1",
    ]);
    expect(payload.context.inventory.items[0]).toMatchObject({
      id: "item-2",
      userSeeded: true,
    });
    expect(payload.context.inventoryQuery.focusedItemIds).toEqual([
      "item-2",
      "item-1",
    ]);
    expect(payload.context.focusedVisualCrops.map((crop: { itemId: string }) => crop.itemId)).toEqual([
      "item-2",
      "item-1",
    ]);
    expect(content.slice(1).map((part) => part.image_url?.url)).toEqual([
      expect.stringMatching(/^data:image\/jpeg;base64,/),
      expect.stringMatching(/^data:image\/jpeg;base64,/),
    ]);
  });

  it("persists a direct assertion for a seeded crop before answering", async () => {
    setLangSmithEnv();

    const assertions: Array<{ cropId: string; label: string }> = [];
    const applied: Array<{ itemId: string; cropId: string; label: string }> = [];

    await runQueryForFridgeImage(
      {
        fridgeId: "fridge-1",
        imageId: "image-1",
        query: "This selected item is a different vegetable.",
        threadId: `test-${randomUUID()}`,
        conversationContext: {
          selectedItemIds: [],
          selectedZoneIds: [],
          selectedRecipeId: null,
          seededItems: [{
            itemId: "item-1",
            imageId: "image-1",
            cropId: "image-1:item-1:0",
            userSeeded: true,
          }],
          seededBoundingBoxes: [],
        },
      },
      fakeDeps({
        overrides: {
          seededInventoryAssertionModel: createStructuredModel({
            assertions: [{ cropId: "image-1:item-1:0", label: "Brussels Sprouts" }],
          }),
          applySeededInventoryAssertions: ({ assertions: receivedAssertions }) => {
            assertions.push(...receivedAssertions);
            const result = receivedAssertions.map((assertion) => ({
              itemId: "item-1",
              cropId: assertion.cropId,
              label: assertion.label,
            }));
            applied.push(...result);
            return result;
          },
          loadInventoryForImage: () => createInventory({
            observations: [{
              imageId: "image-1",
              depthBackRatio: 0.5,
              boundingBox: { x: 0, y: 0, width: 1, height: 1 },
            }],
          }),
          loadImageDataUrlForQuery: () => createJpegDataUrl(),
        },
      }),
    );

    expect(assertions).toEqual([
      { cropId: "image-1:item-1:0", label: "Brussels Sprouts" },
    ]);
    expect(applied).toEqual([
      { itemId: "item-1", cropId: "image-1:item-1:0", label: "Brussels Sprouts" },
    ]);
  });

  it("inspects and persists selected item detail enrichment", async () => {
    await withTestDatabase(async () => {
      const image = createFridgeImage({
        dataUrl: createJpegDataUrl(),
        originalName: "fridge.jpg",
        storageLocation: "fridge",
        baseImageId: null,
      });
      const inventory = createInventory({
        item: {
          id: "item-1",
          name: "meat",
          label: "Meat",
          cat: "meat",
          conf: 0.55,
          qty: {
            amount: null,
            unit: "unknown",
            precision: "unknown",
            fillLevel: null,
          },
        },
        observations: [{
          imageId: image.id,
          depthBackRatio: 0.5,
          boundingBox: { x: 0, y: 0, width: 1, height: 1 },
        }],
      });
      saveFridgeInventory({ imageId: image.id, inventory });

      let capturedDisplayName: string | null = null;
      const result = await runQueryForFridgeImage(
        {
          fridgeId: "fridge-1",
          imageId: image.id,
          query: "Get more detail about this.",
          threadId: `test-${randomUUID()}`,
          conversationContext: {
            selectedItemIds: [],
            selectedZoneIds: [],
            selectedRecipeId: null,
            seededItems: [{
              itemId: "item-1",
              imageId: image.id,
              cropId: `${image.id}:item-1:0`,
              userSeeded: true,
            }],
            seededBoundingBoxes: [],
          },
        },
        fakeDeps({
          intent: "clarification",
          overrides: {
            loadInventoryForImage: getFridgeInventoryForImage,
            enrichmentModel: createStructuredModel({
              label: "Pork shoulder",
              variant: "boneless",
              amount: 1,
              unit: "package",
              fillLevel: 0.8,
              expirationDate: "2026-07-20",
              opened: false,
              confidence: 0.86,
            }),
            responseModel: {
              invoke: async (messages: Array<{ content: unknown }>) => {
                const content = messages[1].content;
                const text = Array.isArray(content) &&
                  typeof content[0] === "object" &&
                  content[0] !== null &&
                  "text" in content[0]
                  ? String(content[0].text)
                  : String(content);
                const payload = JSON.parse(text) as { context?: { inventory?: { items?: Array<{ displayName: string }> } } };
                capturedDisplayName = payload.context?.inventory?.items?.[0]?.displayName ?? null;
                return new AIMessage("I found a sealed package of boneless pork shoulder, about 80% full, expiring 2026-07-20.");
              },
            } as unknown as FridgeFriendChatModel,
            loadImageDataUrlForQuery: () => createJpegDataUrl(),
          },
        }),
      );

      const stored = getFridgeInventoryForImage(image.id);

      expect(result.intent).toBe("inventory");
      expect(result.answer).toContain("pork shoulder");
      expect(stored?.items[0]).toMatchObject({
        label: "Pork shoulder",
        qty: {
          amount: 1,
          unit: "package",
          fillLevel: 0.8,
          precision: "estimated",
        },
        attrs: {
          variant: "boneless",
          expirationDate: "2026-07-20",
          expirationDateSource: "observed",
          opened: false,
        },
      });
      expect(stored?.items[0].enrichments?.length).toBeGreaterThan(0);
      expect(capturedDisplayName).toBe("Pork shoulder");
    });
  });

  it("asks for selected item details that visual enrichment cannot confirm", async () => {
    await withTestDatabase(async () => {
      const image = createFridgeImage({
        dataUrl: createJpegDataUrl(),
        originalName: "fridge.jpg",
        storageLocation: "fridge",
        baseImageId: null,
      });
      const inventory = createInventory({
        item: {
          id: "item-1",
          name: "meat",
          label: "Meat",
          cat: "meat",
          conf: 0.55,
          qty: {
            amount: null,
            unit: "unknown",
            precision: "unknown",
            fillLevel: null,
          },
        },
        observations: [{
          imageId: image.id,
          depthBackRatio: 0.5,
          boundingBox: { x: 0, y: 0, width: 1, height: 1 },
        }],
      });
      saveFridgeInventory({ imageId: image.id, inventory });

      const events: QueryStreamEvent[] = [];
      for await (const event of streamQueryForFridgeImage(
        {
          fridgeId: "fridge-1",
          imageId: image.id,
          query: "Get more detail about this.",
          threadId: `test-${randomUUID()}`,
          conversationContext: {
            selectedItemIds: [],
            selectedZoneIds: [],
            selectedRecipeId: null,
            seededItems: [{
              itemId: "item-1",
              imageId: image.id,
              cropId: `${image.id}:item-1:0`,
              userSeeded: true,
            }],
            seededBoundingBoxes: [],
          },
        },
        fakeDeps({
          overrides: {
            loadInventoryForImage: getFridgeInventoryForImage,
            enrichmentModel: createStructuredModel({
              label: "Pork shoulder",
              variant: null,
              amount: 1,
              unit: "package",
              fillLevel: null,
              expirationDate: null,
              opened: null,
              confidence: 0.72,
            }),
            loadImageDataUrlForQuery: () => createJpegDataUrl(),
          },
        }),
      )) {
        events.push(event);
      }

      expect(events).toContainEqual({
        type: "clarification",
        questions: expect.arrayContaining([
          expect.objectContaining({ itemId: "item-1", field: "fill_level" }),
          expect.objectContaining({ itemId: "item-1", field: "opened" }),
          expect.objectContaining({ itemId: "item-1", field: "expiration_date" }),
        ]),
      });
      expect(events.some((event) => event.type === "final")).toBe(false);
    });
  });

  it("returns a structured interrupted result from the non-streaming invoke path", async () => {
    await withTestDatabase(async () => {
      const image = createFridgeImage({
        dataUrl: createJpegDataUrl(),
        originalName: "fridge.jpg",
        storageLocation: "fridge",
        baseImageId: null,
      });
      const inventory = createInventory({
        item: {
          id: "item-1",
          name: "meat",
          label: "Meat",
          cat: "meat",
          conf: 0.55,
          qty: {
            amount: null,
            unit: "unknown",
            precision: "unknown",
            fillLevel: null,
          },
        },
        observations: [{
          imageId: image.id,
          depthBackRatio: 0.5,
          boundingBox: { x: 0, y: 0, width: 1, height: 1 },
        }],
      });
      saveFridgeInventory({ imageId: image.id, inventory });

      const result = await runQueryForFridgeImage(
        {
          fridgeId: "fridge-1",
          imageId: image.id,
          query: "Get more detail about this.",
          threadId: `test-${randomUUID()}`,
          conversationContext: {
            selectedItemIds: [],
            selectedZoneIds: [],
            selectedRecipeId: null,
            seededItems: [{
              itemId: "item-1",
              imageId: image.id,
              cropId: `${image.id}:item-1:0`,
              userSeeded: true,
            }],
            seededBoundingBoxes: [],
          },
        },
        fakeDeps({
          overrides: {
            loadInventoryForImage: getFridgeInventoryForImage,
            enrichmentModel: createStructuredModel({
              label: "Pork shoulder",
              variant: null,
              amount: 1,
              unit: "package",
              fillLevel: null,
              expirationDate: null,
              opened: null,
              confidence: 0.72,
            }),
            loadImageDataUrlForQuery: () => createJpegDataUrl(),
          },
        }),
      );

      expect(result.status).toBe("interrupted");
      expect(result.answer).toBeNull();
      expect(result.interrupts).toEqual([
        expect.objectContaining({
          type: "inventory_clarification",
          questions: expect.arrayContaining([
            expect.objectContaining({ itemId: "item-1", field: "fill_level" }),
          ]),
        }),
      ]);
    });
  });

  it("uses same-turn explicit pantry memory during recipe retrieval", async () => {
    setLangSmithEnv();

    let memoryContext = emptyMemoryContext();
    const pantryCandidate = {
      kind: "inventory_item",
      scope: "fridge",
      action: "upsert",
      name: "Jasmine rice",
      storageLocation: "pantry",
      quantity: null,
      notes: null,
      explicit: true,
    } satisfies MemoryCandidate;
    const seenRecipeIds: string[][] = [];
    let responseModelCalls = 0;
    const responseModel = {
      invoke: async () => {
        responseModelCalls += 1;
        return new AIMessage("Recipe answer");
      },
    } as unknown as FridgeFriendChatModel;
    const pantryRecipe: Recipe = {
      id: "recipe-1",
      name: "Chicken Rice",
      description: "Chicken and rice dinner.",
      ingredients: [
        { rawName: "chicken", canonicalName: "chicken" },
        { rawName: "jasmine rice", canonicalName: "jasmine rice" },
        { rawName: "soy sauce", canonicalName: "soy sauce" },
      ],
      tags: ["dinner"],
      steps: ["Cook chicken."],
      minutes: 20,
      stepCount: 1,
      ingredientCount: 3,
      nutrition: {
        calories: 400,
        totalFatDailyValue: null,
        sugarDailyValue: null,
        sodiumDailyValue: null,
        proteinDailyValue: 20,
        saturatedFatDailyValue: null,
        carbohydratesDailyValue: null,
      },
      rating: { average: 4, count: 5 },
    };

    const result = await runQueryForFridgeImage(
      {
        userId: "default-user",
        fridgeId: "fridge-1",
        imageId: "image-1",
        query: "I have Jasmine rice in the pantry. What can I cook?",
        threadId: `test-${randomUUID()}`,
      },
      fakeDeps({
        intent: "recipe",
        memoryCandidates: [pantryCandidate],
        responseModel,
        overrides: {
          loadMemoryContext: () => memoryContext,
          persistMemoryValidations: async () => {
            memoryContext = {
              ...memoryContext,
              externalInventory: [
                {
                  id: "external-1",
                  fridgeId: "fridge-1",
                  name: "Jasmine rice",
                  canonicalName: "jasmine rice",
                  storageLocation: "pantry",
                  quantity: null,
                  status: "available",
                  confidence: 1,
                  source: "user_explicit",
                  notes: null,
                  lastConfirmedAt: "2026-07-16T00:00:00.000Z",
                  createdAt: "2026-07-16T00:00:00.000Z",
                  updatedAt: "2026-07-16T00:00:00.000Z",
                },
              ],
            };

            return [
              {
                result: {
                  kind: "inventory_item",
                  action: "upsert",
                  status: "persisted",
                  targetId: "external-1",
                  message: "Saved inventory item",
                },
                semanticMemory: null,
              },
            ];
          },
          searchRecipeCandidates: async () => [{
            recipeId: "recipe-1",
            semanticScore: 0.9,
          }],
          listFoodComTags: () => [],
          getRecipeCandidatesByTags: () => [],
          getRecipeCandidatesByIngredients: () => [],
          getRecipesByIds: (recipeIds) => {
            seenRecipeIds.push(recipeIds);
            return [pantryRecipe];
          },
        },
      }),
    );

    expect(result.intent).toBe("recipe");
    expect(result.answer).toBe("Recipe answer");
    expect(seenRecipeIds).toHaveLength(1);
    expect(seenRecipeIds[0]).toContain("recipe-1");
    expect(responseModelCalls).toBe(1);
  }, 10000);

  it("loads restrictions and goals into response context", async () => {
    setLangSmithEnv();

    let capturedPayload: { context?: unknown } | undefined;
    const responseModel = {
      invoke: async (messages: Array<{ content: unknown }>) => {
        capturedPayload = JSON.parse(String(messages[1].content));
        return new AIMessage("Context captured");
      },
    } as unknown as FridgeFriendChatModel;

    await runQueryForFridgeImage(
      {
        userId: "default-user",
        fridgeId: "fridge-1",
        imageId: "image-1",
        query: "What should I avoid?",
        threadId: `test-${randomUUID()}`,
      },
      fakeDeps({
        responseModel,
        memoryContext: {
          ...emptyMemoryContext(),
          dietaryRestrictions: [
            {
              id: "restriction-1",
              userId: "default-user",
              restrictionType: "allergy",
              subject: "peanuts",
              severity: "strict_avoid",
              notes: null,
              source: "user_explicit",
              createdAt: "2026-07-16T00:00:00.000Z",
              updatedAt: "2026-07-16T00:00:00.000Z",
            },
          ],
          activeGoals: [
            {
              id: "goal-1",
              userId: "default-user",
              goalType: "high_protein",
              description: "high protein dinners",
              targetValue: null,
              targetUnit: null,
              priority: 1,
              active: true,
              source: "user_explicit",
              createdAt: "2026-07-16T00:00:00.000Z",
              updatedAt: "2026-07-16T00:00:00.000Z",
            },
          ],
        },
      }),
    );

    expect(capturedPayload).toMatchObject({
      context: {
        dietaryRestrictions: [
          {
            subject: "peanuts",
            severity: "strict_avoid",
          },
        ],
        activeGoals: [
          {
            description: "high protein dinners",
          },
        ],
      },
    });
  });

  it("answers semantic inventory health assessments without focused visual enrichment", async () => {
    setLangSmithEnv();

    let structuredCalls = 0;
    let capturedContent: unknown;
    const responseModel = {
      withStructuredOutput: () => ({
        invoke: async () => {
          structuredCalls += 1;
          throw new Error("Focused visual enrichment should not run");
        },
      }),
      invoke: async (messages: Array<{ content: unknown }>) => {
        capturedContent = messages[1].content;
        return new AIMessage("The inventory looks mixed: some whole foods, some packaged items.");
      },
    } as unknown as FridgeFriendChatModel;

    const result = await runQueryForFridgeImage(
      {
        fridgeId: "fridge-1",
        imageId: "image-1",
        query: "How healthy would you say the items in my fridge are?",
        threadId: `test-${randomUUID()}`,
      },
      fakeDeps({
        intent: "food_knowledge",
        responseModel,
        overrides: {
          loadInventoryForImage: () =>
            createInventory({
              observations: [
                {
                  imageId: "image-1",
                  depthBackRatio: 0.5,
                  boundingBox: {
                    x: 0,
                    y: 0,
                    width: 0.5,
                    height: 0.5,
                  },
                },
              ],
            }),
          loadImageDataUrlForQuery: () => createJpegDataUrl(),
        },
      }),
    );

    expect(structuredCalls).toBe(0);
    expect(result.answer).toBe("The inventory looks mixed: some whole foods, some packaged items.");
    expect(result.visualEvidence).toEqual([]);
    expect(typeof capturedContent).toBe("string");
    const payload = JSON.parse(String(capturedContent));
    expect(payload.context.queryMode).toBe("food_knowledge");
    expect(payload.context.focusedVisualCrops).toEqual([]);
    expect(payload.context).toHaveProperty("inventory");
  });

  it("does not send automatic focused crops to the response model", async () => {
    setLangSmithEnv();

    let capturedContent: unknown;
    const responseModel = {
      invoke: async (messages: Array<{ content: unknown }>) => {
        capturedContent = messages[1].content;
        return new AIMessage("Visual answer");
      },
    } as unknown as FridgeFriendChatModel;

    const result = await runQueryForFridgeImage(
      {
        fridgeId: "fridge-1",
        imageId: "image-1",
        query: "Is the chicken package open?",
        threadId: `test-${randomUUID()}`,
      },
      fakeDeps({
        responseModel,
        overrides: {
          loadInventoryForImage: () =>
            createInventory({
              observations: [
                {
                  imageId: "image-1",
                  depthBackRatio: 0.5,
                  boundingBox: {
                    x: 0,
                    y: 0,
                    width: 0.5,
                    height: 0.5,
                  },
                },
              ],
            }),
          loadImageDataUrlForQuery: () => createJpegDataUrl(),
        },
      }),
    );

    expect(result.answer).toBe("Visual answer");
    expect(typeof capturedContent).toBe("string");
    const payload = JSON.parse(String(capturedContent));
    expect(payload.context.focusedVisualCrops).toEqual([]);
  });

  it("does not fail the graph when validation rejects a candidate", async () => {
    setLangSmithEnv();

    const result = await runQueryForFridgeImage(
      {
        fridgeId: "fridge-1",
        imageId: "image-1",
        query: "Maybe Italian tonight",
        threadId: `test-${randomUUID()}`,
      },
      fakeDeps({
        memoryCandidates: [
          {
            kind: "preference",
            scope: "user",
            action: "upsert",
            subject: "Italian food",
            sentiment: "like",
            strength: 1,
            notes: null,
            explicit: false,
          },
        ],
      }),
    );

    expect(result.answer).toBe("Final streamed answer");
  });

  it("persists explicit preferences from general chat through memory extraction", async () => {
    setLangSmithEnv();

    const persistedValidations: MemoryValidationResult[] = [];
    let memoryExtractionCalls = 0;
    const result = await runQueryForFridgeImage(
      {
        fridgeId: "fridge-1",
        imageId: "image-1",
        query: "I like bright, acidic flavors.",
        threadId: `test-${randomUUID()}`,
      },
      fakeDeps({
        intent: "general_chat",
        memoryCandidates: [
          {
            kind: "preference",
            scope: "user",
            action: "upsert",
            subject: "bright, acidic flavors",
            sentiment: "like",
            strength: 4,
            notes: null,
            explicit: true,
          },
        ],
        overrides: {
          memoryExtractionModel: {
            withStructuredOutput: () => ({
              invoke: async () => {
                memoryExtractionCalls += 1;
                return {
                  candidates: [{
                    kind: "preference",
                    scope: "user",
                    action: "upsert",
                    subject: "bright, acidic flavors",
                    sentiment: "like",
                    strength: 4,
                    notes: null,
                    explicit: true,
                  }],
                };
              },
            }),
          } as unknown as FridgeFriendChatModel,
          persistMemoryValidations: async ({ validations }) => {
            persistedValidations.push(...validations);
            return validations.map((validation) => ({
              result: {
                kind: validation.candidate.kind,
                action: validation.candidate.action,
                status: validation.accepted ? "persisted" : "skipped",
                targetId: validation.accepted ? "preference-fixture" : null,
                message: validation.reason,
              },
              semanticMemory: null,
            }));
          },
        },
      }),
    );

    expect(result).toMatchObject({
      answer: "Final streamed answer",
      intent: "general_chat",
    });
    expect(memoryExtractionCalls).toBe(1);
    expect(persistedValidations).toEqual([
      expect.objectContaining({
        accepted: true,
        candidate: expect.objectContaining({
          kind: "preference",
          subject: "bright, acidic flavors",
          sentiment: "like",
        }),
      }),
    ]);
  });

  it("does not report skipped memory writes as saved", async () => {
    setLangSmithEnv();

    const events: QueryStreamEvent[] = [];
    let responsePayload: unknown = null;

    for await (const event of streamQueryForFridgeImage(
      {
        fridgeId: "fridge-1",
        imageId: "image-1",
        query: "I like bright, acidic flavors.",
        threadId: `test-${randomUUID()}`,
      },
      fakeDeps({
        intent: "general_chat",
        memoryCandidates: [
          {
            kind: "preference",
            scope: "user",
            action: "upsert",
            subject: "bright, acidic flavors",
            sentiment: "like",
            strength: 4,
            notes: null,
            explicit: true,
          },
        ],
        overrides: {
          responseModel: {
            invoke: async (messages: Array<{ content: unknown }>) => {
              responsePayload = JSON.parse(String(messages[1]?.content));
              return new AIMessage("I hear you like bright, acidic flavors.");
            },
          } as unknown as FridgeFriendChatModel,
          persistMemoryValidations: async ({ validations }) =>
            validations.map((validation) => ({
              result: {
                kind: validation.candidate.kind,
                action: validation.candidate.action,
                status: "skipped",
                targetId: null,
                message: "Synthetic write skip",
              },
              semanticMemory: null,
            })),
        },
      }),
    )) {
      events.push(event);
    }

    const statuses = events.filter((event): event is Extract<QueryStreamEvent, { type: "status" }> => event.type === "status");

    expect(statuses).toContainEqual({
      type: "status",
      node: "apply_memory_writes",
      message: "No durable memory was saved: Synthetic write skip",
    });
    expect(statuses.map((event) => event.message)).not.toContain("Saved durable memory updates.");
    expect(events.at(-1)).toMatchObject({
      type: "final",
      answer: "I hear you like bright, acidic flavors.",
    });
    expect(responsePayload).not.toBeNull();
    const capturedPayload = responsePayload as { context: Record<string, unknown> };
    expect(capturedPayload.context.memoryWriteResults).toMatchObject([
      {
        status: "skipped",
        message: "Synthetic write skip",
      },
    ]);
    expect(capturedPayload.context.memoryWriteVerification).toMatchObject({
      status: "not_applicable",
      persistedCount: 0,
      message: "No durable memory was saved: Synthetic write skip",
    });
  });

  it("surfaces verification errors when persisted writes are not visible after reload", async () => {
    setLangSmithEnv();

    const events: QueryStreamEvent[] = [];

    for await (const event of streamQueryForFridgeImage(
      {
        fridgeId: "fridge-1",
        imageId: "image-1",
        query: "I like bright, acidic flavors.",
        threadId: `test-${randomUUID()}`,
      },
      fakeDeps({
        intent: "general_chat",
        memoryCandidates: [
          {
            kind: "preference",
            scope: "user",
            action: "upsert",
            subject: "bright, acidic flavors",
            sentiment: "like",
            strength: 4,
            notes: null,
            explicit: true,
          },
        ],
        overrides: {
          persistMemoryValidations: async ({ validations }) =>
            validations.map((validation) => ({
              result: {
                kind: validation.candidate.kind,
                action: validation.candidate.action,
                status: "persisted",
                targetId: "missing-preference",
                message: "Synthetic persisted write",
              },
              semanticMemory: null,
            })),
        },
      }),
    )) {
      events.push(event);
    }

    const statuses = events.filter((event): event is Extract<QueryStreamEvent, { type: "status" }> => event.type === "status");
    const final = events.at(-1);

    expect(statuses).toContainEqual({
      type: "status",
      node: "apply_memory_writes",
      message: "Persisted 1 durable memory update; awaiting reload verification.",
    });
    expect(statuses).toContainEqual({
      type: "status",
      node: "reload_memory_context",
      message: "Durable memory verification failed: Persisted preference upsert target missing-preference was not visible after reload.",
    });
    expect(final).toMatchObject({
      type: "final",
      memoryWriteVerificationError: "Persisted preference upsert target missing-preference was not visible after reload.",
    });
  });

  it("saves simple explicit preferences to the user profile store", async () => {
    await withTestDatabase(async () => {
      const result = await runQueryForFridgeImage(
        {
          fridgeId: "default-fridge",
          imageId: "image-1",
          query: "I like bright, acidic flavors.",
          threadId: `test-${randomUUID()}`,
        },
        fakeDeps({
          intent: "general_chat",
          memoryCandidates: [
            {
              kind: "preference",
              scope: "user",
              action: "upsert",
              subject: "bright, acidic flavors",
              sentiment: "like",
              strength: 4,
              notes: null,
              explicit: true,
            },
          ],
          overrides: {
            persistMemoryValidations: undefined,
            loadMemoryContext: undefined,
          },
        }),
      );
      const memoryContext = listStructuredMemoryContext({
        userId: "default-user",
        fridgeId: "default-fridge",
      });

      expect(result.intent).toBe("general_chat");
      expect(memoryContext.dietaryPreferences).toMatchObject([
        {
          subject: "bright, acidic flavors",
          sentiment: "like",
          strength: 4,
        },
      ]);
    });
  });

  it("saves 'I like spicy food' to the user profile store", async () => {
    await withTestDatabase(async () => {
      let memoryExtractionCalls = 0;
      const result = await runQueryForFridgeImage(
        {
          fridgeId: "default-fridge",
          imageId: "image-1",
          query: "I like spicy food",
          threadId: `test-${randomUUID()}`,
        },
        fakeDeps({
          intent: "general_chat",
          overrides: {
            memoryExtractionModel: {
              withStructuredOutput: () => ({
                invoke: async () => {
                  memoryExtractionCalls += 1;
                  return {
                    candidates: [{
                      kind: "preference",
                      scope: "user",
                      action: "upsert",
                      subject: "spicy food",
                      sentiment: "like",
                      strength: 4,
                      notes: null,
                      explicit: true,
                    }],
                  };
                },
              }),
            } as unknown as FridgeFriendChatModel,
            persistMemoryValidations: undefined,
            loadMemoryContext: undefined,
          },
        }),
      );
      const memoryContext = listStructuredMemoryContext({
        userId: "default-user",
        fridgeId: "default-fridge",
      });

      expect(result.intent).toBe("general_chat");
      expect(memoryExtractionCalls).toBe(1);
      expect(memoryContext.dietaryPreferences).toMatchObject([
        {
          subject: "spicy food",
          sentiment: "like",
          strength: 4,
        },
      ]);
    });
  });

  it("persists explicit dietary identities before continuing recipe handling", async () => {
    setLangSmithEnv();

    const persistedValidations: MemoryValidationResult[] = [];
    const result = await runQueryForFridgeImage(
      {
        fridgeId: "fridge-1",
        imageId: "image-1",
        query: "I am vegetarian.",
        threadId: `test-${randomUUID()}`,
      },
      fakeDeps({
        intent: "recipe",
        memoryCandidates: [
          {
            kind: "dietary_restriction",
            scope: "user",
            action: "upsert",
            restrictionType: "other",
            subject: "vegetarian",
            severity: "strict_avoid",
            notes: null,
            explicit: true,
          },
        ],
        overrides: {
          persistMemoryValidations: async ({ validations }) => {
            persistedValidations.push(...validations);
            return validations.map((validation) => ({
              result: {
                kind: validation.candidate.kind,
                action: validation.candidate.action,
                status: validation.accepted ? "persisted" : "skipped",
                targetId: validation.accepted ? "dietary-restriction-1" : null,
                message: validation.reason,
              },
              semanticMemory: null,
            }));
          },
          listFoodComTags: () => ["vegetarian"],
          searchRecipeCandidates: async () => [],
          getRecipeCandidatesByTags: () => [],
          getRecipeCandidatesByIngredients: () => [],
          getRecipesByIds: () => [],
        },
      }),
    );

    expect(result.intent).toBe("recipe");
    expect(persistedValidations).toEqual([
      expect.objectContaining({
        accepted: true,
        candidate: expect.objectContaining({
          kind: "dietary_restriction",
          scope: "user",
          action: "upsert",
          restrictionType: "other",
          subject: "vegetarian",
          severity: "strict_avoid",
          explicit: true,
        }),
      }),
    ]);
  }, 10000);

  it("requests approval before destructive inventory mutations", async () => {
    setLangSmithEnv();

    const events: QueryStreamEvent[] = [];

    for await (const event of streamQueryForFridgeImage(
      {
        fridgeId: "fridge-1",
        imageId: "image-1",
        query: "This cheese is double-counted.",
        threadId: `test-${randomUUID()}`,
      },
      fakeDeps({
        memoryCandidates: [
          {
            kind: "inventory_item",
            scope: "fridge",
            action: "remove",
            name: "cheese",
            storageLocation: "fridge",
            quantity: null,
            notes: null,
            explicit: true,
          },
        ],
        overrides: {
          persistMemoryValidations: undefined,
        },
      }),
    )) {
      events.push(event);
    }

    expect(events).toContainEqual({
      type: "inventory_mutation_review",
      operation: "remove",
      itemName: "cheese",
      storageLocation: "fridge",
    });
    expect(events.some((event) => event.type === "final")).toBe(false);
  });

  it("runs inventory intent through mutation extraction before answering", async () => {
    setLangSmithEnv();

    const events: QueryStreamEvent[] = [];

    for await (const event of streamQueryForFridgeImage(
      {
        fridgeId: "fridge-1",
        imageId: "image-1",
        query: "Delete the carrots",
        threadId: `test-${randomUUID()}`,
      },
      fakeDeps({
        intentResult: {
          intent: "inventory",
          recipeContinuation: false,
          shoppingMode: "direct",
          enrichment: { itemNames: [], fields: [] },
          memoryUpdateRequested: false,
        },
        memoryCandidates: [
          {
            kind: "inventory_item",
            scope: "fridge",
            action: "remove",
            name: "carrots",
            storageLocation: "fridge",
            quantity: null,
            notes: null,
            explicit: true,
          },
        ],
        overrides: {
          persistMemoryValidations: undefined,
        },
      }),
    )) {
      events.push(event);
    }

    expect(events).toContainEqual({
      type: "inventory_mutation_review",
      operation: "remove",
      itemName: "carrots",
      storageLocation: "fridge",
    });
    expect(events.some((event) => event.type === "final")).toBe(false);
  });

  it("deletes approved inventory removals from the active scanned inventory", async () => {
    await withTestDatabase(async () => {
      setLangSmithEnv();

      const image = createFridgeImage({
        dataUrl: createJpegDataUrl(),
        originalName: "carrots.jpg",
        storageLocation: "fridge",
        baseImageId: null,
      });

      saveFridgeInventory({
        imageId: image.id,
        inventory: createInventory({
          item: {
            id: "carrots-1",
            name: "carrot",
            label: "Baby carrots",
            cat: "produce",
            pack: "bag",
          },
        }),
      });

      const threadId = `test-${randomUUID()}`;
      const firstEvents: QueryStreamEvent[] = [];

      for await (const event of streamQueryForFridgeImage(
        {
          fridgeId: "fridge-1",
          imageId: image.id,
          query: "Delete the carrots",
          threadId,
        },
        fakeDeps({
          intentResult: {
            intent: "inventory",
            recipeContinuation: false,
            shoppingMode: "direct",
            enrichment: { itemNames: [], fields: [] },
            memoryUpdateRequested: false,
          },
          memoryCandidates: [
            {
              kind: "inventory_item",
              scope: "fridge",
              action: "remove",
              name: "carrots",
              storageLocation: "fridge",
              quantity: null,
              notes: null,
              explicit: true,
            },
          ],
          overrides: {
            loadInventoryForImage: getFridgeInventoryForImage,
            persistMemoryValidations: undefined,
          },
        }),
      )) {
        firstEvents.push(event);
      }

      expect(firstEvents).toContainEqual({
        type: "inventory_mutation_review",
        operation: "remove",
        itemName: "carrots",
        storageLocation: "fridge",
      });
      expect(getFridgeInventoryForImage(image.id)?.items.map((item) => item.name)).toEqual(["carrot"]);

      const resumedEvents: QueryStreamEvent[] = [];

      for await (const event of resumeQueryForFridgeImage(
        {
          threadId,
          resume: {
            answers: {},
            skipped: [],
            inventoryMutationReview: { approved: true },
          },
        },
        fakeDeps({
          overrides: {
            loadInventoryForImage: getFridgeInventoryForImage,
            persistMemoryValidations: undefined,
            responseModel: {
              invoke: async () => new AIMessage("Removed carrots from the inventory."),
            } as unknown as FridgeFriendChatModel,
          },
        }),
      )) {
        resumedEvents.push(event);
      }

      const updated = getFridgeInventoryForImage(image.id);
      const inventoryUpdatedEvent = resumedEvents.find((event): event is Extract<QueryStreamEvent, { type: "inventory_updated" }> =>
        event.type === "inventory_updated"
      );

      expect(updated?.items).toEqual([]);
      expect(inventoryUpdatedEvent?.inventory).toMatchObject({ items: [] });
      expect(resumedEvents.at(-1)).toMatchObject({
        type: "final",
        answer: "Removed carrots from the inventory.",
      });
    });
  }, 10000);

  it("skips memory extraction for plain recipe questions", async () => {
    setLangSmithEnv();

    let extractionCalls = 0;
    let recipeSearchCalls = 0;
    const searchQueries: string[] = [];

    const result = await runQueryForFridgeImage(
      {
        fridgeId: "fridge-1",
        imageId: "image-1",
        query: "What recipes can I make from the items in my fridge?",
        threadId: `test-${randomUUID()}`,
      },
      fakeDeps({
        intent: "recipe",
        overrides: {
          memoryExtractionModel: {
            withStructuredOutput: () => ({
              invoke: async () => {
                extractionCalls += 1;
                return { candidates: [] };
              },
            }),
          } as unknown as FridgeFriendChatModel,
          recipeSearchModel: {
            withStructuredOutput: () => ({
              invoke: async () => {
                recipeSearchCalls += 1;
                return {
                  semanticQuery: "unused",
                  useAvailableIngredients: false,
                  excludedIngredients: [],
                  dietaryRestrictions: [],
                  maxMinutes: null,
                  maxCalories: null,
                  minProteinDailyValue: null,
                  preferredIngredients: [],
                };
              },
            }),
          } as unknown as FridgeFriendChatModel,
          searchRecipeCandidates: async (input) => {
            searchQueries.push(input.query);
            return [];
          },
        },
      }),
    );

    expect(result.intent).toBe("recipe");
    expect(extractionCalls).toBe(0);
    expect(recipeSearchCalls).toBe(0);
    expect(searchQueries).toEqual(["recipe using chicken"]);
  }, 10000);

  it("uses the bounded corrective retrieval before the response model answers", async () => {
    setLangSmithEnv();

    let responseModelCalls = 0;
    const searchQueries: string[] = [];
    const result = await runQueryForFridgeImage(
      {
        fridgeId: "fridge-1",
        imageId: "image-1",
        query: "What can I make with items in this fridge?",
        threadId: `test-${randomUUID()}`,
      },
      fakeDeps({
        intent: "recipe",
        responseModel: {
          invoke: async () => {
            responseModelCalls += 1;
            return new AIMessage("Retrieval did not produce a recipe safe to recommend from the supplied data.");
          },
        } as unknown as FridgeFriendChatModel,
        overrides: {
          loadInventoryForImage: () =>
            createInventory({
              item: {
                name: "eggs",
                label: "Eggs",
                cat: "eggs",
                pack: "carton",
              },
            }),
          searchRecipeCandidates: async (input) => {
            searchQueries.push(input.query);
            return [];
          },
          getRecipeCandidatesByTags: () => [],
          getRecipeCandidatesByIngredients: () => [],
        },
      }),
    );

    expect(searchQueries).toEqual(["recipe using egg", "recipe using egg"]);
    expect(responseModelCalls).toBe(1);
    expect(result.answer).toBe("Retrieval did not produce a recipe safe to recommend from the supplied data.");
  }, 10000);

  it("runs memory extraction only when intent routing identifies a durable update", () => {
    expect(shouldExtractMemoryCandidates({
      userId: "default-user",
      fridgeId: "fridge-1",
      imageId: "image-1",
      query: "I have Jasmine rice in the pantry. What can I cook?",
      context: { intentRouting: { memoryUpdateRequested: true } },
    } as unknown as FridgeQueryStateValue)).toBe(true);
    expect(shouldExtractMemoryCandidates({
      userId: "default-user",
      fridgeId: "fridge-1",
      imageId: "image-1",
      query: "What recipes can I make from the items in my fridge?",
      context: { intentRouting: { memoryUpdateRequested: false } },
    } as unknown as FridgeQueryStateValue)).toBe(false);
  });

  it("passes explicit user and fridge scope to the memory context loader", async () => {
    setLangSmithEnv();

    const scopedCalls: Array<{ userId: string; fridgeId: string }> = [];

    await runQueryForFridgeImage(
      {
        userId: "user-42",
        fridgeId: "fridge-42",
        imageId: "image-1",
        query: "What is in here?",
        threadId: `test-${randomUUID()}`,
      },
      fakeDeps({
        overrides: {
          loadMemoryContext: (input) => {
            scopedCalls.push({
              userId: input.userId,
              fridgeId: input.fridgeId,
            });
            return emptyMemoryContext();
          },
        },
      }),
    );

    expect(scopedCalls).toContainEqual(
      {
        userId: "user-42",
        fridgeId: "fridge-42",
      },
    );
  });
});
