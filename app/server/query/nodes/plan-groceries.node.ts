import { getWriter, type LangGraphRunnableConfig } from "@langchain/langgraph";

import { promptMessages } from "../../scan/services/prompt-messages.server";
import { getRecipesByIds } from "../../recipes/repository.server";
import { normalizeIngredientName } from "../../recipes/normalization";
import type { Recipe } from "../../recipes/types";
import {
  GroceryAisleAssignmentProviderSchema,
  GroceryAisleAssignmentSchema,
  GroceryPlanSchema,
  GroceryRecipeSelectionProviderSchema,
  GroceryRecipeSelectionSchema,
  type GroceryPlan,
  type GroceryPlanItem,
  type QueryGraphDependencies,
  type RecipeCard,
} from "../schemas/query";
import {
  availableRecipeIngredients,
} from "../services/available-recipe-ingredients.server";
import { isGroceryPlannerRequest } from "../services/grocery-planner.server";
import { loadInventoryContext } from "../services/inventory-context.server";
import {
  recipeIngredientIsAvailable,
  type RankedRecipe,
} from "../services/recipe-retrieval.server";
import { createQueryModel, CHAT_PROVIDER, GENERAL_MODEL } from "../services/query-model.server";
import {
  ingredientNamesAreSimilar,
  preferredIngredientName,
} from "../services/ingredient-string-match.server";
import type { FridgeQueryStateValue } from "../state";

function asRankedRecipes(value: unknown): RankedRecipe[] {
  if (!Array.isArray(value)) return [];

  return value.filter((recipe): recipe is RankedRecipe =>
    typeof recipe === "object" &&
    recipe !== null &&
    "id" in recipe && typeof recipe.id === "string" &&
    "name" in recipe && typeof recipe.name === "string" &&
    "ingredients" in recipe && Array.isArray(recipe.ingredients) &&
    recipe.ingredients.every((ingredient: unknown) => typeof ingredient === "string") &&
    "matchedIngredients" in recipe && Array.isArray(recipe.matchedIngredients) &&
    "missingIngredients" in recipe && Array.isArray(recipe.missingIngredients) &&
    "minutes" in recipe && typeof recipe.minutes === "number",
  );
}

function candidateRecipes(state: FridgeQueryStateValue) {
  const retrieval = state.context.recipeRetrieval;
  if (typeof retrieval !== "object" || retrieval === null || !("recipes" in retrieval)) {
    return [];
  }

  return asRankedRecipes(retrieval.recipes);
}

function recipeCard(recipe: RankedRecipe): RecipeCard {
  return {
    id: recipe.id,
    name: recipe.name,
    description: recipe.description,
    minutes: recipe.minutes,
    matchedIngredients: recipe.matchedIngredients,
    missingIngredients: recipe.missingIngredients,
    matchedTags: recipe.matchedTags,
    matchBadges: recipe.matchBadges,
    usesSoonIngredients: recipe.usesSoonIngredients,
  };
}

function selectionError(state: FridgeQueryStateValue, error: string) {
  return { context: { ...state.context, groceryPlanError: error, groceryPlan: null } };
}

function validSelection(recipeIds: string[], candidates: RankedRecipe[]) {
  const allowed = new Set(candidates.map((candidate) => candidate.id));
  return new Set(recipeIds).size === recipeIds.length &&
    recipeIds.every((recipeId) => allowed.has(recipeId));
}

function fullnessEvidence(inventory: Awaited<ReturnType<typeof loadInventoryContext>> | null) {
  if (!inventory) {
    return { scannedItemCount: 0, zones: [] };
  }

  return {
    scannedItemCount: inventory.items.length,
    zones: inventory.zones.flatMap((zone) =>
      zone.estimatedCapacityRatio === null && zone.estimatedOccupiedRatio === null
        ? []
        : [{
          id: zone.id,
          label: zone.label,
          estimatedCapacityRatio: zone.estimatedCapacityRatio,
          estimatedOccupiedRatio: zone.estimatedOccupiedRatio,
        }]
    ),
  };
}

function missingItems(input: {
  recipes: Recipe[];
  availableIngredients: Awaited<ReturnType<typeof availableRecipeIngredients>>;
}) {
  const items = new Map<string, { ingredient: string; recipeIds: string[]; recipeNames: string[] }>();

  for (const recipe of input.recipes) {
    for (const ingredient of recipe.ingredients) {
      const canonical = normalizeIngredientName(ingredient.canonicalName);
      if (!canonical || recipeIngredientIsAvailable(canonical, input.availableIngredients)) continue;

      const matchingKey = [...items.keys()].find((key) =>
        ingredientNamesAreSimilar(key, canonical, { allowUniversalBasicOverlap: true })
      );
      const key = matchingKey ?? canonical;
      const ingredientName = matchingKey ? preferredIngredientName(key, canonical) : canonical;
      const current = items.get(key) ?? {
        ingredient: ingredientName,
        recipeIds: [],
        recipeNames: [],
      };
      if (!current.recipeIds.includes(recipe.id)) current.recipeIds.push(recipe.id);
      if (!current.recipeNames.includes(recipe.name)) current.recipeNames.push(recipe.name);
      if (ingredientName !== key) {
        items.delete(key);
      }
      current.ingredient = ingredientName;
      items.set(ingredientName, current);
    }
  }

  return [...items.values()].sort((left, right) => left.ingredient.localeCompare(right.ingredient));
}

function validAssignments(input: {
  assignments: Array<{ ingredient: string; aisle: GroceryPlanItem["aisle"] }>;
  ingredients: string[];
}) {
  const expected = new Set(input.ingredients);
  const received = new Set(input.assignments.map((assignment) => assignment.ingredient));
  return received.size === input.assignments.length &&
    received.size === expected.size &&
    [...received].every((ingredient) => expected.has(ingredient));
}

export function createPlanGroceriesNode(deps: QueryGraphDependencies = {}) {
  return async function planGroceriesNode(
    state: FridgeQueryStateValue,
    config?: LangGraphRunnableConfig,
  ) {
    if (!isGroceryPlannerRequest(state)) return {};

    const candidates = candidateRecipes(state);
    if (candidates.length < 3) {
      return selectionError(state, `Grocery Planner needs at least three eligible recipe candidates; retrieval returned ${candidates.length}.`);
    }

    const loadedSelectionPrompt = deps.promptBundle?.groceryRecipeSelection;
    if (!loadedSelectionPrompt) {
      return selectionError(state, "Grocery Planner recipe selection prompt is unavailable.");
    }

    const writer = config ? getWriter(config) : undefined;
    writer?.({ type: "grocery_plan_progress", stage: "selecting_recipes" });

    try {
      const inventory = await loadInventoryContext(state, deps);
      const selectionModel = deps.groceryRecipeSelectionModel ?? createQueryModel();
      const structuredSelectionModel = selectionModel.withStructuredOutput(
        GroceryRecipeSelectionProviderSchema,
        { name: "FridgeGroceryRecipeSelection" },
      );
      const selectionMessages = await promptMessages(loadedSelectionPrompt, {
        grocery_recipe_selection_context_json: JSON.stringify({
          query: state.query,
          inventoryFullnessEvidence: fullnessEvidence(inventory),
          externalInventory: state.externalInventory,
          dietaryRestrictions: state.dietaryRestrictions,
          dietaryPreferences: state.dietaryPreferences,
          activeGoals: state.activeGoals,
          candidates: candidates.map((recipe) => ({
            id: recipe.id,
            name: recipe.name,
            ingredients: recipe.ingredients,
            matchedIngredients: recipe.matchedIngredients,
            missingIngredients: recipe.missingIngredients,
            usesSoonIngredients: recipe.usesSoonIngredients,
            minutes: recipe.minutes,
            matchedTags: recipe.matchedTags,
          })),
        }),
      });
      const selectionResult = await structuredSelectionModel.invoke(selectionMessages, {
        tags: ["query", "plan_groceries", "select_recipes"],
        metadata: {
          fridgeId: state.fridgeId,
          imageId: state.imageId,
          langsmithPromptName: loadedSelectionPrompt.name,
          langsmithPromptRef: loadedSelectionPrompt.ref,
          provider: CHAT_PROVIDER,
          model: GENERAL_MODEL,
        },
      });
      const parsedSelection = GroceryRecipeSelectionSchema.safeParse(selectionResult);
      if (!parsedSelection.success || !validSelection(parsedSelection.success ? parsedSelection.data.recipeIds : [], candidates)) {
        return selectionError(state, "Grocery Planner recipe selection returned recipe ids outside the eligible candidate set.");
      }

      const selectedById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
      const selected = parsedSelection.data.recipeIds.map((recipeId) => selectedById.get(recipeId)).filter((recipe): recipe is RankedRecipe => Boolean(recipe));
      const recipes = await (deps.getRecipesByIds ?? getRecipesByIds)(selected.map((recipe) => recipe.id));
      const recipesById = new Map(recipes.map((recipe) => [recipe.id, recipe]));
      const missingRecipeIds = selected.map((recipe) => recipe.id).filter((recipeId) => !recipesById.has(recipeId));
      if (missingRecipeIds.length > 0) {
        return selectionError(state, `Grocery Planner could not load selected recipe records: ${missingRecipeIds.join(", ")}.`);
      }

      const selectedRecipeRecords = selected.map((recipe) => recipesById.get(recipe.id) as Recipe);
      const availableIngredients = await availableRecipeIngredients(state, deps);
      const missing = missingItems({ recipes: selectedRecipeRecords, availableIngredients });
      if (missing.length === 0) {
        const plan = GroceryPlanSchema.parse({ recipes: selected.map(recipeCard), items: [] });
        return { context: { ...state.context, groceryPlan: plan, groceryPlanError: null } };
      }

      const loadedAislePrompt = deps.promptBundle?.groceryAisleAssignment;
      if (!loadedAislePrompt) {
        return selectionError(state, "Grocery Planner aisle assignment prompt is unavailable.");
      }

      writer?.({ type: "grocery_plan_progress", stage: "building_list" });
      const aisleModel = deps.groceryAisleAssignmentModel ?? createQueryModel();
      const structuredAisleModel = aisleModel.withStructuredOutput(
        GroceryAisleAssignmentProviderSchema,
        { name: "FridgeGroceryAisleAssignment" },
      );
      const aisleMessages = await promptMessages(loadedAislePrompt, {
        grocery_aisle_assignment_context_json: JSON.stringify({
          ingredients: missing.map((item) => item.ingredient),
        }),
      });
      const aisleResult = await structuredAisleModel.invoke(aisleMessages, {
        tags: ["query", "plan_groceries", "assign_aisles"],
        metadata: {
          fridgeId: state.fridgeId,
          imageId: state.imageId,
          langsmithPromptName: loadedAislePrompt.name,
          langsmithPromptRef: loadedAislePrompt.ref,
          provider: CHAT_PROVIDER,
          model: GENERAL_MODEL,
        },
      });
      const parsedAisles = GroceryAisleAssignmentSchema.safeParse(aisleResult);
      if (!parsedAisles.success || !validAssignments({
        assignments: parsedAisles.success ? parsedAisles.data.assignments : [],
        ingredients: missing.map((item) => item.ingredient),
      })) {
        return selectionError(state, "Grocery Planner aisle assignment did not cover every missing ingredient exactly once.");
      }

      const aisleByIngredient = new Map(parsedAisles.data.assignments.map((assignment) => [assignment.ingredient, assignment.aisle]));
      const items = missing.map((item) => ({
        ...item,
        aisle: aisleByIngredient.get(item.ingredient) as GroceryPlanItem["aisle"],
      }));
      const plan: GroceryPlan = GroceryPlanSchema.parse({ recipes: selected.map(recipeCard), items });
      return { context: { ...state.context, groceryPlan: plan, groceryPlanError: null } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return selectionError(state, `Grocery Planner failed: ${message}`);
    }
  };
}
