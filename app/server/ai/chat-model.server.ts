import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { Runnable } from "@langchain/core/runnables";
import { ChatAnthropic } from "@langchain/anthropic";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";

import { requiredEnv } from "../env.server";

export type ChatProvider = "anthropic" | "google";
export type FridgeFriendChatModel = {
  invoke: BaseChatModel["invoke"];
  withStructuredOutput: <RunOutput extends Record<string, any> = Record<string, any>>(
    outputSchema: unknown,
    config?: unknown,
  ) => Runnable<unknown, RunOutput>;
};

export const CHAT_PROVIDER: ChatProvider = "google";
export const CHAT_VISION_PROVIDER: ChatProvider = "google";
export const CHAT_MODEL = "gemini-3.1-flash-lite";
export const CHAT_VISION_MODEL = "gemini-3.1-flash-lite";
export const CHAT_IMAGE_VALIDATION_MODEL = CHAT_VISION_MODEL;
export const CHAT_MAX_OUTPUT_TOKENS = 4096;

export function chatProviderSource(provider: ChatProvider = CHAT_PROVIDER) {
  switch (provider) {
    case "anthropic":
      return "anthropic-vision" as const;
    case "google":
      return "gemini-vision" as const;
    default:
      throw new Error(`Unsupported chat provider: ${provider}`);
  }
}

export function createChatModelForProvider(input: {
  provider: string;
  model: string;
  streaming?: boolean;
  maxOutputTokens?: number;
}): FridgeFriendChatModel {
  switch (input.provider) {
    case "anthropic":
      return new ChatAnthropic({
        model: input.model,
        maxTokens: input.maxOutputTokens ?? CHAT_MAX_OUTPUT_TOKENS,
        thinking: { type: "disabled" },
        maxRetries: 0,
        apiKey: requiredEnv("ANTHROPIC_API_KEY"),
        streaming: input.streaming ?? false,
      }) as FridgeFriendChatModel;
    case "google":
      const model = new ChatGoogleGenerativeAI({
        model: input.model,
        temperature: 0,
        maxOutputTokens: input.maxOutputTokens ?? CHAT_MAX_OUTPUT_TOKENS,
        maxRetries: 0,
        apiKey: requiredEnv("GOOGLE_API_KEY"),
        streaming: false,
      });
      model.disableStreaming = true;
      return model as FridgeFriendChatModel;
    default:
      throw new Error(`Unsupported chat provider: ${input.provider}`);
  }
}

export function createChatModel(input: {
  model: string;
  streaming?: boolean;
  provider?: ChatProvider;
  maxOutputTokens?: number;
}): FridgeFriendChatModel {
  return createChatModelForProvider({
    provider: input.provider ?? CHAT_PROVIDER,
    model: input.model,
    streaming: input.streaming,
    maxOutputTokens: input.maxOutputTokens,
  });
}
