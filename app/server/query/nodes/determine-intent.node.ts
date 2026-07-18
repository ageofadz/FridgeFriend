import type { QueryGraphDependencies } from "../schemas/query";
import {
  IntentResponseSchema,
  IntentRoutingChoiceSchema,
  type IntentEmbeddingRoutingResult,
  type IntentRoutingChoice,
} from "../schemas/query";
import { promptMessages } from "../../scan/services/prompt-messages.server";
import { createQueryModel, CHAT_PROVIDER, GENERAL_MODEL } from "../services/query-model.server";
import { routeIntentCandidatesByEmbedding } from "../services/intent-embedding-router.server";
import type { FridgeQueryStateValue } from "../state";

function parseEmbeddingRoutingResult(result: Awaited<ReturnType<NonNullable<QueryGraphDependencies["intentEmbeddingRouter"]>>>): {
  data: IntentEmbeddingRoutingResult | null;
  error: string | null;
} {
  if (result === null) {
    return { data: null, error: null };
  }

  const parsedAcceptedOnly = IntentResponseSchema.safeParse(result);

  if (parsedAcceptedOnly.success) {
    return {
      data: { accepted: parsedAcceptedOnly.data, candidates: [] },
      error: null,
    };
  }

  if (
    typeof result === "object" &&
    result !== null &&
    "accepted" in result &&
    "candidates" in result &&
    Array.isArray(result.candidates)
  ) {
    const accepted = result.accepted === null
      ? null
      : IntentResponseSchema.safeParse(result.accepted);

    if (accepted !== null && !accepted.success) {
      return {
        data: null,
        error: `Intent embedding routing returned invalid output: ${accepted.error.issues.map((issue) => issue.message).join("; ")}`,
      };
    }

    const candidates = IntentRoutingChoiceSchema.array().safeParse(result.candidates);

    if (!candidates.success) {
      return {
        data: null,
        error: `Intent embedding routing returned invalid candidates: ${candidates.error.issues.map((issue) => issue.message).join("; ")}`,
      };
    }

    return {
      data: {
        accepted: accepted?.data ?? null,
        candidates: candidates.data,
      },
      error: null,
    };
  }

  return {
    data: null,
    error: `Intent embedding routing returned invalid output: ${parsedAcceptedOnly.error.issues.map((issue) => issue.message).join("; ")}`,
  };
}

function unresolvedIntentResult(input: {
  state: FridgeQueryStateValue;
  error: string;
}) {
  return {
    intent: "clarification" as const,
    context: {
      ...input.state.context,
      intentRoutingError: input.error,
    },
  };
}

function routingChoiceMessage(choice: IntentRoutingChoice) {
  return JSON.stringify({
    intent: choice.intent,
    score: choice.score,
    margin: choice.margin,
    example: choice.example.text,
  });
}

async function classifyUnresolvedIntent(input: {
  deps: QueryGraphDependencies;
  state: FridgeQueryStateValue;
  query: string;
  choices: IntentRoutingChoice[];
}) {
  const loadedPrompt = input.deps.promptBundle?.intentRouting;
  if (!loadedPrompt) {
    return unresolvedIntentResult({
      state: input.state,
      error: "Intent routing prompt is unavailable for an ambiguous request.",
    });
  }

  try {
    const model = input.deps.intentModel ?? createQueryModel();
    const structuredModel = model.withStructuredOutput(IntentResponseSchema, {
      name: "IntentResponse",
    });
    const messages = await promptMessages(loadedPrompt, {
      intent_routing_choice_1: input.choices[0] ? routingChoiceMessage(input.choices[0]) : "No candidate.",
      intent_routing_choice_2: input.choices[1] ? routingChoiceMessage(input.choices[1]) : "No candidate.",
      intent_routing_choice_3: input.choices[2] ? routingChoiceMessage(input.choices[2]) : "No candidate.",
      intent_routing_context_json: JSON.stringify({
        query: input.query,
        candidates: input.choices,
      }),
    });
    const result = await structuredModel.invoke(messages, {
      tags: ["query", "determine_intent"],
      metadata: {
        userId: input.state.userId,
        fridgeId: input.state.fridgeId,
        imageId: input.state.imageId,
        langsmithPromptName: loadedPrompt.name,
        langsmithPromptRef: loadedPrompt.ref,
        provider: CHAT_PROVIDER,
        model: GENERAL_MODEL,
      },
    });
    const parsed = IntentResponseSchema.safeParse(result);
    if (!parsed.success) {
      return unresolvedIntentResult({
        state: input.state,
        error: `Intent routing classification returned invalid output: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
      });
    }
    return {
      intent: parsed.data.intent,
      context: {
        ...input.state.context,
        intentRouting: {
          recipeContinuation: parsed.data.recipeContinuation,
          shoppingMode: parsed.data.shoppingMode,
          enrichment: parsed.data.enrichment,
        },
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return unresolvedIntentResult({
      state: input.state,
      error: `Intent routing classification failed: ${message}`,
    });
  }
}

export function createDetermineIntentNode(deps: QueryGraphDependencies) {
  return async function determineIntentNode(state: FridgeQueryStateValue) {
    const query = state.query.trim();

    if (query.length === 0) {
      return {
        intent: "clarification" as const,
      };
    }

    if (state.context.recipeContinuationRequested === true && state.recipeSearchSession) {
      return {
        intent: "recipe" as const,
        context: {
          ...state.context,
          intentRouting: {
            recipeContinuation: true,
            shoppingMode: "direct",
            enrichment: { itemNames: [], fields: [] },
          },
        },
      };
    }

    const embeddingRouter = deps.intentEmbeddingRouter ?? routeIntentCandidatesByEmbedding;
    const embeddingResult = parseEmbeddingRoutingResult(await embeddingRouter({ query }));

    if (embeddingResult.error) {
      return unresolvedIntentResult({ state, error: embeddingResult.error });
    }

    if (embeddingResult.data?.accepted) {
      return {
        intent: embeddingResult.data.accepted.intent,
        context: {
          ...state.context,
          intentRouting: {
            recipeContinuation: embeddingResult.data.accepted.recipeContinuation,
            shoppingMode: embeddingResult.data.accepted.shoppingMode,
            enrichment: embeddingResult.data.accepted.enrichment,
          },
        },
      };
    }

    const intentChoices = embeddingResult.data?.candidates ?? [];
    if (intentChoices.length === 0) {
      return unresolvedIntentResult({ state, error: "Intent routing returned no candidates" });
    }

    return classifyUnresolvedIntent({ deps, state, query, choices: intentChoices });
  };
}
