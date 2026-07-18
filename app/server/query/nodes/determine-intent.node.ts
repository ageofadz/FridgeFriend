import type { QueryGraphDependencies } from "../schemas/query";
import {
  IntentResponseSchema,
  IntentRoutingChoiceSchema,
  type IntentEmbeddingRoutingResult,
  type IntentRoutingChoice,
  type QueryIntent,
} from "../schemas/query";
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

function intentRoutingFromChoice(choice: IntentRoutingChoice) {
  return {
    recipeContinuation: choice.example.recipeContinuation ?? false,
    shoppingMode: choice.example.shoppingMode ?? "direct",
    enrichment: choice.example.enrichment ?? { itemNames: [], fields: [] },
  };
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
      return {
        intent: "clarification" as const,
        context: {
          ...state.context,
          intentRoutingError: embeddingResult.error,
        },
      };
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
    const bestIntentChoice = intentChoices[0];

    if (bestIntentChoice) {
      return {
        intent: bestIntentChoice.intent,
        context: {
          ...state.context,
          intentRouting: intentRoutingFromChoice(bestIntentChoice),
        },
      };
    }

    if (intentChoices.length === 0) {
      return {
        intent: "clarification" as const,
        context: {
          ...state.context,
          intentRoutingError: "Intent routing returned no candidates",
        },
      };
    }

    return {
      intent: "clarification" as const,
      context: {
        ...state.context,
        intentRoutingError: "Intent routing did not select a candidate",
      },
    };
  };
}
