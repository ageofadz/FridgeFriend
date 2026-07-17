import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import type { Recipe, RecipeIngredient, RecipeNutrition, RecipeRating } from "./types";

export type DemoCorpusFile = {
  digest: string;
  recipes: Recipe[];
};

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Demo recipe corpus is invalid: ${label} must be an object`);
  }

  return value as Record<string, unknown>;
}

function string(value: unknown, label: string) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Demo recipe corpus is invalid: ${label} must be a non-empty string`);
  }

  return value;
}

function finiteNumber(value: unknown, label: string) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Demo recipe corpus is invalid: ${label} must be a finite number`);
  }

  return value;
}

function stringArray(value: unknown, label: string) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`Demo recipe corpus is invalid: ${label} must be an array of strings`);
  }

  return value;
}

function nullableNumber(value: unknown, label: string) {
  return value === null ? null : finiteNumber(value, label);
}

function ingredients(value: unknown, label: string): RecipeIngredient[] {
  if (!Array.isArray(value)) {
    throw new Error(`Demo recipe corpus is invalid: ${label} must be an array`);
  }

  return value.map((entry, index) => {
    const ingredient = record(entry, `${label}[${index}]`);

    return {
      rawName: string(ingredient.rawName, `${label}[${index}].rawName`),
      canonicalName: string(ingredient.canonicalName, `${label}[${index}].canonicalName`),
    };
  });
}

function nutrition(value: unknown, label: string): RecipeNutrition {
  const parsed = record(value, label);

  return {
    calories: nullableNumber(parsed.calories, `${label}.calories`),
    totalFatDailyValue: nullableNumber(parsed.totalFatDailyValue, `${label}.totalFatDailyValue`),
    sugarDailyValue: nullableNumber(parsed.sugarDailyValue, `${label}.sugarDailyValue`),
    sodiumDailyValue: nullableNumber(parsed.sodiumDailyValue, `${label}.sodiumDailyValue`),
    proteinDailyValue: nullableNumber(parsed.proteinDailyValue, `${label}.proteinDailyValue`),
    saturatedFatDailyValue: nullableNumber(parsed.saturatedFatDailyValue, `${label}.saturatedFatDailyValue`),
    carbohydratesDailyValue: nullableNumber(parsed.carbohydratesDailyValue, `${label}.carbohydratesDailyValue`),
  };
}

function rating(value: unknown, label: string): RecipeRating | null {
  if (value === null) {
    return null;
  }

  const parsed = record(value, label);

  return {
    average: finiteNumber(parsed.average, `${label}.average`),
    count: finiteNumber(parsed.count, `${label}.count`),
  };
}

function recipe(value: unknown, label: string): Recipe {
  const parsed = record(value, label);
  const minutes = finiteNumber(parsed.minutes, `${label}.minutes`);
  const stepCount = finiteNumber(parsed.stepCount, `${label}.stepCount`);
  const ingredientCount = finiteNumber(parsed.ingredientCount, `${label}.ingredientCount`);

  if (!Number.isInteger(minutes) || minutes <= 0 || !Number.isInteger(stepCount) || stepCount <= 0 || !Number.isInteger(ingredientCount) || ingredientCount <= 0) {
    throw new Error(`Demo recipe corpus is invalid: ${label} has invalid recipe counts`);
  }

  return {
    id: string(parsed.id, `${label}.id`),
    name: string(parsed.name, `${label}.name`),
    description: parsed.description === null ? null : string(parsed.description, `${label}.description`),
    ingredients: ingredients(parsed.ingredients, `${label}.ingredients`),
    tags: stringArray(parsed.tags, `${label}.tags`),
    steps: stringArray(parsed.steps, `${label}.steps`),
    minutes,
    stepCount,
    ingredientCount,
    nutrition: nutrition(parsed.nutrition, `${label}.nutrition`),
    rating: rating(parsed.rating, `${label}.rating`),
  };
}

function parseDemoCorpusFile(source: string): DemoCorpusFile {
  let parsed: unknown;

  try {
    parsed = JSON.parse(source);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Demo recipe corpus is invalid JSON: ${message}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error("Demo recipe corpus is invalid: root value must be an array");
  }

  const recipes = parsed.map((entry, index) => recipe(record(entry, `recipes[${index}]`).recipe, `recipes[${index}].recipe`));
  const ids = new Set(recipes.map((entry) => entry.id));

  if (recipes.length === 0 || ids.size !== recipes.length) {
    throw new Error("Demo recipe corpus is invalid: recipes must be non-empty and have unique ids");
  }

  return {
    digest: createHash("sha256").update(source).digest("hex"),
    recipes,
  };
}

export async function loadDemoCorpusFile(filePath: string) {
  let source: string;

  try {
    source = await readFile(filePath, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Demo recipe corpus could not be read from ${filePath}: ${message}`);
  }

  return parseDemoCorpusFile(source);
}
