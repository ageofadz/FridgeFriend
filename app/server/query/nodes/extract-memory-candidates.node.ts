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
  return state.context.memoryExtractionCompleted !== true;
}

export function filterRecipeGoalCandidates(state: FridgeQueryStateValue) {
  if (state.intent !== "recipe") {
    return {};
  }

  return {
    memoryCandidates: state.memoryCandidates.filter((candidate) => candidate.kind !== "goal"),
  };
}

export function createExtractMemoryCandidatesNode(deps: QueryGraphDependencies) {
  return async function extractMemoryCandidatesNode(state: FridgeQueryStateValue) {
    const query = state.query.trim();
    const memoryContext = JSON.stringify({
      dietaryRestrictions: (state.dietaryRestrictions ?? []).map((restriction) => ({
        restrictionType: restriction.restrictionType,
        subject: restriction.subject,
        severity: restriction.severity,
        notes: restriction.notes,
      })),
      dietaryPreferences: (state.dietaryPreferences ?? []).map((preference) => ({
        subject: preference.subject,
        sentiment: preference.sentiment,
        strength: preference.strength,
        notes: preference.notes,
      })),
      activeGoals: (state.activeGoals ?? []).map((goal) => ({
        goalType: goal.goalType,
        description: goal.description,
        targetValue: goal.targetValue,
        targetUnit: goal.targetUnit,
        priority: goal.priority,
      })),
    });

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

    const messages = await promptMessages(loadedPrompt, {
      query,
      memory_context_json: memoryContext,
    });
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
          memoryExtractionCompleted: true,
          memoryExtractionError: `Memory extraction returned invalid output: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
        },
      };
    }

    const memoryCandidates = parsed.data.candidates.map((candidate) =>
      candidate.kind === "goal" && candidate.description.trim().length === 0
        ? { ...candidate, description: query }
        : candidate,
    );

    return {
      memoryCandidates,
      context: {
        ...state.context,
        memoryExtractionCompleted: true,
      },
    };
  };
}
