import { ChatPromptTemplate } from "@langchain/core/prompts";
import { describe, expect, it } from "vitest";

import type { FridgeFriendChatModel } from "../../../../../app/server/ai/chat-model.server";
import { PromptName } from "../../../../../app/server/prompts/registry.server";
import {
  createExtractMemoryCandidatesNode,
  shouldExtractMemoryCandidates,
} from "../../../../../app/server/query/nodes/extract-memory-candidates.node";
import type { QueryGraphDependencies } from "../../../../../app/server/query/schemas/query";
import type { FridgeQueryStateValue } from "../../../../../app/server/query/state";

function deps(result: unknown): QueryGraphDependencies {
  return {
    promptBundle: {
      queryMemoryExtraction: {
        name: PromptName.QueryMemoryExtraction,
        ref: "bundled:query-memory-extraction",
        prompt: ChatPromptTemplate.fromMessages([["human", "{{query}}"]], { templateFormat: "mustache" }),
      },
    } as unknown as QueryGraphDependencies["promptBundle"],
    memoryExtractionModel: {
      withStructuredOutput: () => ({
        invoke: async () => result,
      }),
    } as unknown as FridgeFriendChatModel,
  };
}

function state(query: string): FridgeQueryStateValue {
  return {
    userId: "default-user",
    fridgeId: "default-fridge",
    imageId: null,
    query,
    context: {},
  } as FridgeQueryStateValue;
}

describe("shouldExtractMemoryCandidates", () => {
  it("extracts once for every query", () => {
    expect(shouldExtractMemoryCandidates(state("What can I make for dinner tonight?"))).toBe(true);
    expect(shouldExtractMemoryCandidates({
      ...state("I have Jasmine rice in the pantry. What can I cook?"),
      context: { memoryExtractionCompleted: false },
    })).toBe(true);
    expect(shouldExtractMemoryCandidates({
      ...state("What can I make for dinner tonight?"),
      context: { memoryExtractionCompleted: true },
    })).toBe(false);
  });

  it("uses structured model output for explicit dietary restrictions", async () => {
    const node = createExtractMemoryCandidatesNode(deps({
      candidates: [
        {
          kind: "dietary_restriction",
          scope: "user",
          action: "upsert",
          restrictionType: "allergy",
          subject: "peanuts",
          severity: "strict_avoid",
          notes: null,
          explicit: true,
        },
      ],
    }));
    const result = await node(state("I can't eat peanuts."));

    expect(result.memoryCandidates).toEqual([
      {
        kind: "dietary_restriction",
        scope: "user",
        action: "upsert",
        restrictionType: "allergy",
        subject: "peanuts",
        severity: "strict_avoid",
        notes: null,
        explicit: true,
      },
    ]);
  });

  it("uses structured model output for explicit dietary preferences", async () => {
    let modelCalls = 0;
    const node = createExtractMemoryCandidatesNode({
      ...deps({ candidates: [] }),
      memoryExtractionModel: {
        withStructuredOutput: () => ({
          invoke: async () => {
            modelCalls += 1;
            return {
              candidates: [
                {
                  kind: "preference",
                  scope: "user",
                  action: "upsert",
                  subject: "spicy food",
                  sentiment: "like",
                  strength: 4,
                  notes: null,
                  explicit: true,
                },
              ],
            };
          },
        }),
      } as unknown as FridgeFriendChatModel,
    });
    const result = await node(state("I like spicy food"));

    expect(modelCalls).toBe(1);
    expect(result.memoryCandidates).toEqual([
      {
        kind: "preference",
        scope: "user",
        action: "upsert",
        subject: "spicy food",
        sentiment: "like",
        strength: 4,
        notes: null,
        explicit: true,
      },
    ]);
  });

  it("hydrates an explicit goal description from the user's complete message", async () => {
    const node = createExtractMemoryCandidatesNode(deps({
      candidates: [{
        kind: "goal",
        scope: "user",
        action: "upsert",
        goalType: "weight_loss",
        targetValue: null,
        targetUnit: null,
        priority: 3,
        explicit: true,
      }],
    }));

    const result = await node(state("I want to lose weight"));

    expect(result.memoryCandidates).toEqual([expect.objectContaining({
      kind: "goal",
      goalType: "weight_loss",
      description: "I want to lose weight",
    })]);
  });

  it("uses structured model output for explicit dietary identities", async () => {
    const node = createExtractMemoryCandidatesNode(deps({
      candidates: [
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
    }));
    const result = await node(state("I am vegetarian."));

    expect(result.memoryCandidates).toEqual([
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
    ]);
  });

  it("stores LLM-classified dietary identities as persistable restrictions", async () => {
    const node = createExtractMemoryCandidatesNode(deps({
      candidates: [
        {
          kind: "dietary_restriction",
          scope: "user",
          action: "upsert",
          restrictionType: "other",
          subject: "vegetarian",
          severity: "vegetarian",
          notes: null,
          explicit: true,
        },
      ],
    }));
    const result = await node(state("I am vegetarian."));

    expect(result.memoryCandidates).toEqual([
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
    ]);
  });

});
