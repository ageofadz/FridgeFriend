import { generalRecipeIngredientName } from "../../recipes/inventory-generalization";
import { normalizeIngredientName } from "../../recipes/normalization";
import type { QueryGraphDependencies } from "../schemas/query";
import type { FridgeQueryStateValue } from "../state";
import { loadInventoryContext } from "./inventory-context.server";
import type { AvailableRecipeIngredient } from "./recipe-retrieval.server";

function recipeIngredientFromInventoryItem(item: {
  displayName: string;
  canonicalName: string;
  subcategory: string | null;
  attributes: {
    expirationDate: string | null;
    brand: string | null;
  };
}): AvailableRecipeIngredient | null {
  const fromSubcategory = normalizeIngredientName(item.subcategory ?? "");
  const name = fromSubcategory || generalRecipeIngredientName(item.canonicalName || item.displayName);

  if (!name) {
    return null;
  }

  return {
    name,
    expirationDate: item.attributes.expirationDate,
    brand: item.attributes.brand,
  };
}

function recipeIngredientFromExternalItem(item: FridgeQueryStateValue["externalInventory"][number]): AvailableRecipeIngredient | null {
  const name = normalizeIngredientName(item.canonicalName || item.name);

  if (!name) {
    return null;
  }

  return { name, expirationDate: item.expirationDate ?? null };
}

function uniqueIngredients(ingredients: AvailableRecipeIngredient[]) {
  const seen = new Set<string>();

  return ingredients.filter((ingredient) => {
    const name = normalizeIngredientName(ingredient.name);

    if (!name || seen.has(name)) {
      return false;
    }

    seen.add(name);
    ingredient.name = name;
    return true;
  });
}

export async function availableRecipeIngredients(
  state: FridgeQueryStateValue,
  deps: QueryGraphDependencies,
): Promise<AvailableRecipeIngredient[]> {
  const inventory = await loadInventoryContext(state, deps);
  const visible = inventory?.items.flatMap((item) => {
    const ingredient = recipeIngredientFromInventoryItem(item);
    return ingredient ? [ingredient] : [];
  }) ?? [];
  const external = state.externalInventory.flatMap((item) => {
    const ingredient = recipeIngredientFromExternalItem(item);
    return ingredient ? [ingredient] : [];
  });

  const ingredients = uniqueIngredients([...visible, ...external]);
  const expiryPlan = state.context.expiryPlan;
  const expiryItems = typeof expiryPlan === "object" && expiryPlan !== null && "items" in expiryPlan && Array.isArray(expiryPlan.items)
    ? expiryPlan.items.filter((item): item is { ingredientName: string; urgency: string; wasteScore: number } =>
      typeof item === "object" && item !== null &&
      "ingredientName" in item && typeof item.ingredientName === "string" &&
      "urgency" in item && typeof item.urgency === "string" &&
      "wasteScore" in item && typeof item.wasteScore === "number",
    )
    : [];

  return ingredients.flatMap((ingredient) => {
    const matches = expiryItems.filter((item) => normalizeIngredientName(item.ingredientName) === ingredient.name);
    if (matches.length > 0 && matches.every((item) => item.urgency === "expired")) {
      return [];
    }

    return [{
      ...ingredient,
      wasteScore: matches.reduce((score, item) => Math.max(score, item.wasteScore), 0),
    }];
  });
}
