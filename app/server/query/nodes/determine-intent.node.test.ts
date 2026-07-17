import type { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { describe, expect, it } from "vitest";

import { createDetermineIntentNode } from "./determine-intent.node";
import type { QueryGraphDependencies } from "../schemas/query";
import type { FridgeQueryStateValue } from "../state";

function recipeSearchProfile() {
  return {
    semanticQuery: "fridge recipes",
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

function deps(result: unknown, capture?: (messages: unknown) => void): QueryGraphDependencies {
  return {
    intentModel: {
      withStructuredOutput: () => ({
        invoke: async (messages: unknown) => {
          capture?.(messages);
          return result;
        },
      }),
    } as unknown as ChatGoogleGenerativeAI,
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
      context: {
        recipeRetrieval: {
          exhausted: false,
        },
      },
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

  it("returns clarification when structured routing output is invalid", async () => {
    const node = createDetermineIntentNode(deps({ intent: "unknown_route" }));
    const result = await node(state());

    expect(result.intent).toBe("clarification");
    expect(result.context).toMatchObject({
      intentRoutingError: expect.stringContaining("Intent routing returned invalid output"),
    });
  });

  it("accepts the expiry workflow intent", async () => {
    const node = createDetermineIntentNode(deps({ intent: "expiry" }));

    await expect(node(state({ query: "Plan meals that use food before it goes bad." }))).resolves.toMatchObject({
      intent: "expiry",
    });
  });
});
