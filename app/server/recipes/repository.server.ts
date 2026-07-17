import { asc, inArray, sql } from "drizzle-orm";

import {
  foodComRecipeIngredients,
  foodComRecipeTags,
  foodComRecipes,
} from "../db/schema.server";
import { withDatabase } from "../sqlite.server";
import { normalizeIngredientName, normalizeRecipeTag } from "./normalization";
import type { Recipe, RecipeIngredient, RecipeNutrition, RecipeRating } from "./types";

const RECIPE_SQLITE_BATCH_SIZE = 500;

function nowIso() {
  return new Date().toISOString();
}

function parseJson(value: string, field: string, recipeId: string): unknown {
  try {
    return JSON.parse(value);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Stored Food.com recipe ${recipeId} had invalid ${field}: ${message}`);
  }
}

function parseStringArray(value: string, field: string, recipeId: string): string[] {
  const parsed = parseJson(value, field, recipeId);

  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) {
    throw new Error(`Stored Food.com recipe ${recipeId} had invalid ${field}`);
  }

  return parsed;
}

function parseIngredients(value: string, recipeId: string): RecipeIngredient[] {
  const parsed = parseJson(value, "ingredients", recipeId);

  if (!Array.isArray(parsed)) {
    throw new Error(`Stored Food.com recipe ${recipeId} had invalid ingredients`);
  }

  return parsed.map((ingredient) => {
    if (
      !ingredient ||
      typeof ingredient !== "object" ||
      typeof (ingredient as RecipeIngredient).rawName !== "string" ||
      typeof (ingredient as RecipeIngredient).canonicalName !== "string"
    ) {
      throw new Error(`Stored Food.com recipe ${recipeId} had invalid ingredients`);
    }

    return {
      rawName: (ingredient as RecipeIngredient).rawName,
      canonicalName: (ingredient as RecipeIngredient).canonicalName,
    };
  });
}

function parseNullableNumber(value: unknown, field: string, recipeId: string) {
  if (value === null) {
    return null;
  }

  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Stored Food.com recipe ${recipeId} had invalid ${field}`);
  }

  return value;
}

function parseNutrition(value: string, recipeId: string): RecipeNutrition {
  const parsed = parseJson(value, "nutrition", recipeId);

  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Stored Food.com recipe ${recipeId} had invalid nutrition`);
  }

  const nutrition = parsed as Record<string, unknown>;

  return {
    calories: parseNullableNumber(nutrition.calories, "nutrition.calories", recipeId),
    totalFatDailyValue: parseNullableNumber(
      nutrition.totalFatDailyValue,
      "nutrition.totalFatDailyValue",
      recipeId,
    ),
    sugarDailyValue: parseNullableNumber(
      nutrition.sugarDailyValue,
      "nutrition.sugarDailyValue",
      recipeId,
    ),
    sodiumDailyValue: parseNullableNumber(
      nutrition.sodiumDailyValue,
      "nutrition.sodiumDailyValue",
      recipeId,
    ),
    proteinDailyValue: parseNullableNumber(
      nutrition.proteinDailyValue,
      "nutrition.proteinDailyValue",
      recipeId,
    ),
    saturatedFatDailyValue: parseNullableNumber(
      nutrition.saturatedFatDailyValue,
      "nutrition.saturatedFatDailyValue",
      recipeId,
    ),
    carbohydratesDailyValue: parseNullableNumber(
      nutrition.carbohydratesDailyValue,
      "nutrition.carbohydratesDailyValue",
      recipeId,
    ),
  };
}

function rowToRecipe(row: typeof foodComRecipes.$inferSelect): Recipe {
  const rating = row.ratingAverage === null || row.ratingCount === null
    ? null
    : {
      average: row.ratingAverage,
      count: row.ratingCount,
    } satisfies RecipeRating;

  return {
    id: row.id,
    name: row.name,
    description: row.description,
    ingredients: parseIngredients(row.ingredientsJson, row.id),
    tags: parseStringArray(row.tagsJson, "tags", row.id),
    steps: parseStringArray(row.stepsJson, "steps", row.id),
    minutes: row.minutes,
    stepCount: row.stepCount,
    ingredientCount: row.ingredientCount,
    nutrition: parseNutrition(row.nutritionJson, row.id),
    rating,
  };
}

function rowForRecipe(recipe: Recipe) {
  const now = nowIso();

  return {
    id: recipe.id,
    name: recipe.name,
    description: recipe.description,
    ingredientsJson: JSON.stringify(recipe.ingredients),
    tagsJson: JSON.stringify(recipe.tags),
    stepsJson: JSON.stringify(recipe.steps),
    minutes: recipe.minutes,
    stepCount: recipe.stepCount,
    ingredientCount: recipe.ingredientCount,
    nutritionJson: JSON.stringify(recipe.nutrition),
    ratingAverage: recipe.rating?.average ?? null,
    ratingCount: recipe.rating?.count ?? null,
    updatedAt: now,
  };
}

function chunk<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = [];

  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }

  return chunks;
}

export function upsertRecipes(recipes: Recipe[]): number {
  if (recipes.length === 0) {
    return 0;
  }

  return withDatabase((db) => {
    let upserted = 0;

    for (const batch of chunk(recipes, RECIPE_SQLITE_BATCH_SIZE)) {
      db.transaction((transaction) => {
        for (const recipe of batch) {
          const row = rowForRecipe(recipe);

          transaction.insert(foodComRecipes)
            .values(row)
            .onConflictDoUpdate({
              target: foodComRecipes.id,
              set: {
                name: row.name,
                description: row.description,
                ingredientsJson: row.ingredientsJson,
                tagsJson: row.tagsJson,
                stepsJson: row.stepsJson,
                minutes: row.minutes,
                stepCount: row.stepCount,
                ingredientCount: row.ingredientCount,
                nutritionJson: row.nutritionJson,
                ratingAverage: row.ratingAverage,
                ratingCount: row.ratingCount,
                updatedAt: row.updatedAt,
              },
            })
            .run();

          transaction.delete(foodComRecipeTags)
            .where(inArray(foodComRecipeTags.recipeId, [recipe.id]))
            .run();

          transaction.delete(foodComRecipeIngredients)
            .where(inArray(foodComRecipeIngredients.recipeId, [recipe.id]))
            .run();

          const tags = [...new Set(recipe.tags.map(normalizeRecipeTag).filter(Boolean))];

          if (tags.length > 0) {
            transaction.insert(foodComRecipeTags)
              .values(tags.map((tag) => ({ recipeId: recipe.id, tag })))
              .run();
          }

          const ingredients = [...new Set(recipe.ingredients
            .map((ingredient) => normalizeIngredientName(ingredient.canonicalName))
            .filter(Boolean))];

          if (ingredients.length > 0) {
            transaction.insert(foodComRecipeIngredients)
              .values(ingredients.map((ingredient) => ({ recipeId: recipe.id, ingredient })))
              .run();
          }

          upserted += 1;
        }
      });
    }

    return upserted;
  });
}

export type RecipeTagCandidate = {
  recipeId: string;
  matchedTags: string[];
  tagScore: number;
};

export type RecipeIngredientCandidate = {
  recipeId: string;
  matchedIngredients: string[];
  ingredientScore: number;
};

export function listFoodComTags(): string[] {
  return withDatabase((db) => db.selectDistinct({ tag: foodComRecipeTags.tag })
    .from(foodComRecipeTags)
    .orderBy(asc(foodComRecipeTags.tag))
    .all()
    .map((row) => row.tag));
}

export function getRecipeCandidatesByTags(input: {
  requiredTags: string[];
  preferredTags: string[];
  excludedTags: string[];
  limit: number;
}): RecipeTagCandidate[] {
  const required = [...new Set(input.requiredTags.map(normalizeRecipeTag).filter(Boolean))];
  const preferred = [...new Set(input.preferredTags.map(normalizeRecipeTag).filter(Boolean))];
  const excluded = new Set(input.excludedTags.map(normalizeRecipeTag).filter(Boolean));
  const searchedTags = [...new Set([...required, ...preferred])];

  if (searchedTags.length === 0) {
    return [];
  }

  return withDatabase((db) => {
    const rows = db.select().from(foodComRecipeTags)
      .where(inArray(foodComRecipeTags.tag, searchedTags))
      .all();
    const tagsByRecipe = new Map<string, Set<string>>();

    for (const row of rows) {
      const tags = tagsByRecipe.get(row.recipeId) ?? new Set<string>();
      tags.add(row.tag);
      tagsByRecipe.set(row.recipeId, tags);
    }

    return [...tagsByRecipe.entries()]
      .flatMap(([recipeId, tags]) => {
        if (required.some((tag) => !tags.has(tag)) || [...tags].some((tag) => excluded.has(tag))) {
          return [];
        }

        const matchedTags = [...tags].sort();
        const preferredMatches = preferred.filter((tag) => tags.has(tag)).length;
        return [{
          recipeId,
          matchedTags,
          tagScore: (required.length + preferredMatches) / Math.max(1, required.length + preferred.length),
        }];
      })
      .sort((left, right) => right.tagScore - left.tagScore || left.recipeId.localeCompare(right.recipeId))
      .slice(0, input.limit);
  });
}

export function getRecipeCandidatesByIngredients(input: {
  ingredients: string[];
  limit: number;
}): RecipeIngredientCandidate[] {
  const ingredients = [...new Set(input.ingredients.map(normalizeIngredientName).filter(Boolean))];

  if (ingredients.length === 0) {
    return [];
  }

  return withDatabase((db) => {
    const values = sql.join(ingredients.map((ingredient) => sql`${ingredient}`), sql`, `);
    const rows = db.all<{
      recipeId: string;
      matchedIngredients: string;
    }>(sql`
      select recipe_id as recipeId, group_concat(ingredient, char(31)) as matchedIngredients
      from food_com_recipe_ingredients
      where ingredient in (${values})
      group by recipe_id
      order by count(*) desc, recipe_id asc
      limit ${input.limit}
    `);

    return rows.map((row) => {
      const matchedIngredients = row.matchedIngredients.split(String.fromCharCode(31)).sort();
      return {
        recipeId: row.recipeId,
        matchedIngredients,
        ingredientScore: matchedIngredients.length / ingredients.length,
      };
    });
  });
}

export function rebuildFoodComRecipeTagIndex(): number {
  return withDatabase((db) => db.transaction((transaction) => {
    const rows = transaction.select().from(foodComRecipes).all();
    transaction.delete(foodComRecipeTags).run();
    let count = 0;

    for (const row of rows) {
      const tags = [...new Set(parseStringArray(row.tagsJson, "tags", row.id)
        .map(normalizeRecipeTag)
        .filter(Boolean))];
      if (tags.length === 0) {
        continue;
      }
      transaction.insert(foodComRecipeTags)
        .values(tags.map((tag) => ({ recipeId: row.id, tag })))
        .run();
      count += tags.length;
    }

    return count;
  }));
}

export function rebuildFoodComRecipeIngredientIndex(): number {
  return withDatabase((db) => db.transaction((transaction) => {
    const rows = transaction.select().from(foodComRecipes).all();
    transaction.delete(foodComRecipeIngredients).run();
    let count = 0;

    for (const row of rows) {
      const ingredients = [...new Set(parseIngredients(row.ingredientsJson, row.id)
        .map((ingredient) => normalizeIngredientName(ingredient.canonicalName))
        .filter(Boolean))];
      if (ingredients.length === 0) {
        continue;
      }
      transaction.insert(foodComRecipeIngredients)
        .values(ingredients.map((ingredient) => ({ recipeId: row.id, ingredient })))
        .run();
      count += ingredients.length;
    }

    return count;
  }));
}

export function rebuildFoodComRecipeMetadataIndexes(): {
  tags: number;
  ingredients: number;
} {
  return withDatabase((db) => db.transaction((transaction) => {
    const rows = transaction.select().from(foodComRecipes).all();
    transaction.delete(foodComRecipeTags).run();
    transaction.delete(foodComRecipeIngredients).run();
    let tags = 0;
    let ingredients = 0;

    for (const row of rows) {
      const recipeTags = [...new Set(parseStringArray(row.tagsJson, "tags", row.id)
        .map(normalizeRecipeTag)
        .filter(Boolean))];
      const recipeIngredients = [...new Set(parseIngredients(row.ingredientsJson, row.id)
        .map((ingredient) => normalizeIngredientName(ingredient.canonicalName))
        .filter(Boolean))];

      if (recipeTags.length > 0) {
        transaction.insert(foodComRecipeTags)
          .values(recipeTags.map((tag) => ({ recipeId: row.id, tag })))
          .run();
        tags += recipeTags.length;
      }

      if (recipeIngredients.length > 0) {
        transaction.insert(foodComRecipeIngredients)
          .values(recipeIngredients.map((ingredient) => ({ recipeId: row.id, ingredient })))
          .run();
        ingredients += recipeIngredients.length;
      }
    }

    return { tags, ingredients };
  }));
}

export function getRecipeById(recipeId: string): Recipe | null {
  const id = recipeId.trim();

  if (!id) {
    return null;
  }

  return withDatabase((db) => {
    const row = db.select().from(foodComRecipes).where(inArray(foodComRecipes.id, [id])).get();
    return row ? rowToRecipe(row) : null;
  });
}

export function getRecipesByIds(recipeIds: string[]): Recipe[] {
  const ids = [...new Set(recipeIds.map((recipeId) => recipeId.trim()).filter(Boolean))];

  if (ids.length === 0) {
    return [];
  }

  return withDatabase((db) => {
    const recipesById = new Map(
      db.select().from(foodComRecipes).where(inArray(foodComRecipes.id, ids)).all()
        .map((row) => [row.id, rowToRecipe(row)]),
    );

    return ids.flatMap((id) => {
      const recipe = recipesById.get(id);
      return recipe ? [recipe] : [];
    });
  });
}

export const recipeRepository = {
  getById: getRecipeById,
  getMany: getRecipesByIds,
  getCandidatesByTags: getRecipeCandidatesByTags,
  getCandidatesByIngredients: getRecipeCandidatesByIngredients,
  listTags: listFoodComTags,
  rebuildTagIndex: rebuildFoodComRecipeTagIndex,
  rebuildIngredientIndex: rebuildFoodComRecipeIngredientIndex,
  rebuildMetadataIndexes: rebuildFoodComRecipeMetadataIndexes,
  upsert: upsertRecipes,
};
