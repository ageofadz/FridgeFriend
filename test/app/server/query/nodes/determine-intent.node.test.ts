import type { FridgeFriendChatModel } from "../../../../../app/server/ai/chat-model.server";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { describe, expect, it } from "vitest";

import { createDetermineIntentNode } from "../../../../../app/server/query/nodes/determine-intent.node";
import {
  CHAT_PROVIDER,
  GENERAL_MODEL,
  INTENT_ROUTING_TIMEOUT_MS,
} from "../../../../../app/server/query/services/query-model.server";
import type { QueryGraphDependencies } from "../../../../../app/server/query/schemas/query";
import type { FridgeQueryStateValue } from "../../../../../app/server/query/state";

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
          ["system", "recipe: cooking ideas, meal planning, recipe recommendations, recipe details, or additional options from a previous recipe result set.\nChoose organization when the user asks how to arrange, reorganize, store, group, or make the fridge more efficient.\nChoose space only when the user asks about capacity or fit without asking for an arrangement plan."],
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
    expect(String(messages[0].content)).toContain("additional options from a previous recipe result set");
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

  it("instructs the model to route fridge arrangement efficiency requests to organization", async () => {
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
    expect(systemPrompt).toContain("Choose organization when the user asks how to arrange, reorganize, store, group, or make the fridge more efficient.");
    expect(systemPrompt).toContain("Choose space only when the user asks about capacity or fit without asking for an arrangement plan.");
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
