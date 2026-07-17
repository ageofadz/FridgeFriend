import {
  MemoryExtractionResultProviderSchema,
  MemoryExtractionResultSchema,
} from "../../memory/schemas";
import { VISION_MODEL } from "../../scan/schemas/inventory";
import { promptMessages } from "../../scan/services/prompt-messages.server";
import type { QueryGraphDependencies } from "../schemas/query";
import { createQueryModel } from "../services/query-model.server";
import type { FridgeQueryStateValue } from "../state";

const MEMORY_CUE_PATTERNS = [
  /\b(remember|save|note|keep track|don't forget)\b/iu,
  /\b(i|we)\s+(have|keep|store|stored|avoid|like|prefer|am allergic|am intolerant|cannot eat|can't eat)\b/iu,
  /\b(my|our)\s+(pantry|freezer|counter|cupboard|cabinet|allergy|allergies|dietary restriction|dietary preference|goal)\b/iu,
  /\b(pantry|freezer|counter|cupboard|cabinet)\b.*\b(has|have|contains|includes|add|added|remove|removed|out of|finished)\b/iu,
];

export function shouldExtractMemoryCandidates(query: string) {
  const normalized = query.trim();

  return normalized.length > 0 &&
    MEMORY_CUE_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function createExtractMemoryCandidatesNode(deps: QueryGraphDependencies) {
  return async function extractMemoryCandidatesNode(state: FridgeQueryStateValue) {
    const query = state.query.trim();

    if (!shouldExtractMemoryCandidates(query)) {
      return {
        memoryCandidates: [],
      };
    }

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
          model: VISION_MODEL,
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
