import {
  MemoryExtractionResultProviderSchema,
  MemoryExtractionResultSchema,
} from "../../memory/schemas";
import { promptMessages } from "../../scan/services/prompt-messages.server";
import type { QueryGraphDependencies } from "../schemas/query";
import {
  createQueryModel,
  CHAT_PROVIDER,
  GENERAL_MODEL,
} from "../services/query-model.server";
import type { FridgeQueryStateValue } from "../state";

export function shouldExtractMemoryCandidates(state: FridgeQueryStateValue) {
  const intentRouting = state.context.intentRouting;

  return typeof intentRouting === "object" &&
    intentRouting !== null &&
    "memoryUpdateRequested" in intentRouting &&
    intentRouting.memoryUpdateRequested === true;
}

export function createExtractMemoryCandidatesNode(deps: QueryGraphDependencies) {
  return async function extractMemoryCandidatesNode(state: FridgeQueryStateValue) {
    const query = state.query.trim();

    const model = deps.memoryExtractionModel ?? createQueryModel();
    const structuredModel = model.withStructuredOutput(
      MemoryExtractionResultProviderSchema,
      {
        name: "FridgeFriendMemoryExtraction",
      },
    );
    const loadedPrompt = deps.promptBundle?.queryMemoryExtraction;

    if (!loadedPrompt) {
      throw new Error("Missing query memory extraction prompt in query graph dependencies");
    }

    const messages = await promptMessages(loadedPrompt, { query });
    const result = await structuredModel.invoke(
      messages,
      {
        tags: ["query", "extract_memory_candidates"],
        metadata: {
          userId: state.userId,
          fridgeId: state.fridgeId,
          imageId: state.imageId,
          langsmithPromptName: loadedPrompt.name,
          langsmithPromptRef: loadedPrompt.ref,
          provider: CHAT_PROVIDER,
          model: GENERAL_MODEL,
        },
      },
    );
    const parsed = MemoryExtractionResultSchema.safeParse(result);

    if (!parsed.success) {
      return {
        memoryCandidates: [],
        context: {
          ...state.context,
          memoryExtractionError: `Memory extraction returned invalid output: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
        },
      };
    }

    return {
      memoryCandidates: parsed.data.candidates,
    };
  };
}
