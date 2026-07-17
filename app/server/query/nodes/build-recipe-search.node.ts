import { listFoodComTags } from "../../recipes/repository.server";
import { normalizeIngredientName } from "../../recipes/normalization";
import { promptMessages } from "../../scan/services/prompt-messages.server";
import {
  RecipeSearchInterpretationSchema,
  RecipeSearchRequestProviderSchema,
  type RecipeSearchRequest,
  type QueryGraphDependencies,
} from "../schemas/query";
import {
  foodComGoalTags,
  resolveFoodComTags,
} from "../services/recipe-tag-resolution.server";
import {
  buildRecipeSearchPlan,
  compileRecipeSearch,
  validateRecipeSearchInterpretation,
} from "../services/recipe-search-plan.server";
import { createQueryModel, CHAT_PROVIDER, GENERAL_MODEL } from "../services/query-model.server";
import type { FridgeQueryStateValue } from "../state";
import { availableRecipeIngredients } from "../services/available-recipe-ingredients.server";
import type { AvailableRecipeIngredient } from "../services/recipe-retrieval.server";

function isGenericFridgeRecipeRequest(query: string) {
  return /\b(recipe|recipes|meal|meals|cook|make)\b/iu.test(query) &&
    /\b(fridge|items?|ingredients?)\b/iu.test(query);
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

function hasExplicitRequirement(query: string) {
  return /\b(must|only|strictly|required|require)\b/iu.test(query);
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

function buildSearch(input: {
  availableIngredients: AvailableRecipeIngredient[];
  facets: RecipeSearchRequest["plan"]["userFacets"];
  userTags: string[];
  memory: ReturnType<typeof memoryTagProfile>;
  specific: boolean;
  useAvailableIngredients: boolean;
  excludedIngredients: string[];
  dietaryRestrictions: string[];
  maxMinutes: number | null;
  maxCalories: number | null;
  minProteinDailyValue: number | null;
  preferredIngredients: string[];
  requiredTags: string[];
  preferredTags: string[];
  excludedTags: string[];
}): RecipeSearchRequest {
  const plan = buildRecipeSearchPlan({
    facets: input.facets,
    userTags: input.userTags,
    memoryTags: [...input.memory.preferred, ...input.memory.goals],
    availableIngredients: input.availableIngredients,
  });
  const compiled = compileRecipeSearch({ plan, specific: input.specific });

  return {
    ...compiled,
    plan,
    useAvailableIngredients: input.useAvailableIngredients,
    excludedIngredients: input.excludedIngredients,
    dietaryRestrictions: input.dietaryRestrictions,
    maxMinutes: input.maxMinutes,
    maxCalories: input.maxCalories,
    minProteinDailyValue: input.minProteinDailyValue,
    preferredIngredients: input.preferredIngredients,
    requiredTags: input.requiredTags,
    preferredTags: input.preferredTags,
    excludedTags: input.excludedTags,
    memoryPreferredTags: input.memory.preferred,
    memoryExcludedTags: input.memory.excluded,
    memoryGoalTags: input.memory.goals,
    continuation: false,
  };
}

function searchStateError(message: string) {
  return {
    recipeSearch: null,
    recipeSearchError: message,
    recipeClarification: "I couldn't safely interpret that recipe request. Please restate the dish or constraint you want me to use.",
  };
}

export function createBuildRecipeSearchNode(deps: QueryGraphDependencies) {
  return async function buildRecipeSearchNode(state: FridgeQueryStateValue) {
    const availableIngredients = await availableRecipeIngredients(state, deps);
    const ingredients = availableIngredients.map((ingredient) => ingredient.name);

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
    const inventoryFirstSearch = state.intent === "expiry" ||
      state.intent === "recipe" && isGenericFridgeRecipeRequest(state.query);

    if (inventoryFirstSearch && availableIngredients.length > 0) {
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
        recipeSearch: buildSearch({
          availableIngredients,
          facets: [],
          userTags: promptTags,
          memory,
          specific: false,
          useAvailableIngredients: true,
          excludedIngredients: [],
          dietaryRestrictions: [],
          maxMinutes: null,
          maxCalories: null,
          minProteinDailyValue: null,
          preferredIngredients: [],
          requiredTags: [],
          preferredTags: promptTags,
          excludedTags: [],
        }),
        recipeSearchSession: null,
        shownRecipeIds: [],
        recipeSearchError: null,
        recipeClarification: null,
      };
    }

    const model = deps.recipeSearchModel ?? createQueryModel();
    const structuredModel = model.withStructuredOutput(RecipeSearchRequestProviderSchema, {
      name: "FridgeRecipeSearchInterpretation",
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
          provider: CHAT_PROVIDER,
          model: GENERAL_MODEL,
        },
      },
    );
    const parsed = RecipeSearchInterpretationSchema.safeParse(result);

    if (!parsed.success) {
      return searchStateError(
        `Recipe search interpretation returned invalid output: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
      );
    }

    const interpretationError = validateRecipeSearchInterpretation({
      query: state.query,
      interpretation: parsed.data,
    });
    if (interpretationError) {
      return searchStateError(interpretationError);
    }

    const interpretedTags = resolveFoodComTags([
      ...parsed.data.requiredTags,
      ...parsed.data.preferredTags,
    ], catalog);
    const dietaryTags = resolveFoodComTags(parsed.data.dietaryRestrictions, catalog);
    const excludedTags = resolveFoodComTags(parsed.data.excludedTags, catalog);
    const directTags = [...new Set([...promptTags, ...interpretedTags])].sort();
    const requiredTags = [...new Set([
      ...dietaryTags,
      ...(hasExplicitRequirement(state.query) ? directTags : []),
    ])].filter((tag) => !excludedTags.includes(tag)).sort();
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
      recipeSearch: buildSearch({
        availableIngredients,
        facets: parsed.data.facets,
        userTags: directTags,
        memory,
        specific: parsed.data.intent.specific,
        useAvailableIngredients: parsed.data.useAvailableIngredients,
        excludedIngredients: parsed.data.excludedIngredients.map(normalizeIngredientName).filter(Boolean),
        dietaryRestrictions: parsed.data.dietaryRestrictions,
        maxMinutes: parsed.data.maxMinutes,
        maxCalories: parsed.data.maxCalories,
        minProteinDailyValue: parsed.data.minProteinDailyValue,
        preferredIngredients: parsed.data.preferredIngredients.map(normalizeIngredientName).filter(Boolean),
        requiredTags,
        preferredTags: directTags,
        excludedTags,
      }),
      recipeSearchSession: null,
      shownRecipeIds: [],
      recipeSearchError: null,
      recipeClarification: null,
    };
  };
}
