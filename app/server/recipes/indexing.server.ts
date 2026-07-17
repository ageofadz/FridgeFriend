import { loadFoodComRecipes } from "./foodcom.server";
import { upsertRecipes } from "./repository.server";
import type { RecipeIndexResult, RecipeIndexSkip } from "./types";
import {
  indexRecipesInChroma,
  type RecipeVectorStoreDependencies,
} from "./vector-store.server";

export async function indexFoodComRecipes(input: {
  dataDir: string;
  limit?: number;
  vectorStoreDependencies?: RecipeVectorStoreDependencies;
}): Promise<RecipeIndexResult> {
  const recipes = await loadFoodComRecipes({
    dataDir: input.dataDir,
    limit: input.limit,
  });

  if (recipes.length === 0) {
    throw new Error("Food.com recipe index contained no recipes after quality filtering");
  }

  let storedRecipes: number;

  try {
    storedRecipes = upsertRecipes(recipes);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Food.com recipe SQLite indexing failed: ${message}`);
  }

  let indexedDocuments: number;
  const skippedDocuments: RecipeIndexSkip[] = [];

  try {
    indexedDocuments = await indexRecipesInChroma(
      recipes,
      {
        ...input.vectorStoreDependencies,
        onSkippedRecipe: (skip) => {
          input.vectorStoreDependencies?.onSkippedRecipe?.(skip);
          skippedDocuments.push(skip);
        },
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Food.com recipe Chroma indexing failed: ${message}`);
  }

  return {
    selectedRecipes: recipes.length,
    storedRecipes,
    indexedDocuments,
    skippedDocuments,
  };
}
