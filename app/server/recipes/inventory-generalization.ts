import type { InventoryItem } from "../scan/schemas/inventory";
import { normalizeIngredientName } from "./normalization";

const PACKAGING_WORDS = new Set([
  "bag",
  "bottle",
  "box",
  "can",
  "carton",
  "container",
  "cup",
  "jar",
  "pack",
  "package",
  "packet",
  "tray",
]);

const NON_INGREDIENT_WORDS = new Set([
  "green",
  "red",
  "blue",
  "white",
  "black",
  "yellow",
  "brown",
  "clear",
]);

const GENERAL_INGREDIENTS = [
  "blackberry jam",
  "cream cheese",
  "lemon juice",
  "cool whip",
  "green yogurt",
  "greek yogurt",
  "pickle",
  "pickles",
  "yogurt",
  "egg",
  "eggs",
  "bread",
  "cheese",
  "butter",
  "tortilla",
  "jam",
  "jelly",
  "lemon",
  "milk",
  "rice",
  "chicken",
];

const CATEGORY_BY_INGREDIENT: Array<{
  ingredients: string[];
  category: InventoryItem["cat"];
}> = [
  { ingredients: ["egg"], category: "eggs" },
  {
    ingredients: ["butter", "cheese", "cool whip", "cream cheese", "greek yogurt", "milk", "yogurt"],
    category: "dairy",
  },
  { ingredients: ["lemon"], category: "produce" },
  { ingredients: ["blackberry jam", "jam", "jelly", "lemon juice", "pickle"], category: "condiment" },
  { ingredients: ["chicken"], category: "meat" },
];

function normalizedWords(value: string) {
  return normalizeIngredientName(value).split(" ").filter(Boolean);
}

function withoutPackagingWords(value: string) {
  return normalizedWords(value)
    .filter((word) => !PACKAGING_WORDS.has(word))
    .join(" ");
}

function knownIngredientSuffix(value: string) {
  const normalized = normalizeIngredientName(value);
  const match = GENERAL_INGREDIENTS
    .map(normalizeIngredientName)
    .sort((left, right) => right.length - left.length)
    .find((ingredient) =>
      normalized === ingredient || normalized.endsWith(` ${ingredient}`)
    );

  return match ?? null;
}

function isGenericNonIngredient(value: string) {
  const words = normalizedWords(value);

  if (words.length === 0) {
    return true;
  }

  return words.every((word) => PACKAGING_WORDS.has(word) || NON_INGREDIENT_WORDS.has(word));
}

export function generalRecipeIngredientName(value: string): string | null {
  const withoutPackaging = withoutPackagingWords(value);

  // Labels made up entirely of packaging/color words (for example "green
  // bottle") describe containers, not food, so they never map to a recipe
  // ingredient.
  if (isGenericNonIngredient(withoutPackaging || value)) {
    return null;
  }

  const suffix = knownIngredientSuffix(withoutPackaging || value);

  if (suffix) {
    return suffix;
  }

  return withoutPackaging || null;
}

function categoryForRecipeIngredient(
  ingredient: string | null,
  label: string,
  packaging: InventoryItem["pack"],
): InventoryItem["cat"] {
  if (ingredient) {
    const normalized = normalizeIngredientName(ingredient);
    const category = CATEGORY_BY_INGREDIENT.find((entry) =>
      entry.ingredients.includes(normalized)
    );

    if (category) {
      return category.category;
    }
  }

  const normalizedLabel = normalizeIngredientName(label);

  if (/\b(drink|beverage|tea|soda|juice)\b/u.test(normalizedLabel)) {
    return "beverage";
  }

  if (/\b(condiment|heinz|pickle|jam|jelly)\b/u.test(normalizedLabel) || packaging === "jar") {
    return "condiment";
  }

  return "other";
}

export function categorizeInventoryForRecipes(input: {
  label: string;
  packaging: InventoryItem["pack"];
}): {
  category: InventoryItem["cat"];
  recipeIngredient: string | null;
} {
  const recipeIngredient = generalRecipeIngredientName(input.label);

  return {
    category: categoryForRecipeIngredient(recipeIngredient, input.label, input.packaging),
    recipeIngredient,
  };
}
