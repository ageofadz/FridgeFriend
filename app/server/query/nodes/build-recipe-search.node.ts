import { listFoodComTags } from "../../recipes/repository.server";
import { normalizeIngredientName } from "../../recipes/normalization";
import { VISION_MODEL } from "../../scan/schemas/inventory";
import { promptMessages } from "../../scan/services/prompt-messages.server";
import {
  RecipeSearchRequestProviderSchema,
  RecipeSearchRequestSchema,
  type QueryGraphDependencies,
} from "../schemas/query";
import {
  foodComGoalTags,
  resolveFoodComTags,
} from "../services/recipe-tag-resolution.server";
import { createQueryModel } from "../services/query-model.server";
import type { FridgeQueryStateValue } from "../state";
import { availableRecipeIngredients } from "../services/available-recipe-ingredients.server";

function isGenericFridgeRecipeRequest(query: string) {
  return /\b(recipe|recipes|meal|meals|cook|make)\b.*\b(fridge|items?|ingredients?)\b/iu.test(query);
}

function isRecipeContinuation(state: FridgeQueryStateValue) {
  const routing = state.context.intentRouting;

  return (
    typeof routing === "object" &&
    routing !== null &&
    "recipeContinuation" in routing &&
    routing.recipeContinuation === true
  );
}

export function recipeInventoryFingerprint(ingredients: string[]) {
  return [...new Set(ingredients.map(normalizeIngredientName).filter(Boolean))].sort().join("|");
}

function memoryTagProfile(state: FridgeQueryStateValue, catalog: string[]) {
  const preferred = state.dietaryPreferences
    .filter((preference) => preference.sentiment === "like" || preference.sentiment === "prefer")
    .flatMap((preference) => resolveFoodComTags([preference.subject], catalog));
  const excluded = state.dietaryPreferences
    .filter((preference) => preference.sentiment === "dislike" || preference.sentiment === "avoid")
    .flatMap((preference) => resolveFoodComTags([preference.subject], catalog));
  const goals = state.activeGoals.flatMap((goal) => foodComGoalTags(goal.goalType, catalog));

  return {
    preferred: [...new Set(preferred)].sort(),
    excluded: [...new Set(excluded)].sort(),
    goals: [...new Set(goals)].sort(),
  };
}

function conflictMessage(input: {
  promptTags: string[];
  promptExcludedTags: string[];
  memoryExcludedTags: string[];
  memoryGoalTags: string[];
}) {
  const disliked = input.promptTags.filter((tag) => input.memoryExcludedTags.includes(tag));
  const rejectedGoals = input.promptExcludedTags.filter((tag) => input.memoryGoalTags.includes(tag));
  const conflicts = [...new Set([...disliked, ...rejectedGoals])];

  return conflicts.length > 0
    ? `Your request conflicts with saved preferences or goals for ${conflicts.join(", ")}. Should I follow this request or your saved preferences?`
    : null;
}

export function createBuildRecipeSearchNode(deps: QueryGraphDependencies) {
  return async function buildRecipeSearchNode(state: FridgeQueryStateValue) {
    const ingredients = (await availableRecipeIngredients(state, deps)).map((ingredient) => ingredient.name);

    if (isRecipeContinuation(state) && state.recipeSearchSession) {
      if (state.recipeSearchSession.inventoryFingerprint !== recipeInventoryFingerprint(ingredients)) {
        return {
          recipeSearch: null,
          recipeSearchError: "Recipe continuation cannot reuse a search after the available inventory changed.",
          recipeClarification: null,
        };
      }

      return {
        recipeSearch: { ...state.recipeSearchSession.profile, continuation: true },
        shownRecipeIds: state.recipeSearchSession.shownRecipeIds,
        recipeSearchError: null,
        recipeClarification: null,
      };
    }

    const catalog = await (deps.listFoodComTags ?? listFoodComTags)();
    const memory = memoryTagProfile(state, catalog);
    const promptTags = resolveFoodComTags([state.query], catalog);

    if ((state.intent === "expiry" || isGenericFridgeRecipeRequest(state.query)) && ingredients.length > 0) {
      const clarification = conflictMessage({
        promptTags,
        promptExcludedTags: [],
        memoryExcludedTags: memory.excluded,
        memoryGoalTags: memory.goals,
      });
      if (clarification) {
        return { recipeSearch: null, recipeSearchError: null, recipeClarification: clarification };
      }

      return {
        recipeSearch: {
          semanticQuery: state.intent === "expiry"
            ? `${state.query}\nAvailable ingredients: ${ingredients.join(", ")}\nPrioritize recipes that use the most urgent available ingredients.`
            : `${state.query}\nAvailable ingredients: ${ingredients.join(", ")}`,
          useAvailableIngredients: true,
          excludedIngredients: [],
          dietaryRestrictions: [],
          maxMinutes: null,
          maxCalories: null,
          minProteinDailyValue: null,
          preferredIngredients: ingredients,
          requiredTags: [],
          preferredTags: promptTags,
          excludedTags: [],
          memoryPreferredTags: memory.preferred,
          memoryExcludedTags: memory.excluded,
          memoryGoalTags: memory.goals,
          continuation: false,
        },
        recipeSearchSession: null,
        shownRecipeIds: [],
        recipeSearchError: null,
        recipeClarification: null,
      };
    }

    const model = deps.recipeSearchModel ?? createQueryModel();
    const structuredModel = model.withStructuredOutput(RecipeSearchRequestProviderSchema, {
      name: "FridgeRecipeSearchRequest",
    });
    const loadedPrompt = deps.promptBundle?.queryRecipeSearch;

    if (!loadedPrompt) {
      throw new Error("Missing query recipe search prompt in query graph dependencies");
    }

    const messages = await promptMessages(loadedPrompt, { query: state.query });
    const result = await structuredModel.invoke(
      messages,
      {
        tags: ["query", "build_recipe_search"],
        metadata: {
          fridgeId: state.fridgeId,
          imageId: state.imageId,
          langsmithPromptName: loadedPrompt.name,
          langsmithPromptRef: loadedPrompt.ref,
          model: VISION_MODEL,
        },
      },
    );
    const parsed = RecipeSearchRequestSchema.safeParse(result);

    if (!parsed.success) {
      return {
        recipeSearch: null,
        recipeSearchError: `Recipe search extraction returned invalid output: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
        recipeClarification: null,
      };
    }

    const directTags = [...new Set([
      ...promptTags,
      ...resolveFoodComTags([...parsed.data.requiredTags, ...parsed.data.preferredTags], catalog),
    ])].sort();
    const excludedTags = resolveFoodComTags(parsed.data.excludedTags, catalog);
    const clarification = conflictMessage({
      promptTags: directTags,
      promptExcludedTags: excludedTags,
      memoryExcludedTags: memory.excluded,
      memoryGoalTags: memory.goals,
    });
    if (clarification) {
      return { recipeSearch: null, recipeSearchError: null, recipeClarification: clarification };
    }

    return {
      recipeSearch: {
        ...parsed.data,
        useAvailableIngredients: parsed.data.useAvailableIngredients ||
          ingredients.length > 0 && isGenericFridgeRecipeRequest(state.query),
        requiredTags: resolveFoodComTags(parsed.data.requiredTags, catalog),
        preferredTags: directTags,
        excludedTags,
        memoryPreferredTags: memory.preferred,
        memoryExcludedTags: memory.excluded,
        memoryGoalTags: memory.goals,
        continuation: false,
      },
      recipeSearchSession: null,
      shownRecipeIds: [],
      recipeSearchError: null,
      recipeClarification: null,
    };
  };
}
