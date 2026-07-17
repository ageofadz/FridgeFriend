import { ChatAnthropic } from "@langchain/anthropic";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { describe, expect, it } from "vitest";

import {
  CHAT_MAX_OUTPUT_TOKENS,
  CHAT_VISION_PROVIDER,
  CHAT_VISION_MODEL,
  chatProviderSource,
  createChatModelForProvider,
} from "../../../../app/server/ai/chat-model.server";
import { reconcileInventory } from "../../../../app/server/scan/services/inventory-reconciliation.server";
import type { ScanStateValue } from "../../../../app/server/scan/state";

describe("chat model provider boundary", () => {
  it("creates Anthropic chat models", () => {
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key";

    const model = createChatModelForProvider({
      provider: "anthropic",
      model: "claude-haiku-4-5-20251001",
    });

    expect(model).toBeInstanceOf(ChatAnthropic);
    expect((model as ChatAnthropic).temperature).toBeUndefined();
    expect((model as ChatAnthropic).maxTokens).toBe(CHAT_MAX_OUTPUT_TOKENS);
    expect((model as ChatAnthropic).thinking).toEqual({ type: "disabled" });
  });

  it("creates Google chat models", () => {
    process.env.GOOGLE_API_KEY = "test-google-key";

    const model = createChatModelForProvider({
      provider: CHAT_VISION_PROVIDER,
      model: CHAT_VISION_MODEL,
    });

    expect(model).toBeInstanceOf(ChatGoogleGenerativeAI);
    expect((model as ChatGoogleGenerativeAI).temperature).toBe(0);
    expect((model as ChatGoogleGenerativeAI).maxOutputTokens).toBe(CHAT_MAX_OUTPUT_TOKENS);
    expect((model as ChatGoogleGenerativeAI).streaming).toBe(false);
    expect((model as ChatGoogleGenerativeAI).disableStreaming).toBe(true);
  });

  it("rejects unsupported chat providers", () => {
    expect(() =>
      createChatModelForProvider({
        provider: "openai",
        model: "gpt-5",
      }),
    ).toThrow("Unsupported chat provider: openai");
  });

  it("records provider-specific inventory source and model metadata", async () => {
    const result = await reconcileInventory({
      fridgeId: "fridge-1",
      imageIds: ["image-1"],
      storageLocation: "fridge",
      rawDetections: [],
      detectionModelRawOutput: null,
      zoneMaps: [],
      zoneMapModelRawOutput: null,
      groundedPlacements: [],
      reconciledLocations: [],
      ambiguousLocationRequests: [],
      adjudicationDecisions: [],
      inventory: null,
      imageValidation: null,
      detectionValidation: null,
      zoneMapValidation: null,
      placementValidation: null,
      reconciliationValidation: null,
      adjudicationValidation: null,
      inventoryValidation: null,
      scanStatus: "processing",
      error: null,
    } satisfies ScanStateValue);

    expect(result.inventory.source).toBe(chatProviderSource(CHAT_VISION_PROVIDER));
    expect(result.inventory.model).toBe(CHAT_VISION_MODEL);
  });
});
