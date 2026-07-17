import { createReadStream } from "node:fs";
import { access, stat } from "node:fs/promises";
import path from "node:path";

import { buildRecipeRetrievalText, normalizeIngredientName, normalizeRecipeTag } from "./normalization";
import type { Recipe, RecipeNutrition, RecipeRatingAggregate } from "./types";

export const RAW_RECIPES_FILENAME = "RAW_recipes.csv";
export const RAW_INTERACTIONS_FILENAME = "RAW_interactions.csv";

type CsvRecord = Record<string, string>;

type RatingAccumulator = {
  sum: number;
  count: number;
};

export type FoodComDatasetFiles = {
  recipesPath: string;
  interactionsPath: string;
};

export type FoodComRecipeLoadOptions = {
  dataDir: string;
  limit?: number;
};

function inputError(dataDir: string, detail: string): Error {
  return new Error(
    `Food.com dataset input is invalid: ${detail} in ${dataDir}. Expected readable ${RAW_RECIPES_FILENAME} and ${RAW_INTERACTIONS_FILENAME}.`,
  );
}

async function assertReadableCsv(dataDir: string, filename: string) {
  const filePath = path.join(dataDir, filename);

  try {
    const details = await stat(filePath);
    await access(filePath);

    if (!details.isFile()) {
      throw inputError(dataDir, `${filename} is not a file`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Food.com dataset input is invalid:")) {
      throw error;
    }

    throw inputError(dataDir, `${filename} is missing or unreadable`);
  }

  return filePath;
}

export async function assertFoodComDataset(dataDir: string): Promise<FoodComDatasetFiles> {
  const normalizedDataDir = dataDir.trim();

  if (!normalizedDataDir) {
    throw inputError(dataDir, "data directory was empty");
  }

  const [recipesPath, interactionsPath] = await Promise.all([
    assertReadableCsv(normalizedDataDir, RAW_RECIPES_FILENAME),
    assertReadableCsv(normalizedDataDir, RAW_INTERACTIONS_FILENAME),
  ]);

  return { recipesPath, interactionsPath };
}

async function* parseCsvRows(filePath: string): AsyncGenerator<string[]> {
  const stream = createReadStream(filePath, { encoding: "utf8" });
  let field = "";
  let row: string[] = [];
  let quoted = false;
  let quotePending = false;
  let skipLineFeed = false;
  let rowHasContent = false;

  try {
    for await (const chunk of stream) {
      for (const character of chunk) {
        if (skipLineFeed) {
          skipLineFeed = false;
          if (character === "\n") {
            continue;
          }
        }

        if (quoted) {
          if (quotePending) {
            if (character === '"') {
              field += '"';
              quotePending = false;
              continue;
            }

            quoted = false;
            quotePending = false;
          } else if (character === '"') {
            quotePending = true;
            continue;
          } else {
            field += character;
            continue;
          }
        }

        if (character === '"') {
          if (field.length > 0) {
            throw new Error("quote appeared after an unquoted value");
          }

          quoted = true;
          rowHasContent = true;
          continue;
        }

        if (character === ",") {
          row.push(field);
          field = "";
          rowHasContent = true;
          continue;
        }

        if (character === "\n" || character === "\r") {
          row.push(field);
          yield row;
          field = "";
          row = [];
          rowHasContent = false;
          skipLineFeed = character === "\r";
          continue;
        }

        field += character;
        rowHasContent = true;
      }
    }

    if (quoted && !quotePending) {
      throw new Error("quoted field was not closed");
    }

    if (rowHasContent || row.length > 0 || field.length > 0) {
      row.push(field);
      yield row;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid CSV in ${filePath}: ${message}`);
  }
}

async function* parseCsvRecords(
  filePath: string,
  requiredColumns: string[] = [],
): AsyncGenerator<CsvRecord> {
  const rows = parseCsvRows(filePath);
  const headerResult = await rows.next();

  if (headerResult.done) {
    throw new Error(`Invalid CSV in ${filePath}: header row was missing`);
  }

  const headers = headerResult.value.map((header, index) =>
    index === 0 ? header.replace(/^\uFEFF/u, "").trim() : header.trim()
  );

  if (headers.some((header) => header.length === 0)) {
    throw new Error(`Invalid CSV in ${filePath}: header contained an empty column name`);
  }

  for (const column of requiredColumns) {
    if (!headers.includes(column)) {
      throw new Error(`Invalid CSV in ${filePath}: required ${column} column was missing`);
    }
  }

  let recordNumber = 1;

  for await (const row of rows) {
    recordNumber += 1;

    if (row.length !== headers.length) {
      throw new Error(
        `Invalid CSV in ${filePath}: record ${recordNumber} had ${row.length} values; expected ${headers.length}`,
      );
    }

    yield Object.fromEntries(headers.map((header, index) => [header, row[index] ?? ""]));
  }
}

function parseSerializedValue(value: string, field: string): string[] {
  const trimmed = value.trim();

  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) {
    throw new Error(`Food.com ${field} was not a serialized list`);
  }

  const values: string[] = [];
  let index = 1;

  while (index < trimmed.length - 1) {
    while (/\s/u.test(trimmed[index] ?? "")) {
      index += 1;
    }

    if (index >= trimmed.length - 1) {
      break;
    }

    let parsed = "";
    const quote = trimmed[index];

    if (quote === "'" || quote === '"') {
      index += 1;
      let closed = false;

      while (index < trimmed.length - 1) {
        const character = trimmed[index] ?? "";

        if (character === "\\") {
          const escaped = trimmed[index + 1];

          if (escaped === undefined) {
            throw new Error(`Food.com ${field} ended with an incomplete escape sequence`);
          }

          parsed += escaped;
          index += 2;
          continue;
        }

        if (character === quote) {
          closed = true;
          index += 1;
          break;
        }

        parsed += character;
        index += 1;
      }

      if (!closed) {
        throw new Error(`Food.com ${field} contained an unterminated list value`);
      }
    } else {
      while (index < trimmed.length - 1 && trimmed[index] !== ",") {
        parsed += trimmed[index] ?? "";
        index += 1;
      }

      parsed = parsed.trim();

      if (!parsed) {
        throw new Error(`Food.com ${field} contained an empty list value`);
      }
    }

    values.push(parsed);

    while (/\s/u.test(trimmed[index] ?? "")) {
      index += 1;
    }

    if (index >= trimmed.length - 1) {
      break;
    }

    if (trimmed[index] !== ",") {
      throw new Error(`Food.com ${field} expected a comma between list values`);
    }

    index += 1;
  }

  return values;
}

function parseNumber(value: string, field: string, recipeId: string): number {
  const parsed = Number(value.trim());

  if (!Number.isFinite(parsed)) {
    throw new Error(`Food.com recipe ${recipeId} had an invalid ${field}`);
  }

  return parsed;
}

function parseNullableNumber(value: string, field: string, recipeId: string): number | null {
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : parseNumber(trimmed, field, recipeId);
}

function parseNutrition(value: string, recipeId: string): RecipeNutrition {
  const nutritionValues = parseSerializedValue(value, "nutrition");

  if (nutritionValues.length !== 7) {
    throw new Error(`Food.com recipe ${recipeId} had ${nutritionValues.length} nutrition values; expected 7`);
  }

  const values = nutritionValues.map((entry, index) =>
    parseNullableNumber(entry, `nutrition[${index}]`, recipeId)
  );

  return {
    calories: values[0] ?? null,
    totalFatDailyValue: values[1] ?? null,
    sugarDailyValue: values[2] ?? null,
    sodiumDailyValue: values[3] ?? null,
    proteinDailyValue: values[4] ?? null,
    saturatedFatDailyValue: values[5] ?? null,
    carbohydratesDailyValue: values[6] ?? null,
  };
}

function requiredValue(record: CsvRecord, field: string, recipeId: string) {
  const value = record[field];

  if (value === undefined || value.trim().length === 0) {
    throw new Error(`Food.com recipe ${recipeId} was missing ${field}`);
  }

  return value;
}

function parseRecipeRecord(record: CsvRecord, ratings: Map<string, RecipeRatingAggregate>): Recipe {
  const id = requiredValue(record, "id", "unknown").trim();
  const name = requiredValue(record, "name", id).trim();
  const minutes = parseNumber(requiredValue(record, "minutes", id), "minutes", id);

  if (!Number.isInteger(minutes) || minutes < 0) {
    throw new Error(`Food.com recipe ${id} had a non-integer or negative minutes value`);
  }

  const rawIngredients = parseSerializedValue(requiredValue(record, "ingredients", id), "ingredients");
  const ingredients = rawIngredients.map((rawName) => {
    const trimmed = rawName.trim();
    const canonicalName = normalizeIngredientName(trimmed);

    if (!trimmed || !canonicalName) {
      throw new Error(`Food.com recipe ${id} contained an empty ingredient`);
    }

    return { rawName: trimmed, canonicalName };
  });
  const steps = parseSerializedValue(requiredValue(record, "steps", id), "steps")
    .map((step) => step.trim())
    .filter(Boolean);
  const tags = parseSerializedValue(requiredValue(record, "tags", id), "tags")
    .map(normalizeRecipeTag)
    .filter(Boolean);
  const description = record.description?.trim() || null;
  const rating = ratings.get(id) ?? null;

  return {
    id,
    name,
    description,
    ingredients,
    tags,
    steps,
    minutes,
    stepCount: steps.length,
    ingredientCount: ingredients.length,
    nutrition: parseNutrition(requiredValue(record, "nutrition", id), id),
    rating,
  };
}

export function isQualityRecipe(recipe: Recipe): boolean {
  return recipe.minutes > 0 &&
    recipe.minutes <= 180 &&
    recipe.ingredients.length >= 3 &&
    recipe.ingredients.length <= 30 &&
    recipe.description !== null &&
    recipe.steps.length > 0;
}

function compareRecipes(left: Recipe, right: Recipe) {
  const ratingCount = (right.rating?.count ?? 0) - (left.rating?.count ?? 0);

  if (ratingCount !== 0) {
    return ratingCount;
  }

  const ratingAverage = (right.rating?.average ?? -1) - (left.rating?.average ?? -1);

  if (ratingAverage !== 0) {
    return ratingAverage;
  }

  const minutes = left.minutes - right.minutes;

  if (minutes !== 0) {
    return minutes;
  }

  return left.id.localeCompare(right.id);
}

export function selectFoodComRecipes(recipes: Recipe[], limit?: number): Recipe[] {
  if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
    throw new Error(`Food.com recipe index limit must be a positive integer; received ${limit}`);
  }

  return recipes.filter(isQualityRecipe).sort(compareRecipes).slice(0, limit);
}

export async function aggregateFoodComRatings(interactionsPath: string): Promise<Map<string, RecipeRatingAggregate>> {
  const accumulators = new Map<string, RatingAccumulator>();

  for await (const record of parseCsvRecords(interactionsPath, ["recipe_id", "rating"])) {
    const recipeId = record.recipe_id?.trim();

    if (!recipeId) {
      throw new Error(`Food.com interactions row was missing recipe_id in ${interactionsPath}`);
    }

    const rating = parseNumber(record.rating ?? "", "rating", recipeId);

    if (rating < 0 || rating > 5) {
      throw new Error(`Food.com interaction for recipe ${recipeId} had rating outside 0-5`);
    }

    const accumulator = accumulators.get(recipeId) ?? { sum: 0, count: 0 };
    accumulator.sum += rating;
    accumulator.count += 1;
    accumulators.set(recipeId, accumulator);
  }

  return new Map(
    [...accumulators.entries()].map(([recipeId, accumulator]) => [
      recipeId,
      {
        average: accumulator.sum / accumulator.count,
        count: accumulator.count,
      },
    ]),
  );
}

export async function loadFoodComRecipes(options: FoodComRecipeLoadOptions): Promise<Recipe[]> {
  const files = await assertFoodComDataset(options.dataDir);
  const ratings = await aggregateFoodComRatings(files.interactionsPath);
  const recipes: Recipe[] = [];

  for await (const record of parseCsvRecords(files.recipesPath, [
    "id",
    "name",
    "minutes",
    "tags",
    "nutrition",
    "steps",
    "description",
    "ingredients",
  ])) {
    try {
      recipes.push(parseRecipeRecord(record, ratings));
    } catch {
      continue;
    }
  }

  if (recipes.length === 0) {
    throw new Error(`Food.com dataset input is invalid: ${RAW_RECIPES_FILENAME} contained no recipes in ${options.dataDir}.`);
  }

  return selectFoodComRecipes(recipes, options.limit);
}

export function buildFoodComRetrievalDocument(recipe: Recipe): string {
  return buildRecipeRetrievalText(recipe);
}
