import type { FridgeFriendChatModel } from "../../../../../app/server/ai/chat-model.server";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { describe, expect, it } from "vitest";

import { createDetermineIntentNode } from "../../../../../app/server/query/nodes/determine-intent.node";
import {
  CHAT_PROVIDER,
  GENERAL_MODEL,
  INTENT_ROUTING_TIMEOUT_MS,
} from "../../../../../app/server/query/services/query-model.server";
import type {
  IntentRoutingChoice,
  QueryGraphDependencies,
  QueryIntent,
} from "../../../../../app/server/query/schemas/query";
import type { FridgeQueryStateValue } from "../../../../../app/server/query/state";
import { QUERY_INTENTS } from "../../../../../app/workspace/query-events";

function recipeSearchProfile() {
  return {
    semanticQuery: "fridge recipes",
    semanticQueryWithoutInventory: "recipe",
    vectorCandidateLimit: 50,
    correctiveAttempt: false,
    plan: { userFacets: [], userTags: [], memoryTags: [], inventoryIngredients: ["eggs", "tortillas"] },
    intent: { specific: false, relatedSemanticQuery: null },
    useAvailableIngredients: true,
    excludedIngredients: [],
    dietaryRestrictions: [],
    maxMinutes: null,
    maxCalories: null,
    minProteinDailyValue: null,
    preferredIngredients: ["eggs", "tortillas"],
    requiredTags: [],
    preferredTags: [],
    excludedTags: [],
    memoryPreferredTags: [],
    memoryExcludedTags: [],
    memoryGoalTags: [],
    continuation: false,
  };
}

function state(overrides: Partial<FridgeQueryStateValue> = {}) {
  return {
    userId: "default-user",
    fridgeId: "fridge-1",
    imageId: "image-1",
    query: "more options please",
    context: {},
    recipeSearchSession: null,
    lastRecipeSearch: null,
    ...overrides,
  } as FridgeQueryStateValue;
}

function intentChoicesForResult(result: unknown): IntentRoutingChoice[] {
  const intent = typeof result === "object" &&
    result !== null &&
    "intent" in result &&
    typeof result.intent === "string" &&
    QUERY_INTENTS.includes(result.intent as QueryIntent)
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

function deps(
  result: unknown,
  capture?: (messages: unknown, options: unknown) => void,
): QueryGraphDependencies {
  return {
    promptBundle: {
      intentRouting: {
        name: "intent-routing",
        ref: "test:intent-routing",
        prompt: ChatPromptTemplate.fromMessages([
          ["system", "Route a message to exactly one intent. {{intent_routing_choice_1}} {{intent_routing_choice_2}} {{intent_routing_choice_3}} Set enrichment.itemNames and enrichment.fields only when a missing inventory detail could materially change the answer. Fields are identity, quantity, fill_level, expiration_date, and opened. Leave both arrays empty when the coarse inventory is sufficient."],
          ["human", "{{intent_routing_context_json}}"],
        ], { templateFormat: "mustache" }),
      },
    } as unknown as QueryGraphDependencies["promptBundle"],
    intentModel: {
      withStructuredOutput: () => ({
        invoke: async (messages: unknown, options: unknown) => {
          capture?.(messages, options);
          return result;
        },
      }),
    } as unknown as FridgeFriendChatModel,
    intentEmbeddingRouter: async () => ({
      accepted: null,
      candidates: intentChoicesForResult(result),
    }),
  };
}

describe("determine intent node", () => {
  it("routes with prior recipe session context", async () => {
    let capturedMessages: unknown;
    const node = createDetermineIntentNode(deps(
      { intent: "recipe", recipeContinuation: true },
      (messages) => {
        capturedMessages = messages;
      },
    ));

    const result = await node(state({
      recipeSearchSession: {
        profile: recipeSearchProfile(),
        inventoryFingerprint: "eggs|tortillas",
        shownRecipeIds: ["recipe-1", "recipe-2"],
      },
      recipeSearchExhausted: false,
    }));
    const messages = capturedMessages as Array<{ content: unknown }>;
    const payload = JSON.parse(String(messages[1].content));

    expect(result.intent).toBe("recipe");
    expect(result.context).toMatchObject({
      intentRouting: {
        recipeContinuation: true,
      },
    });
    expect(String(messages[0].content)).toContain("recipe recommendations/ details, or options from a previous recipe set");
    expect(payload.priorRecipeSearch).toMatchObject({
      semanticQuery: "fridge recipes",
      useAvailableIngredients: true,
      shownRecipeCount: 2,
      exhausted: false,
    });
  });

  it("honors an explicit recipe continuation request without model classification", async () => {
    let modelCalls = 0;
    const node = createDetermineIntentNode(deps(
      { intent: "inventory" },
      () => {
        modelCalls += 1;
      },
    ));

    const result = await node(state({
      context: { recipeContinuationRequested: true },
      recipeSearchSession: {
        profile: recipeSearchProfile(),
        inventoryFingerprint: "eggs|tortillas",
        shownRecipeIds: ["recipe-1", "recipe-2"],
      },
    }));

    expect(modelCalls).toBe(0);
    expect(result).toMatchObject({
      intent: "recipe",
      context: {
        intentRouting: {
          recipeContinuation: true,
        },
      },
    });
  });

  it("routes selected item detail requests without model classification", async () => {
    let modelCalls = 0;
    const node = createDetermineIntentNode(deps(
      { intent: "recipe" },
      () => {
        modelCalls += 1;
      },
    ));

    const result = await node(state({
      query: "Get more detail about this.",
      context: {
        conversationContext: {
          selectedItemIds: ["milk"],
          selectedZoneIds: [],
          selectedRecipeId: null,
          seededItems: [{
            itemId: "milk",
            imageId: "image-1",
            cropId: "crop:milk",
            userSeeded: true,
          }],
        },
      },
    }));

    expect(modelCalls).toBe(0);
    expect(result).toMatchObject({
      intent: "inventory",
      context: {
        intentRouting: {
          recipeContinuation: false,
          shoppingMode: "direct",
          enrichment: {
            itemNames: ["milk"],
            fields: ["identity", "quantity", "fill_level", "opened", "expiration_date"],
          },
          memoryUpdateRequested: false,
        },
      },
    });
  });

  it("uses high-confidence embedding routing before model classification", async () => {
    let modelCalls = 0;
    const node = createDetermineIntentNode({
      ...deps(
        { intent: "inventory" },
        () => {
          modelCalls += 1;
        },
      ),
      intentEmbeddingRouter: async () => ({
        intent: "shopping",
        recipeContinuation: false,
        shoppingMode: "grocery_planner",
        enrichment: { itemNames: [], fields: [] },
        memoryUpdateRequested: false,
      }),
    });

    const result = await node(state({ query: "Make a grocery list for tacos." }));

    expect(modelCalls).toBe(0);
    expect(result).toMatchObject({
      intent: "shopping",
      context: {
        intentRouting: {
          shoppingMode: "grocery_planner",
        },
      },
    });
  });

  it("uses model classification when embedding routing is unresolved", async () => {
    let modelCalls = 0;
    const node = createDetermineIntentNode(deps(
      { intent: "organization", enrichment: { itemNames: [], fields: [] } },
      () => {
        modelCalls += 1;
      },
    ));

    const result = await node(state({ query: "Can you help with this?" }));

    expect(modelCalls).toBe(1);
    expect(result).toMatchObject({
      intent: "organization",
    });
  });

  it("limits model intent choices to the top three embedding candidates", async () => {
    let capturedMessages: unknown;
    let capturedSchema: unknown;
    const node = createDetermineIntentNode({
      ...deps(
        { intent: "shopping", enrichment: { itemNames: [], fields: [] } },
        (messages) => {
          capturedMessages = messages;
        },
      ),
      intentEmbeddingRouter: async () => ({
        accepted: null,
        candidates: [
          { intent: "shopping", score: 0.81, margin: 0.04, example: { intent: "shopping", text: "shopping example" } },
          { intent: "recipe", score: 0.77, margin: 0.03, example: { intent: "recipe", text: "recipe example" } },
          { intent: "inventory", score: 0.74, margin: 0.02, example: { intent: "inventory", text: "inventory example" } },
        ],
      }),
      intentModel: {
        withStructuredOutput: (schema: unknown) => {
          capturedSchema = schema;
          return {
            invoke: async (messages: unknown, options: unknown) => {
              capturedMessages = messages;
              expect(options).toBeDefined();
              return { intent: "shopping", enrichment: { itemNames: [], fields: [] }, memoryUpdateRequested: false };
            },
          };
        },
      } as unknown as FridgeFriendChatModel,
    });

    await expect(node(state({ query: "What am I missing for dinner?" }))).resolves.toMatchObject({
      intent: "shopping",
    });

    const messages = capturedMessages as Array<{ content: unknown }>;
    const systemPrompt = String(messages[0].content);
    expect(systemPrompt).toContain("shopping: groceries, restocking, replacements, missing ingredients.");
    expect(systemPrompt).toContain("recipe: cooking ideas, meal planning, recipe recommendations/ details, or options from a previous recipe set.");
    expect(systemPrompt).toContain("inventory: current recorded food inventory, quantities, locations, or visible item facts.");
    expect(systemPrompt).not.toContain("space: physical storage fit or shelf capacity");
    expect(capturedSchema).toMatchObject({
      properties: {
        intent: {
          enum: ["shopping", "recipe", "inventory"],
        },
      },
    });
  });

  it("sets a ten-second deadline on intent routing", async () => {
    let capturedOptions: unknown;
    const node = createDetermineIntentNode(deps(
      { intent: "recipe", recipeContinuation: false },
      (_messages, options) => {
        capturedOptions = options;
      },
    ));

    await node(state());

    expect(capturedOptions).toMatchObject({
      timeout: INTENT_ROUTING_TIMEOUT_MS,
      metadata: { provider: CHAT_PROVIDER, model: GENERAL_MODEL },
    });
  });

  it("returns clarification when structured routing output is invalid", async () => {
    const node = createDetermineIntentNode(deps({ intent: "unknown_route" }));
    const result = await node(state());

    expect(result.intent).toBe("clarification");
    expect(result.context).toMatchObject({
      intentRoutingError: expect.stringContaining("Intent routing returned invalid output"),
    });
  });

  it("adds intent-routing context to provider invocation failures", async () => {
    const node = createDetermineIntentNode({
      ...deps({}),
      intentModel: {
        withStructuredOutput: () => ({
          invoke: async () => {
            throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
          },
        }),
      } as unknown as FridgeFriendChatModel,
    });

    await expect(node(state({ query: "How can I arrange my fridge more efficiently?" }))).rejects.toThrow(
      'Intent routing failed for query "How can I arrange my fridge more efficiently?" after 10000ms: The operation was aborted due to timeout',
    );
  });

  it("accepts the expiry workflow intent", async () => {
    const node = createDetermineIntentNode(deps({ intent: "expiry" }));

    await expect(node(state({ query: "Plan meals that use food before it goes bad." }))).resolves.toMatchObject({
      intent: "expiry",
    });
  });

  it("instructs the model with the selected organization choice", async () => {
    let capturedMessages: unknown;
    const node = createDetermineIntentNode(deps(
      { intent: "organization", enrichment: { itemNames: [], fields: [] } },
      (messages) => {
        capturedMessages = messages;
      },
    ));

    await expect(node(state({ query: "How can I arrange my fridge more efficiently?" }))).resolves.toMatchObject({
      intent: "organization",
    });

    const messages = capturedMessages as Array<{ content: unknown }>;
    const systemPrompt = String(messages[0].content);
    expect(systemPrompt).toContain("organization: arranging, reorganizing, improving storage efficiency, grouping, moving inventory.");
    expect(systemPrompt).not.toContain("space: physical storage fit or shelf capacity");
  });

  it("accepts general chat as a non-clarification route", async () => {
    const node = createDetermineIntentNode(deps({
      intent: "general_chat",
      enrichment: { itemNames: [], fields: [] },
    }));

    await expect(node(state({ query: "I like bright, acidic flavors." }))).resolves.toMatchObject({
      intent: "general_chat",
    });
  });

  it("marks explicit durable facts for memory extraction", async () => {
    const node = createDetermineIntentNode(deps({
      intent: "recipe",
      memoryUpdateRequested: true,
      enrichment: { itemNames: [], fields: [] },
    }));

    await expect(node(state({ query: "I have jasmine rice in the pantry. What can I cook?" }))).resolves.toMatchObject({
      intent: "recipe",
      context: { intentRouting: { memoryUpdateRequested: true } },
    });
  });

  it("preserves pantry completion as a dedicated shopping mode", async () => {
    const node = createDetermineIntentNode(deps({
      intent: "shopping",
      shoppingMode: "pantry_completion",
      enrichment: { itemNames: [], fields: [] },
    }));

    await expect(node(state({ query: "Which pantry staples unlock more recipes?" }))).resolves.toMatchObject({
      intent: "shopping",
      context: { intentRouting: { shoppingMode: "pantry_completion" } },
    });
  });
});
