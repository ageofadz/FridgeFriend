import { normalizeRecipeTag } from "../../recipes/normalization";

const TAG_ALIASES: Record<string, string> = {
  affordable: "inexpensive",
  budget: "inexpensive",
  "budget friendly": "inexpensive",
  cheap: "inexpensive",
  dinner: "main dish",
  dinners: "main dish",
  entree: "main dish",
  entrees: "main dish",
  inexpensive: "inexpensive",
  meal: "main dish",
  meals: "main dish",
  quick: "30 minutes or less",
  supper: "main dish",
  fast: "30 minutes or less",
};

function phrases(value: string) {
  const normalized = normalizeRecipeTag(value);
  const words = normalized.split(" ").filter(Boolean);
  const result = new Set<string>([normalized]);

  for (let length = 1; length <= Math.min(4, words.length); length += 1) {
    for (let start = 0; start + length <= words.length; start += 1) {
      result.add(words.slice(start, start + length).join(" "));
    }
  }

  return [...result].filter(Boolean);
}

export function resolveFoodComTags(terms: string[], catalog: string[]) {
  const normalizedCatalog = [...new Set(catalog.map(normalizeRecipeTag).filter(Boolean))];
  const catalogSet = new Set(normalizedCatalog);
  const resolved = new Set<string>();

  for (const term of terms) {
    for (const phrase of phrases(term)) {
      const alias = TAG_ALIASES[phrase];
      if (alias && catalogSet.has(alias)) {
        resolved.add(alias);
      }

      if (catalogSet.has(phrase)) {
        resolved.add(phrase);
        continue;
      }
    }
  }

  return [...resolved].sort();
}

export function foodComGoalTags(goalType: string, catalog: string[]) {
  const terms: Record<string, string[]> = {
    budget: ["inexpensive"],
    quick_meals: ["30 minutes or less"],
    high_protein: ["high protein"],
    weight_loss: ["low calorie"],
  };

  return resolveFoodComTags(terms[goalType] ?? [], catalog);
}
