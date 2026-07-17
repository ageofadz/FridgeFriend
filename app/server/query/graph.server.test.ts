import { AIMessage } from "@langchain/core/messages";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import type { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { randomUUID } from "node:crypto";
import { encode as encodeJpeg } from "jpeg-js";
import { describe, expect, it } from "vitest";

import {
  isVisibleResponseMessageMetadata,
  runQueryForFridgeImage,
  streamQueryForFridgeImage,
} from "./graph.server";
import { shouldExtractMemoryCandidates } from "./nodes/extract-memory-candidates.node";
import {
  QUERY_VISIBLE_RESPONSE_TAG,
  type QueryGraphDependencies,
  type QueryIntent,
  type QueryStreamEvent,
} from "./schemas/query";
import type { MemoryCandidate, MemoryContext } from "../memory/schemas";
import { PromptName } from "../prompts/registry.server";
import type { Recipe } from "../recipes/types";
import type { Inventory } from "../scan/schemas/inventory";

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
          amount: item.qty?.amount ?? 1,
          unit: item.qty?.unit ?? "package",
          precision: item.qty?.precision ?? "estimated",
          fillLevel: item.qty?.fillLevel ?? null,
        },
        pack: item.pack ?? "tray",
        loc: {
          status: "matched",
          zoneId: "zone-1",
          zoneType: "shelf",
          observations: input.observations ?? [],
          confidence: 0.9,
        },
        conf: 0.9,
        src: ["detection-1"],
        attrs: {
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

function createRecipe(input: {
  id: string;
  name: string;
  ingredients: string[];
  semanticDescription?: string;
  minutes?: number;
}): Recipe {
  return {
    id: input.id,
    name: input.name,
    description: input.semanticDescription ?? `${input.name} description.`,
    ingredients: input.ingredients.map((ingredient) => ({
      rawName: ingredient,
      canonicalName: ingredient,
    })),
    tags: ["dinner"],
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
  } as unknown as ChatGoogleGenerativeAI;
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
    recipeQueryRewrite: {
      name: PromptName.RecipeQueryRewrite,
      ref: "fridgefriend-recipe-query-rewrite:latest",
      prompt: ChatPromptTemplate.fromMessages([["human", "{{recipe_rewrite_context_json}}"]], { templateFormat: "mustache" }),
    },
    recipeTournamentEvaluation: {
      name: PromptName.RecipeTournamentEvaluation,
      ref: "fridgefriend-recipe-tournament-evaluation:latest",
      prompt: ChatPromptTemplate.fromMessages([["human", "{{recipe_tournament_context_json}}"]], { templateFormat: "mustache" }),
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
  recipeSearch?: {
    semanticQuery: string;
    useAvailableIngredients: boolean;
    excludedIngredients: string[];
    dietaryRestrictions: string[];
    maxMinutes: number | null;
    maxCalories: number | null;
    minProteinDailyValue: number | null;
    preferredIngredients: string[];
  };
  memoryCandidates?: MemoryCandidate[];
  memoryContext?: MemoryContext;
  responseModel?: ChatGoogleGenerativeAI;
  overrides?: Partial<QueryGraphDependencies>;
} = {}): QueryGraphDependencies {
  const intentModel = {
    withStructuredOutput: () => ({
      invoke: async () => ({ intent: input.intent ?? "inventory" }),
    }),
  } as unknown as ChatGoogleGenerativeAI;
  const responseModel = {
    invoke: async () => new AIMessage("Final streamed answer"),
  } as unknown as ChatGoogleGenerativeAI;

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
    recipeSearchModel: createStructuredModel(input.recipeSearch ?? {
      semanticQuery: "recipe search",
      useAvailableIngredients: false,
      excludedIngredients: [],
      dietaryRestrictions: [],
      maxMinutes: null,
      maxCalories: null,
      minProteinDailyValue: null,
      preferredIngredients: [],
    }),
    recipeRetrievalGradeModel: createStructuredModel({ relevant: true, reason: "Relevant recipe set" }),
    recipeQueryRewriteModel: createStructuredModel({ semanticQuery: "rewritten recipe search" }),
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
      fakeDeps(),
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
      workspaceActions: [],
      agentEvents: [],
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
        } as unknown as ChatGoogleGenerativeAI,
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
      candidateCount: 3,
      displaySlotCount: 3,
    });
    expect(updates).toHaveLength(3);
    expect(updates.map((event) => event.evaluatedCount)).toEqual([1, 2, 3]);
    expect(updates[0].recipes).toHaveLength(1);
    expect(updates[2].recipes).toHaveLength(3);
    expect(finished?.type).toBe("recipe_tournament_finished");
    expect(finished && "recipes" in finished ? finished.recipes : []).toHaveLength(3);
    expect(finished && "recipes" in finished ? finished.recipes : []).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: expect.any(String), tournamentPlacement: "winner" }),
        expect.objectContaining({ id: expect.any(String), tournamentPlacement: "finalist" }),
      ]),
    );
    expect(final).toMatchObject({
      type: "final",
      answer: "Recipe suggestions",
      intent: "recipe",
    });
    expect(final && "recipes" in final ? final.recipes : []).toHaveLength(3);
    expect(final && "recipes" in final ? final.recipes : []).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: expect.any(String), tournamentPlacement: "winner" }),
        expect.objectContaining({ id: expect.any(String), tournamentPlacement: "finalist" }),
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
              scannedInventory: {
                items: [
                  {
                    displayName: "Eggs",
                    quantity: {
                      amount: 12,
                      unit: "count",
                    },
                  },
                ],
              },
            });

            return new AIMessage("You have 12 eggs.");
          },
        } as unknown as ChatGoogleGenerativeAI,
        overrides: {
          intentModel: {
            withStructuredOutput: () => ({
              invoke: async () => {
                intentModelCalls += 1;
                return { intent: "inventory" };
              },
            }),
          } as unknown as ChatGoogleGenerativeAI,
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
    } as unknown as ChatGoogleGenerativeAI;
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
        } as unknown as ChatGoogleGenerativeAI,
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
      scannedInventory: {
        items: [
          {
            displayName: "Egg carton",
            quantity: {
              amount: 2,
              unit: "package",
            },
          },
        ],
      },
    });
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
    } as unknown as ChatGoogleGenerativeAI;

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
        },
      },
      fakeDeps({
        responseModel: {
          invoke: async (messages: Array<{ content: unknown }>) => {
            capturedMessages = messages;
            return new AIMessage("The seeded yogurt is first, and milk is still considered.");
          },
        } as unknown as ChatGoogleGenerativeAI,
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

    expect(payload.context.inventoryQuery.scannedInventory.items.map((item: { id: string }) => item.id)).toEqual([
      "item-2",
      "item-1",
    ]);
    expect(payload.context.inventoryQuery.scannedInventory.items[0]).toMatchObject({
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
    } as unknown as ChatGoogleGenerativeAI;
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
    } as unknown as ChatGoogleGenerativeAI;

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
    } as unknown as ChatGoogleGenerativeAI;

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
    } as unknown as ChatGoogleGenerativeAI;

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
          } as unknown as ChatGoogleGenerativeAI,
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
          } as unknown as ChatGoogleGenerativeAI,
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
    expect(searchQueries).toEqual(["What recipes can I make from the items in my fridge?\nAvailable ingredients: chicken"]);
  }, 10000);

  it("does not ask the response model to invent recipe prose when Food.com has no matches", async () => {
    setLangSmithEnv();

    let responseModelCalls = 0;
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
            return new AIMessage("However, you can make something else.");
          },
        } as unknown as ChatGoogleGenerativeAI,
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
          searchRecipeCandidates: async () => [],
          getRecipeCandidatesByTags: () => [],
          getRecipeCandidatesByIngredients: () => [],
        },
      }),
    );

    expect(responseModelCalls).toBe(0);
    expect(result.answer).toBe(
      "The local Food.com index found no matching recipes for the searched ingredients: egg.",
    );
  }, 10000);

  it("runs memory extraction when the recipe question includes durable pantry facts", () => {
    expect(shouldExtractMemoryCandidates(
      "I have Jasmine rice in the pantry. What can I cook?",
    )).toBe(true);
    expect(shouldExtractMemoryCandidates(
      "What recipes can I make from the items in my fridge?",
    )).toBe(false);
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

    expect(scopedCalls).toEqual([
      {
        userId: "user-42",
        fridgeId: "fridge-42",
      },
    ]);
  });
});
