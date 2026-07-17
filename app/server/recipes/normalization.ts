import type { Recipe } from "./types";

const PREPARATION_MODIFIERS = new Set([
  "boneless",
  "skinless",
  "cooked",
  "uncooked",
  "fresh",
  "frozen",
  "dried",
  "chopped",
  "minced",
  "diced",
  "sliced",
  "crushed",
  "grated",
  "shredded",
  "melted",
  "softened",
  "divided",
  "optional",
  "lean",
  "large",
  "small",
  "medium",
]);

const INGREDIENT_ALIASES: Record<string, string> = {
  "boneless skinless chicken breast": "chicken breast",
  "chicken breast half": "chicken breast",
  "chicken breast": "chicken breast",
  scallion: "green onion",
  "spring onion": "green onion",
  "green onion": "green onion",
  "garbanzo bean": "chickpea",
  chickpea: "chickpea",
  capsicum: "bell pepper",
  courgette: "zucchini",
};

const GENERIC_TAGS = new Set([
  "time to make",
  "course",
  "main ingredient",
  "preparation",
  "occasion",
  "cuisine",
  "dietary",
  "equipment",
]);

const COOKING_METHODS = [
  "bake",
  "boil",
  "broil",
  "fry",
  "grill",
  "roast",
  "saute",
  "simmer",
  "steam",
  "stir fry",
  "slow cook",
  "blend",
  "whisk",
  "mix",
];

function normalizedWords(value: string) {
  return value
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function singularize(word: string) {
  if (word.endsWith("ies") && word.length > 3) {
    return `${word.slice(0, -3)}y`;
  }

  if (word.endsWith("oes") && word.length > 3) {
    return `${word.slice(0, -2)}`;
  }

  if (/(ches|shes|xes|zes|ses)$/.test(word) && word.length > 3) {
    return word.slice(0, -2);
  }

  if (word.endsWith("s") && !word.endsWith("ss") && word.length > 2) {
    return word.slice(0, -1);
  }

  return word;
}

export function normalizeIngredientName(value: string): string {
  const normalized = normalizedWords(value)
    .filter((word) => !PREPARATION_MODIFIERS.has(word))
    .map(singularize)
    .join(" ");

  return INGREDIENT_ALIASES[normalized] ?? normalized;
}

export function normalizeRecipeTag(value: string): string {
  return normalizedWords(value).join(" ");
}

export function selectUsefulTags(tags: string[]): string[] {
  const seen = new Set<string>();

  return tags.flatMap((tag) => {
    const normalized = normalizeRecipeTag(tag);

    if (!normalized || GENERIC_TAGS.has(normalized) || seen.has(normalized)) {
      return [];
    }

    seen.add(normalized);
    return [normalized];
  });
}

export function extractCookingMethods(steps: string[]): string[] {
  const text = steps
    .map((step) => step.normalize("NFKD").replace(/\p{Diacritic}/gu, "").toLowerCase())
    .join("\n");

  return COOKING_METHODS.filter((method) =>
    new RegExp(`\\b${method.replace(" ", "\\s+")}\\w*`, "u").test(text)
  );
}

export function buildRecipeRetrievalText(recipe: Recipe): string {
  const methods = extractCookingMethods(recipe.steps);
  const tags = selectUsefulTags(recipe.tags);

  return [
    `Recipe: ${recipe.name}`,
    recipe.description ? `Description: ${recipe.description}` : null,
    `Ingredients: ${recipe.ingredients.map((ingredient) => ingredient.canonicalName).join(", ")}`,
    tags.length > 0 ? `Tags: ${tags.join(", ")}` : null,
    methods.length > 0 ? `Cooking methods: ${methods.join(", ")}` : null,
  ]
    .filter((section): section is string => section !== null)
    .join("\n");
}
