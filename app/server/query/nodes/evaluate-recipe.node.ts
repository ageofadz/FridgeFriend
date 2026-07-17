import { promptMessages } from "../../scan/services/prompt-messages.server";
import type { QueryGraphDependencies } from "../schemas/query";
import { createQueryModel } from "../services/query-model.server";
import type { RecipeTournamentEvaluation } from "../services/recipe-tournament.server";
import type { FridgeQueryStateValue } from "../state";

const RecipeTournamentEvaluationProviderSchema = {
  type: "object",
  properties: {
    nutrition: { type: "number" },
    ingredientCoverage: { type: "number" },
    difficulty: { type: "number" },
    wasteReduction: { type: "number" },
    preferenceMatch: { type: "number" },
  },
  required: ["nutrition", "ingredientCoverage", "difficulty", "wasteReduction", "preferenceMatch"],
} as const;

function validScore(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 10;
}

export function createEvaluateRecipeNode(deps: QueryGraphDependencies = {}) {
  return async function evaluateRecipeNode(state: FridgeQueryStateValue) {
    const candidate = state.tournamentCandidate;
    if (!candidate) {
      return { tournamentEvaluations: [{ recipeId: "unknown", scores: null, error: "Recipe tournament worker received no candidate." }] satisfies RecipeTournamentEvaluation[] };
    }
    const loadedPrompt = deps.promptBundle?.recipeTournamentEvaluation;
    if (!loadedPrompt) {
      return { tournamentEvaluations: [{ recipeId: candidate.id, scores: null, error: "Recipe tournament evaluation prompt is unavailable." }] };
    }
    try {
      const model = deps.recipeTournamentModel ?? createQueryModel();
      const structuredModel = model.withStructuredOutput(RecipeTournamentEvaluationProviderSchema, {
        name: "FridgeRecipeTournamentEvaluation",
      });
      const messages = await promptMessages(loadedPrompt, {
        recipe_tournament_context_json: JSON.stringify({
          query: state.query,
          search: state.recipeSearch,
          dietaryRestrictions: state.dietaryRestrictions,
          dietaryPreferences: state.dietaryPreferences,
          activeGoals: state.activeGoals,
          recipe: candidate,
          expiryPlan: state.context.expiryPlan ?? null,
        }),
      });
      const result = await structuredModel.invoke(messages);
      if (
        typeof result !== "object" || result === null ||
        !validScore(result.nutrition) || !validScore(result.ingredientCoverage) ||
        !validScore(result.difficulty) || !validScore(result.wasteReduction) ||
        !validScore(result.preferenceMatch)
      ) {
        return { tournamentEvaluations: [{ recipeId: candidate.id, scores: null, error: "Recipe tournament evaluation returned invalid scores." }] };
      }
      return {
        tournamentEvaluations: [{
          recipeId: candidate.id,
          scores: {
            nutrition: result.nutrition,
            ingredientCoverage: result.ingredientCoverage,
            difficulty: result.difficulty,
            wasteReduction: result.wasteReduction,
            preferenceMatch: result.preferenceMatch,
          },
          error: null,
        }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { tournamentEvaluations: [{ recipeId: candidate.id, scores: null, error: `Recipe tournament evaluation failed: ${message}` }] };
    }
  };
}
