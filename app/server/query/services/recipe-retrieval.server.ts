import {
  normalizeIngredientName,
  normalizeRecipeTag,
  selectUsefulTags,
} from "../../recipes/normalization";
import { isUniversalBasicIngredient } from "../../recipes/pantry-basics";
import {
  fuzzyDeduplicateIngredientNames,
  ingredientNamesAreSimilar,
} from "./ingredient-string-match.server";
import type { Recipe, RecipeCandidate } from "../../recipes/types";
import type {
  DietaryPreferenceMemory,
  DietaryRestrictionMemory,
  GoalMemory,
} from "../../memory/schemas";
import type { RecipeSearchRequest } from "../schemas/query";

export type AvailableRecipeIngredient = {
  name: string;
  expirationDate: string | null;
  brand?: string | null;
  wasteScore?: number;
};

export type RankedRecipe = {
  id: string;
  name: string;
  description: string | null;
  minutes: number;
  calories: number | null;
  proteinDailyValue: number | null;
  ingredients: string[];
  matchedIngredients: string[];
  missingIngredients: string[];
  matchedTags: string[];
  matchBadges: string[];
  ingredientCoverage: number;
  expiringCoverage: number;
  wasteReductionScore: number;
  usesSoonIngredients: string[];
  semanticScore: number;
  tagScore: number;
  preferenceScore: number;
  ratingScore: number;
  intentTier?: "primary" | "related" | "coverage";
  eligibilityBand: "strict" | "relaxed";
  score: number;
};

export type RecipeRankingAudit = {
  hardFilterRejections: number;
  coverageRankedCandidates: number;
  tournamentCandidates: number;
  terminalReason: "ready" | "hard_constraints_rejected" | "coverage_rejected" | "tournament_empty";
};

export type RecipeRetrievalResult = {
  source: "food_com";
  inputIngredients: string[];
  semanticQuery: string;
  recipes: RankedRecipe[];
  noMatches: boolean;
  exhausted: boolean;
  reason: string | null;
  audit: RecipeRankingAudit;
};

export type RecipeCoverageMode = "available_ingredients" | "dish_specific";

const GENERALIZABLE_BASE_INGREDIENTS = new Set([
  "beef", "chicken", "egg", "fish", "pork", "shrimp", "tofu", "turkey",
]);

function clamp(value: number) {
  return Math.max(0, Math.min(1, value));
}

function hasTerm(values: string[], term: string) {
  const normalizedTerm = normalizeIngredientName(term);
  return values.some((value) => {
    const normalizedValue = normalizeIngredientName(value);
    return normalizedValue === normalizedTerm || normalizedValue.includes(normalizedTerm) ||
      normalizedTerm.includes(normalizedValue);
  });
}

function matchesRequestedIngredient(recipeIngredient: string, requestedIngredient: string) {
  const normalizedRecipeIngredient = normalizeIngredientName(recipeIngredient);
  const normalizedRequestedIngredient = normalizeIngredientName(requestedIngredient);

  if (!normalizedRecipeIngredient || !normalizedRequestedIngredient) {
    return false;
  }

  if (normalizedRecipeIngredient === normalizedRequestedIngredient) {
    return true;
  }

  const escaped = normalizedRequestedIngredient.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|\\s)${escaped}(\\s|$)`, "u").test(normalizedRecipeIngredient);
}

function requestedIngredientSignals(search: RecipeSearchRequest) {
  return [...new Set(search.preferredIngredients.map(normalizeIngredientName).filter(Boolean))];
}

function requestedIngredientMatches(recipeIngredients: string[], requestedIngredients: string[]) {
  if (requestedIngredients.length === 0) {
    return [];
  }

  return recipeIngredients.filter((ingredient) =>
    requestedIngredients.some((requested) => matchesRequestedIngredient(ingredient, requested))
  );
}

function normalizedIngredientVariants(ingredient: AvailableRecipeIngredient) {
  const name = normalizeIngredientName(ingredient.name);
  const brand = ingredient.brand ? normalizeIngredientName(ingredient.brand) : "";
  const withoutBrand = brand && name.startsWith(`${brand} `) ? name.slice(brand.length).trim() : name;
  const variants = new Set([name, withoutBrand]);
  const words = withoutBrand.split(" ").filter(Boolean);

  for (let length = 2; length < words.length; length += 1) {
    variants.add(words.slice(-length).join(" "));
  }

  return [...variants].filter(Boolean);
}

function matchesAvailableIngredient(recipeIngredient: string, availableIngredients: AvailableRecipeIngredient[]) {
  return availableIngredients.some((availableIngredient) => normalizedIngredientVariants(availableIngredient)
    .some((availableName) => {
      if (availableName === recipeIngredient) {
        return true;
      }
      if (availableName.split(" ").length >= 2 && recipeIngredient.endsWith(` ${availableName}`)) {
        return true;
      }
      const [base] = availableName.split(" ");
      return (availableName === base && GENERALIZABLE_BASE_INGREDIENTS.has(base) && recipeIngredient.startsWith(`${base} `)) ||
        ingredientNamesAreSimilar(recipeIngredient, availableName);
    }));
}

export function recipeIngredientIsAvailable(
  recipeIngredient: string,
  availableIngredients: AvailableRecipeIngredient[],
) {
  return matchesAvailableIngredient(recipeIngredient, availableIngredients);
}

function recipeTags(recipe: Recipe) {
  return recipe.tags.map(normalizeRecipeTag).filter(Boolean);
}

function isDietaryTag(restriction: string) {
  return new Set(["vegetarian", "vegan", "gluten free", "dairy free", "low carb", "low calorie"])
    .has(normalizeRecipeTag(restriction));
}

function violatesHardConstraints(
  recipe: Recipe,
  search: RecipeSearchRequest,
  dietaryRestrictions: DietaryRestrictionMemory[],
) {
  const ingredients = recipe.ingredients.map((ingredient) => ingredient.canonicalName);
  const tags = recipeTags(recipe);
  const restrictions = [...search.dietaryRestrictions, ...dietaryRestrictions.map((restriction) => restriction.subject)];

  if (search.maxMinutes !== null && recipe.minutes > search.maxMinutes ||
    search.maxCalories !== null && (recipe.nutrition.calories === null || recipe.nutrition.calories > search.maxCalories) ||
    search.minProteinDailyValue !== null &&
      (recipe.nutrition.proteinDailyValue === null || recipe.nutrition.proteinDailyValue < search.minProteinDailyValue) ||
    search.excludedIngredients.some((excluded) => hasTerm(ingredients, excluded)) ||
    search.requiredTags.some((tag) => !tags.includes(tag)) ||
    search.excludedTags.some((tag) => tags.includes(tag))) {
    return true;
  }

  return restrictions.some((restriction) => isDietaryTag(restriction)
    ? !tags.includes(normalizeRecipeTag(restriction))
    : hasTerm(ingredients, restriction));
}

function isExpiring(date: string | null, now: Date) {
  if (!date) return false;
  const expiration = new Date(date);
  if (Number.isNaN(expiration.valueOf())) return false;
  const sevenDaysFromNow = new Date(now);
  sevenDaysFromNow.setDate(sevenDaysFromNow.getDate() + 7);
  return expiration >= now && expiration <= sevenDaysFromNow;
}

function tagPreferenceScore(tags: string[], search: RecipeSearchRequest) {
  const direct = search.preferredTags.length === 0 ? 0 :
    search.preferredTags.filter((tag) => tags.includes(tag)).length / search.preferredTags.length;
  const memoryPositive = [...search.memoryPreferredTags, ...search.memoryGoalTags];
  const positive = memoryPositive.length === 0 ? 0 :
    memoryPositive.filter((tag) => tags.includes(tag)).length / memoryPositive.length;
  const negative = search.memoryExcludedTags.length === 0 ? 0 :
    search.memoryExcludedTags.filter((tag) => tags.includes(tag)).length / search.memoryExcludedTags.length;
  return clamp(direct * 0.75 + positive * 0.25 - negative * 0.35);
}

function durablePreferenceScore(recipe: Recipe, preferences: DietaryPreferenceMemory[], goals: GoalMemory[]) {
  const values = [...recipe.ingredients.map((ingredient) => ingredient.canonicalName), ...recipeTags(recipe)];
  const positive = preferences.filter((preference) => preference.sentiment === "like" || preference.sentiment === "prefer");
  const negative = preferences.filter((preference) => preference.sentiment === "dislike" || preference.sentiment === "avoid");
  const positiveScore = positive.length === 0 ? 0 : positive.filter((preference) => hasTerm(values, preference.subject)).length / positive.length;
  const negativePenalty = negative.length === 0 ? 0 : negative.filter((preference) => hasTerm(values, preference.subject)).length / negative.length;
  const goalScores = goals.flatMap((goal) => {
    if (goal.goalType === "high_protein") return [clamp((recipe.nutrition.proteinDailyValue ?? 0) / 100)];
    if (goal.goalType === "weight_loss") return [recipe.nutrition.calories === null ? 0 : clamp(1 - recipe.nutrition.calories / 1000)];
    if (goal.goalType === "quick_meals") return [clamp(1 - recipe.minutes / 60)];
    return [];
  });
  const goalScore = goalScores.length === 0 ? 0 : goalScores.reduce((sum, score) => sum + score, 0) / goalScores.length;
  return clamp((positiveScore + goalScore) / Math.max(1, Number(positive.length > 0) + Number(goalScores.length > 0)) - negativePenalty);
}

function badges(tags: string[], _matchedIngredients: string[], search: RecipeSearchRequest) {
  const tagBadges = [...new Set([
    ...search.preferredTags,
    ...search.requiredTags,
  ].filter((tag) => tags.includes(tag)).map((tag) => tag.replace(/\b\w/g, (letter) => letter.toUpperCase())))];
  return tagBadges.slice(0, 3);
}

export function recipeCoverageMode(search: RecipeSearchRequest): RecipeCoverageMode {
  if (!search.intent) {
    return search.useAvailableIngredients ? "available_ingredients" : "dish_specific";
  }

  return search.intent.specific ? "dish_specific" : "available_ingredients";
}

function intentTierRank(tier: RankedRecipe["intentTier"]) {
  if (tier === "primary") return 0;
  if (tier === "related") return 1;
  return 2;
}

function eligibilityBand(input: {
  coverageMode: RecipeCoverageMode;
  matchedIngredients: string[];
}): "strict" | "relaxed" | null {
  if (input.coverageMode === "dish_specific") {
    return "strict";
  }

  return input.matchedIngredients.length > 0 ? "strict" : null;
}

function ingredientSimilarity(left: RankedRecipe, right: RankedRecipe) {
  const leftSet = new Set(left.ingredients);
  const rightSet = new Set(right.ingredients);
  const intersection = [...leftSet].filter((ingredient) => rightSet.has(ingredient)).length;
  return intersection / Math.max(1, new Set([...leftSet, ...rightSet]).size);
}

function tagSimilarity(left: RankedRecipe, right: RankedRecipe) {
  const leftSet = new Set(selectUsefulTags(left.matchedTags));
  const rightSet = new Set(selectUsefulTags(right.matchedTags));
  const intersection = [...leftSet].filter((tag) => rightSet.has(tag)).length;
  return intersection / Math.max(1, new Set([...leftSet, ...rightSet]).size);
}

function primaryIngredientSignature(recipe: RankedRecipe) {
  return recipe.ingredients.slice(0, 2).sort().join("|");
}

function nameSimilarity(left: RankedRecipe, right: RankedRecipe) {
  const leftWords = new Set(normalizeRecipeTag(left.name).split(" ").filter(Boolean));
  const rightWords = new Set(normalizeRecipeTag(right.name).split(" ").filter(Boolean));
  const intersection = [...leftWords].filter((word) => rightWords.has(word)).length;
  return intersection / Math.max(1, new Set([...leftWords, ...rightWords]).size);
}

function diversifyRecipes(recipes: RankedRecipe[], limit = 5, initial: RankedRecipe[] = []) {
  const remaining = [...recipes];
  const selected = [...initial];
  const result: RankedRecipe[] = [];

  while (result.length < limit && remaining.length > 0) {
    let bestIndex = 0;
    let bestScore = -Infinity;
    for (let index = 0; index < remaining.length; index += 1) {
      const candidate = remaining[index];
      const penalty = selected.length === 0 ? 0 : Math.max(...selected.map((chosen) =>
        ingredientSimilarity(candidate, chosen) * 0.45 +
        tagSimilarity(candidate, chosen) * 0.2 +
        Number(primaryIngredientSignature(candidate) === primaryIngredientSignature(chosen)) * 0.2 +
        nameSimilarity(candidate, chosen) * 0.15));
      const adjusted = candidate.score * 0.7 + (1 - penalty) * 0.3;
      if (adjusted > bestScore || adjusted === bestScore && candidate.id < remaining[bestIndex].id) {
        bestScore = adjusted;
        bestIndex = index;
      }
    }
    const chosen = remaining.splice(bestIndex, 1)[0];
    selected.push(chosen);
    result.push(chosen);
  }

  return result;
}

function diversifyRecipesByIntentTier(recipes: RankedRecipe[], limit: number, initial: RankedRecipe[] = []) {
  const selected: RankedRecipe[] = [];

  for (const tier of ["primary", "related", "coverage"] as const) {
    if (selected.length === limit) break;
    const tierRecipes = recipes.filter((recipe) => (recipe.intentTier ?? "coverage") === tier);
    selected.push(...diversifyRecipes(tierRecipes, limit - selected.length, [...initial, ...selected]));
  }

  return selected;
}

export function rankRecipeCandidates(input: {
  candidates: RecipeCandidate[];
  recipes: Recipe[];
  search: RecipeSearchRequest;
  availableIngredients: AvailableRecipeIngredient[];
  dietaryRestrictions: DietaryRestrictionMemory[];
  dietaryPreferences?: DietaryPreferenceMemory[];
  activeGoals?: GoalMemory[];
  excludedRecipeIds?: string[];
  limit?: number;
  minimumPrimaryIntentResults?: number;
  minMissingIngredients?: number;
  maxMissingIngredients?: number;
  excludeUniversalBasics?: boolean;
  now?: Date;
}): RecipeRetrievalResult {
  const candidateById = new Map(input.candidates.map((candidate) => [candidate.recipeId, candidate]));
  const availableIngredients = input.availableIngredients.filter((ingredient) => normalizeIngredientName(ingredient.name));
  const availableNames = availableIngredients.map((ingredient) => normalizeIngredientName(ingredient.name));
  const coverageMode = recipeCoverageMode(input.search);
  const requestedIngredients = requestedIngredientSignals(input.search);
  const now = input.now ?? new Date();
  const ingredientWasteScores = new Map<string, number>();
  for (const ingredient of availableIngredients) {
    const directScore = isExpiring(ingredient.expirationDate, now) ? 0.4 : 0;
    const score = Math.max(directScore, ingredient.wasteScore ?? 0);
    for (const name of normalizedIngredientVariants(ingredient)) {
      ingredientWasteScores.set(name, Math.max(ingredientWasteScores.get(name) ?? 0, score));
    }
  }
  const totalWasteScore = [...new Set(availableIngredients.flatMap(normalizedIngredientVariants))]
    .reduce((sum, name) => sum + (ingredientWasteScores.get(name) ?? 0), 0);
  const excludedRecipeIds = new Set(input.excludedRecipeIds ?? []);
  let hardFilterRejections = 0;
  let coverageRejections = 0;
  const ranked: RankedRecipe[] = [];
  for (const recipe of input.recipes) {
    const candidate = candidateById.get(recipe.id);
    if (!candidate || excludedRecipeIds.has(recipe.id) || violatesHardConstraints(recipe, input.search, input.dietaryRestrictions)) {
      hardFilterRejections += 1;
      continue;
    }
    const ingredients = fuzzyDeduplicateIngredientNames(
      recipe.ingredients.map((ingredient) => ingredient.canonicalName),
      { allowUniversalBasicOverlap: true },
    );
    const matchedIngredients = ingredients.filter((ingredient) => matchesAvailableIngredient(ingredient, availableIngredients));
    const matchedRequestedIngredients = requestedIngredientMatches(ingredients, requestedIngredients);
    const missingIngredients = ingredients
      .filter((ingredient) => !matchesAvailableIngredient(ingredient, availableIngredients))
      .filter((ingredient) => !input.excludeUniversalBasics || !isUniversalBasicIngredient(ingredient));
    if (
      input.minMissingIngredients !== undefined && missingIngredients.length < input.minMissingIngredients ||
      input.maxMissingIngredients !== undefined && missingIngredients.length > input.maxMissingIngredients
    ) {
      coverageRejections += 1;
      continue;
    }
    const ingredientCoverage = ingredients.length === 0 ? 0 : matchedIngredients.length / ingredients.length;
    const band = input.minMissingIngredients !== undefined
      ? matchedIngredients.length > 0 ? "strict" : null
      : eligibilityBand({
        coverageMode,
        matchedIngredients,
      });
    if (!band) {
      coverageRejections += 1;
      continue;
    }
    const tags = recipeTags(recipe);
    const semanticScore = clamp(candidate.semanticScore);
    const tagScore = clamp(candidate.tagScore ?? 0);
    const ingredientScore = clamp(candidate.ingredientScore ?? 0);
    const requestedIngredientScore = requestedIngredients.length === 0
      ? 0
      : matchedRequestedIngredients.length / requestedIngredients.length;
    const preferenceScore = clamp(tagPreferenceScore(tags, input.search) * 0.75 +
      durablePreferenceScore(recipe, input.dietaryPreferences ?? [], input.activeGoals ?? []) * 0.25);
    const usesSoonIngredients = matchedIngredients.filter((ingredient) => (ingredientWasteScores.get(ingredient) ?? 0) > 0);
    const matchedWasteScore = usesSoonIngredients.reduce((sum, ingredient) => sum + (ingredientWasteScores.get(ingredient) ?? 0), 0);
    const wasteReductionScore = totalWasteScore === 0 ? 0 : clamp(matchedWasteScore / totalWasteScore);
    const expiringCoverage = wasteReductionScore;
    const ratingScore = recipe.rating ? clamp(recipe.rating.average / 5) : 0;
    const score = semanticScore * 0.2 + tagScore * 0.22 + ingredientScore * 0.18 +
      ingredientCoverage * 0.18 + wasteReductionScore * 0.16 + preferenceScore * 0.07 +
      ratingScore * 0.03 + requestedIngredientScore * 0.08 - missingIngredients.length * 0.03;
    ranked.push({
      id: recipe.id, name: recipe.name, description: recipe.description, minutes: recipe.minutes,
      calories: recipe.nutrition.calories, proteinDailyValue: recipe.nutrition.proteinDailyValue,
      ingredients, matchedIngredients, missingIngredients,
      matchedTags: [...new Set([...(candidate.matchedTags ?? []), ...selectUsefulTags(tags)])].sort(),
      matchBadges: badges(tags, matchedIngredients, input.search),
      ingredientCoverage, expiringCoverage, wasteReductionScore, usesSoonIngredients, semanticScore, tagScore, preferenceScore, ratingScore,
      eligibilityBand: band, score, intentTier: candidate.intentTier,
    } satisfies RankedRecipe);
  }
  ranked.sort((left, right) =>
    intentTierRank(left.intentTier) - intentTierRank(right.intentTier) ||
    right.score - left.score ||
    right.ingredientCoverage - left.ingredientCoverage ||
    left.id.localeCompare(right.id));
  const limit = input.limit ?? 5;
  const minimumPrimaryIntentResults = input.minimumPrimaryIntentResults ?? 1;
  const primary = ranked.filter((recipe) => recipe.intentTier === "primary");
  const intentEligible = input.search.intent?.specific
    ? primary.length >= minimumPrimaryIntentResults
      ? primary
      : ranked.filter((recipe) => recipe.intentTier === "primary" || recipe.intentTier === "related")
    : ranked;
  const strict = intentEligible.filter((recipe) => recipe.eligibilityBand === "strict");
  const selectedStrict = diversifyRecipesByIntentTier(strict, limit);
  const relaxed = intentEligible.filter((recipe) => recipe.eligibilityBand === "relaxed");
  const recipes = [
    ...selectedStrict,
    ...diversifyRecipesByIntentTier(relaxed, Math.max(0, limit - selectedStrict.length), selectedStrict),
  ];
  const exhausted = recipes.length < limit;
  const terminalReason = recipes.length > 0
    ? "ready"
    : hardFilterRejections > 0 && ranked.length === 0
      ? "hard_constraints_rejected"
      : coverageRejections > 0
        ? "coverage_rejected"
        : "tournament_empty";

  return {
    source: "food_com", inputIngredients: availableNames, semanticQuery: input.search.semanticQuery, recipes,
    noMatches: recipes.length === 0,
    exhausted,
    reason: recipes.length === 0
      ? terminalReason === "hard_constraints_rejected"
        ? "Retrieved recipes did not satisfy the requested hard constraints."
        : terminalReason === "coverage_rejected"
          ? "Retrieved recipes did not use a verified available ingredient."
          : "Recipe retrieval returned no tournament candidates for the current search constraints."
      : exhausted
        ? "These are the remaining matches for this search."
        : null,
    audit: {
      hardFilterRejections,
      coverageRankedCandidates: ranked.length,
      tournamentCandidates: recipes.length,
      terminalReason,
    },
  };
}
