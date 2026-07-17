import { promptMessages } from "../../scan/services/prompt-messages.server";
import type { QueryGraphDependencies, RecipeRetrievalGrade } from "../schemas/query";
import { createQueryModel } from "../services/query-model.server";
import type { FridgeQueryStateValue } from "../state";

const RecipeRetrievalGradeProviderSchema = {
  type: "object",
  properties: {
    relevant: { type: "boolean" },
    reason: { type: "string" },
  },
  required: ["relevant", "reason"],
} as const;

function failedGrade(reason: string): RecipeRetrievalGrade {
  return { relevant: false, reason };
}

export function createGradeRecipeRetrievalNode(deps: QueryGraphDependencies = {}) {
  return async function gradeRecipeRetrievalNode(state: FridgeQueryStateValue) {
    if (state.tournamentCandidates.length === 0) {
      return irrelevantResult(state, failedGrade("The local Food.com index returned no eligible recipes."));
    }

    const loadedPrompt = deps.promptBundle?.recipeRetrievalGrade;
    if (!loadedPrompt) {
      return irrelevantResult(state, failedGrade("Recipe retrieval grading prompt is unavailable."));
    }

    try {
      const model = deps.recipeRetrievalGradeModel ?? createQueryModel();
      const structuredModel = model.withStructuredOutput(RecipeRetrievalGradeProviderSchema, {
        name: "FridgeRecipeRetrievalGrade",
      });
      const messages = await promptMessages(loadedPrompt, {
        recipe_retrieval_context_json: JSON.stringify({
          query: state.query,
          semanticQuery: state.recipeSearch?.semanticQuery ?? null,
          recipes: state.tournamentCandidates.map((recipe) => ({
            id: recipe.id,
            name: recipe.name,
            description: recipe.description,
            ingredients: recipe.ingredients,
            tags: recipe.matchedTags,
            minutes: recipe.minutes,
          })),
        }),
      });
      const result = await structuredModel.invoke(messages);
      if (
        typeof result !== "object" || result === null ||
        !("relevant" in result) || typeof result.relevant !== "boolean" ||
        !("reason" in result) || typeof result.reason !== "string"
      ) {
        return irrelevantResult(state, failedGrade("Recipe retrieval grading returned invalid output."));
      }
      return irrelevantResult(state, { relevant: result.relevant, reason: result.reason });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return irrelevantResult(state, failedGrade(`Recipe retrieval grading failed: ${message}`));
    }
  };
}

function irrelevantResult(state: FridgeQueryStateValue, grade: RecipeRetrievalGrade) {
  if (grade.relevant || state.recipeRewriteCount < 1) {
    return { recipeRetrievalGrade: grade };
  }
  const current = state.context.recipeRetrieval;
  const retrieval = current && typeof current === "object" ? current as Record<string, unknown> : {};
  return {
    recipeRetrievalGrade: grade,
    context: {
      ...state.context,
      recipeRetrieval: {
        ...retrieval,
        recipes: [],
        noMatches: true,
        exhausted: true,
        reason: `Recipe retrieval remained irrelevant after one query rewrite: ${grade.reason}`,
      },
    },
  };
}
