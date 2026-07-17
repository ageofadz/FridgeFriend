export type RecipeIngredient = {
  rawName: string;
  canonicalName: string;
};

export type RecipeNutrition = {
  calories: number | null;
  totalFatDailyValue: number | null;
  sugarDailyValue: number | null;
  sodiumDailyValue: number | null;
  proteinDailyValue: number | null;
  saturatedFatDailyValue: number | null;
  carbohydratesDailyValue: number | null;
};

export type RecipeRating = {
  average: number;
  count: number;
};

export type Recipe = {
  id: string;
  name: string;
  description: string | null;
  ingredients: RecipeIngredient[];
  tags: string[];
  steps: string[];
  minutes: number;
  stepCount: number;
  ingredientCount: number;
  nutrition: RecipeNutrition;
  rating: RecipeRating | null;
};

export type RecipeCandidate = {
  recipeId: string;
  semanticScore: number;
  tagScore?: number;
  matchedTags?: string[];
  ingredientScore?: number;
  matchedInventoryIngredients?: string[];
};

export type RecipeRatingAggregate = {
  average: number;
  count: number;
};

export type RecipeIndexResult = {
  selectedRecipes: number;
  storedRecipes: number;
  indexedDocuments: number;
  skippedDocuments: RecipeIndexSkip[];
};

export type RecipeIndexSkip = {
  recipeId: string;
  reason: string;
};
