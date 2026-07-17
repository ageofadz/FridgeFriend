import { getWriter, type LangGraphRunnableConfig } from "@langchain/langgraph";

import { promptMessages } from "../../scan/services/prompt-messages.server";
import { normalizeIngredientName } from "../../recipes/normalization";
import { isUniversalBasicIngredient } from "../../recipes/pantry-basics";
import {
  GroceryAisleAssignmentProviderSchema,
  GroceryAisleAssignmentSchema,
  PantryCompletionPlanSchema,
  type GroceryAisle,
  type PantryCompletionPlan,
  type QueryGraphDependencies,
} from "../schemas/query";
import { isPantryCompletionRequest } from "../services/grocery-planner.server";
import { createQueryModel, CHAT_PROVIDER, GENERAL_MODEL } from "../services/query-model.server";
import type { RankedRecipe } from "../services/recipe-retrieval.server";
import type { FridgeQueryStateValue } from "../state";

type EligibleRecipe = RankedRecipe & { missingIngredients: string[] };

function candidateRecipes(state: FridgeQueryStateValue) {
  const retrieval = state.context.recipeRetrieval;
  if (typeof retrieval !== "object" || retrieval === null || !("recipes" in retrieval) || !Array.isArray(retrieval.recipes)) {
    return [];
  }

  return retrieval.recipes.filter((recipe): recipe is RankedRecipe =>
    typeof recipe === "object" && recipe !== null &&
    "id" in recipe && typeof recipe.id === "string" &&
    "name" in recipe && typeof recipe.name === "string" &&
    "missingIngredients" in recipe && Array.isArray(recipe.missingIngredients) &&
    recipe.missingIngredients.every((ingredient: unknown) => typeof ingredient === "string") &&
    "score" in recipe && typeof recipe.score === "number" && Number.isFinite(recipe.score),
  );
}

function eligibleRecipes(recipes: RankedRecipe[]): EligibleRecipe[] {
  return recipes.flatMap((recipe) => {
    const missingIngredients = [...new Set(recipe.missingIngredients
      .map(normalizeIngredientName)
      .filter((ingredient) => ingredient && !isUniversalBasicIngredient(ingredient)))];
    return missingIngredients.length >= 1 && missingIngredients.length <= 3
      ? [{ ...recipe, missingIngredients }]
      : [];
  });
}

function supportsIngredient(recipe: EligibleRecipe, ingredient: string) {
  return recipe.missingIngredients.includes(ingredient);
}

function isUnlocked(recipe: EligibleRecipe, ingredients: Set<string>) {
  return recipe.missingIngredients.every((ingredient) => ingredients.has(ingredient));
}

function ingredientCombinations(ingredients: string[], limit = 3) {
  const combinations: string[][] = [];

  function visit(start: number, selected: string[]) {
    if (selected.length > 0) {
      combinations.push([...selected]);
    }

    if (selected.length === limit) {
      return;
    }

    for (let index = start; index < ingredients.length; index += 1) {
      selected.push(ingredients[index]);
      visit(index + 1, selected);
      selected.pop();
    }
  }

  visit(0, []);
  return combinations;
}

function selectIngredients(recipes: EligibleRecipe[]) {
  const available = [...new Set(recipes.flatMap((recipe) => recipe.missingIngredients))].sort();
  const selections = ingredientCombinations(available).map((ingredients) => {
    const ingredientSet = new Set(ingredients);
    const unlocked = recipes.filter((recipe) => isUnlocked(recipe, ingredientSet));

    return {
      ingredients,
      unlocked,
      score: unlocked.reduce((total, recipe) => total + recipe.score, 0),
    };
  }).filter((selection) => selection.unlocked.length > 0);

  return selections.sort((left, right) =>
    right.unlocked.length - left.unlocked.length ||
    right.score - left.score ||
    left.ingredients.length - right.ingredients.length ||
    left.ingredients.join("\0").localeCompare(right.ingredients.join("\0")),
  )[0] ?? { ingredients: [], unlocked: [], score: 0 };
}

function validAssignments(assignments: Array<{ ingredient: string; aisle: GroceryAisle }>, ingredients: string[]) {
  const expected = new Set(ingredients);
  const received = new Set(assignments.map((assignment) => assignment.ingredient));
  return received.size === assignments.length &&
    received.size === expected.size &&
    [...received].every((ingredient) => expected.has(ingredient));
}

function planError(state: FridgeQueryStateValue, error: string) {
  return {
    context: {
      ...state.context,
      pantryCompletionPlan: null,
      pantryCompletionClarification: null,
      pantryCompletionError: error,
      pantryCompletionFailureReason: error,
    },
  };
}

function recordPantryCompletionFailure(
  config: LangGraphRunnableConfig | undefined,
  failureReason: string,
) {
  const metadata = { pantryCompletionFailureReason: failureReason };
  if (config?.metadata) {
    Object.assign(config.metadata, metadata);
  }
  const callbacks = config?.callbacks;
  if (!callbacks || Array.isArray(callbacks)) return;
  const callbackManager = callbacks as { addMetadata?: (value: Record<string, unknown>) => void };
  if (typeof callbackManager.addMetadata === "function") {
    callbackManager.addMetadata(metadata);
  }
}

function planClarification(
  state: FridgeQueryStateValue,
  message: string,
  failureReason: string,
  config?: LangGraphRunnableConfig,
) {
  recordPantryCompletionFailure(config, failureReason);
  return {
    context: {
      ...state.context,
      pantryCompletionPlan: null,
      pantryCompletionError: null,
      pantryCompletionClarification: message,
      pantryCompletionFailureReason: failureReason,
    },
  };
}

export function createPlanPantryCompletionNode(deps: QueryGraphDependencies = {}) {
  return async function planPantryCompletionNode(
    state: FridgeQueryStateValue,
    config?: LangGraphRunnableConfig,
  ) {
    if (!isPantryCompletionRequest(state)) return {};

    const candidates = candidateRecipes(state);
    const eligible = eligibleRecipes(candidates);
    if (eligible.length === 0) {
      return planClarification(
        state,
        "I could not find three relevant recipes that your current ingredients can complete with up to three additions. Try broadening the recipe category or adding more pantry items.",
        `No retrieved recipe had one to three non-basic missing ingredients among ${candidates.length} relevant candidates.`,
        config,
      );
    }

    const writer = config ? getWriter(config) : undefined;
    writer?.({ type: "pantry_completion_progress", stage: "analyzing_recipes" });
    const selection = selectIngredients(eligible);
    if (selection.ingredients.length === 0 || selection.unlocked.length === 0) {
      return planClarification(
        state,
        "I could not identify a shared bundle that unlocks three relevant recipes. Try broadening the recipe category or adding more pantry items.",
        `No pantry bundle was selected from ${eligible.length} structurally eligible recipes.`,
        config,
      );
    }
    if (selection.unlocked.length < 3) {
      return planClarification(
        state,
        "I found fewer than three relevant recipes for one pantry bundle. Try broadening the recipe category or adding more pantry items.",
        `The best pantry bundle unlocked ${selection.unlocked.length} of ${eligible.length} structurally eligible recipes.`,
        config,
      );
    }

    const loadedPrompt = deps.promptBundle?.groceryAisleAssignment;
    if (!loadedPrompt) {
      return planError(state, "Smart Pantry Completion aisle assignment prompt is unavailable.");
    }

    writer?.({ type: "pantry_completion_progress", stage: "assigning_aisles" });
    try {
      const model = deps.groceryAisleAssignmentModel ?? createQueryModel();
      const structuredModel = model.withStructuredOutput(
        GroceryAisleAssignmentProviderSchema,
        { name: "FridgePantryCompletionAisleAssignment" },
      );
      const messages = await promptMessages(loadedPrompt, {
        grocery_aisle_assignment_context_json: JSON.stringify({ ingredients: selection.ingredients }),
      });
      const result = await structuredModel.invoke(messages, {
        tags: ["query", "plan_pantry_completion", "assign_aisles"],
        metadata: {
          fridgeId: state.fridgeId,
          imageId: state.imageId,
          langsmithPromptName: loadedPrompt.name,
          langsmithPromptRef: loadedPrompt.ref,
          provider: CHAT_PROVIDER,
          model: GENERAL_MODEL,
        },
      });
      const parsed = GroceryAisleAssignmentSchema.safeParse(result);
      if (!parsed.success || !validAssignments(parsed.success ? parsed.data.assignments : [], selection.ingredients)) {
        return planError(state, "Smart Pantry Completion aisle assignment did not cover every suggested ingredient exactly once.");
      }

      const aisleByIngredient = new Map(parsed.data.assignments.map((assignment) => [assignment.ingredient, assignment.aisle]));
      const plan: PantryCompletionPlan = PantryCompletionPlanSchema.parse({
        eligibleRecipeCount: candidates.length,
        unlockedRecipeCount: selection.unlocked.length,
        unlockedRecipes: selection.unlocked.map((recipe) => ({
          id: recipe.id,
          name: recipe.name,
          suggestedIngredients: recipe.missingIngredients.filter((ingredient) => selection.ingredients.includes(ingredient)),
        })),
        suggestions: selection.ingredients.map((ingredient) => {
          const supporting = selection.unlocked.filter((recipe) => supportsIngredient(recipe, ingredient));
          return {
            ingredient,
            aisle: aisleByIngredient.get(ingredient),
            recipeIds: supporting.map((recipe) => recipe.id),
            recipeNames: supporting.map((recipe) => recipe.name),
            supportingRecipeCount: supporting.length,
          };
        }),
      });
      return {
        context: {
          ...state.context,
          pantryCompletionPlan: plan,
          pantryCompletionClarification: null,
          pantryCompletionError: null,
          pantryCompletionFailureReason: null,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return planError(state, `Smart Pantry Completion failed: ${message}`);
    }
  };
}
