import { normalizeIngredientName } from "./normalization";

export const UNIVERSAL_BASIC_INGREDIENTS = [
  "water",
  "cold water",
  "warm water",
  "hot water",
  "boiling water",
  "ice",
  "ice cube",
  "salt",
  "table salt",
  "kosher salt",
  "sea salt",
  "pepper",
  "black pepper",
  "white pepper",
  "ground pepper",
  "ground black pepper",
  "fresh ground black pepper",
  "freshly ground black pepper",
  "salt and pepper",
  "salt pepper",
  "cooking spray",
] as const;

const universalBasicIngredients = new Set<string>(UNIVERSAL_BASIC_INGREDIENTS);

export function isUniversalBasicIngredient(ingredient: string) {
  return universalBasicIngredients.has(normalizeIngredientName(ingredient));
}
