import type { BaseMessage } from "@langchain/core/messages";

import type { LoadedPrompt } from "../../prompts/registry.server";

type ChatPromptLike = {
  invoke(input: Record<string, string>): Promise<unknown> | unknown;
};

export async function promptMessages<TPrompt extends ChatPromptLike>(
  loadedPrompt: LoadedPrompt<TPrompt>,
  input: Record<string, string>,
) {
  const promptValue = await loadedPrompt.prompt.invoke(input);

  if (
    typeof promptValue !== "object" ||
    promptValue === null ||
    !("toChatMessages" in promptValue) ||
    typeof promptValue.toChatMessages !== "function"
  ) {
    throw new Error(`Prompt Hub prompt ${loadedPrompt.ref} must be a chat prompt`);
  }

  return promptValue.toChatMessages() as BaseMessage[];
}
