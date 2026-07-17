import { promptMessages } from "../../scan/services/prompt-messages.server";
import type { QueryGraphDependencies } from "../schemas/query";
import { createQueryModel } from "../services/query-model.server";
import type { FridgeQueryStateValue } from "../state";

const RecipeQueryRewriteProviderSchema = {
  type: "object",
  properties: { semanticQuery: { type: "string" } },
  required: ["semanticQuery"],
} as const;

export function createRewriteRecipeQueryNode(deps: QueryGraphDependencies = {}) {
  return async function rewriteRecipeQueryNode(state: FridgeQueryStateValue) {
    if (!state.recipeSearch) {
      return { recipeSearchError: "Recipe query rewrite could not run because the recipe search request is unavailable.", recipeRewriteCount: state.recipeRewriteCount + 1 };
    }
    const loadedPrompt = deps.promptBundle?.recipeQueryRewrite;
    if (!loadedPrompt) {
      return { recipeSearchError: "Recipe query rewrite prompt is unavailable.", recipeRewriteCount: state.recipeRewriteCount + 1 };
    }
    try {
      const model = deps.recipeQueryRewriteModel ?? createQueryModel();
      const structuredModel = model.withStructuredOutput(RecipeQueryRewriteProviderSchema, {
        name: "FridgeRecipeQueryRewrite",
      });
      const messages = await promptMessages(loadedPrompt, {
        recipe_rewrite_context_json: JSON.stringify({
          query: state.query,
          search: state.recipeSearch,
          grade: state.recipeRetrievalGrade,
        }),
      });
      const result = await structuredModel.invoke(messages);
      if (
        typeof result !== "object" || result === null ||
        !("semanticQuery" in result) || typeof result.semanticQuery !== "string" ||
        result.semanticQuery.trim().length === 0
      ) {
        return { recipeSearchError: "Recipe query rewrite returned an empty or invalid semantic query.", recipeRewriteCount: state.recipeRewriteCount + 1 };
      }
      return {
        recipeSearch: { ...state.recipeSearch, semanticQuery: result.semanticQuery.trim() },
        recipeRewriteCount: state.recipeRewriteCount + 1,
        recipeSearchError: null,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { recipeSearchError: `Recipe query rewrite failed: ${message}`, recipeRewriteCount: state.recipeRewriteCount + 1 };
    }
  };
}
