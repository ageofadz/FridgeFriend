import { AIMessage } from "@langchain/core/messages";

import {
  CHAT_MODEL as GENERAL_MODEL,
  CHAT_PROVIDER,
  createChatModel,
} from "../../ai/chat-model.server";

export {
  CHAT_MODEL as GENERAL_MODEL,
  CHAT_PROVIDER,
} from "../../ai/chat-model.server";
export const INTENT_ROUTING_TIMEOUT_MS = 10_000;
export const INTENT_ROUTING_MAX_OUTPUT_TOKENS = 256;

export function createQueryModel(streaming = false, maxOutputTokens?: number) {
  return createChatModel({
    model: GENERAL_MODEL,
    streaming,
    maxOutputTokens,
  });
}

export function createIntentRoutingModel() {
  return createQueryModel(false, INTENT_ROUTING_MAX_OUTPUT_TOKENS);
}

export function extractMessageText(message: unknown) {
  if (message instanceof AIMessage && typeof message.content === "string") {
    return message.content;
  }

  if (
    typeof message === "object" &&
    message !== null &&
    "content" in message
  ) {
    const content = (message as { content: unknown }).content;

    if (typeof content === "string") {
      return content;
    }

    if (Array.isArray(content)) {
      const text = content
        .map((part) => {
          if (typeof part === "string") {
            return part;
          }

          if (
            typeof part === "object" &&
            part !== null &&
            "text" in part &&
            typeof (part as { text: unknown }).text === "string"
          ) {
            return (part as { text: string }).text;
          }

          return "";
        })
        .filter((part) => part.length > 0)
        .join("\n");

      if (text.length > 0) {
        return text;
      }
    }
  }

  throw new Error("Query graph response model returned no text content");
}
