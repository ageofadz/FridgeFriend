import { AIMessage } from "@langchain/core/messages";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";

import { requiredEnv } from "../../env.server";
import { VISION_MODEL } from "../../scan/schemas/inventory";

export function createQueryModel() {
  return new ChatGoogleGenerativeAI({
    model: VISION_MODEL,
    temperature: 0,
    maxRetries: 0,
    apiKey: requiredEnv("GOOGLE_API_KEY"),
    streaming: true,
  });
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
