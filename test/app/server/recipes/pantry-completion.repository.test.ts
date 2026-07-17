import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { UNIVERSAL_BASIC_INGREDIENTS } from "../../../../app/server/recipes/pantry-basics";
import {
  getPantryCompletionRecipeCandidates,
  upsertRecipes,
} from "../../../../app/server/recipes/repository.server";
import { resetSqliteBootstrapCacheForTests } from "../../../../app/server/sqlite.server";
import type { Recipe } from "../../../../app/server/recipes/types";

function recipe(id: string, ingredients: string[]): Recipe {
  return {
    id,
    name: id,
    description: null,
    ingredients: ingredients.map((ingredient) => ({ rawName: ingredient, canonicalName: ingredient })),
    tags: [],
    steps: [],
    minutes: 20,
    stepCount: 0,
    ingredientCount: ingredients.length,
    nutrition: {
      calories: null,
      totalFatDailyValue: null,
      sugarDailyValue: null,
      sodiumDailyValue: null,
      proteinDailyValue: null,
      saturatedFatDailyValue: null,
      carbohydratesDailyValue: null,
    },
    rating: null,
  };
}

describe("pantry completion recipe candidates", () => {
  let databasePath: string;

  beforeEach(() => {
    databasePath = path.join(tmpdir(), `fridgefriend-pantry-completion-${randomUUID()}.sqlite`);
    process.env.DATABASE_PATH = databasePath;
    resetSqliteBootstrapCacheForTests();
    upsertRecipes([
      recipe("already-complete", ["egg", "salt"]),
      recipe("one-missing", ["egg", "salt", "garlic"]),
      recipe("three-missing", ["egg", "water", "garlic", "onion", "cumin"]),
      recipe("four-missing", ["egg", "salt", "garlic", "onion", "cumin", "paprika"]),
    ]);
  });

  afterEach(() => {
    rmSync(databasePath, { force: true });
    rmSync(`${databasePath}-wal`, { force: true });
    rmSync(`${databasePath}-shm`, { force: true });
    delete process.env.DATABASE_PATH;
    resetSqliteBootstrapCacheForTests();
  });

  it("uses normalized inventory names and excludes universal basics from the missing count", () => {
    expect(getPantryCompletionRecipeCandidates({
      ingredients: ["eggs"],
      universalIngredients: UNIVERSAL_BASIC_INGREDIENTS,
      minMissingIngredients: 1,
      maxMissingIngredients: 3,
      limit: 10,
    })).toEqual([
      {
        recipeId: "one-missing",
        matchedIngredients: ["egg"],
        ingredientScore: 1,
        missingIngredientCount: 1,
      },
      {
        recipeId: "three-missing",
        matchedIngredients: ["egg"],
        ingredientScore: 1,
        missingIngredientCount: 3,
      },
    ]);
  });
});
