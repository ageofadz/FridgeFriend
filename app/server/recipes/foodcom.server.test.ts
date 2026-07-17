import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  assertFoodComDataset,
  buildFoodComRetrievalDocument,
  loadFoodComRecipes,
} from "./foodcom.server";
import { indexFoodComRecipes } from "./indexing.server";
import {
  getRecipeCandidatesByIngredients,
  getRecipesByIds,
  upsertRecipes,
} from "./repository.server";
import {
  indexRecipesInChroma,
  searchRecipeCandidates,
} from "./vector-store.server";
import type { Recipe } from "./types";

const recipeHeaders = [
  "name",
  "id",
  "minutes",
  "contributor_id",
  "submitted",
  "tags",
  "nutrition",
  "n_steps",
  "steps",
  "description",
  "ingredients",
  "n_ingredients",
];

const interactionHeaders = ["user_id", "recipe_id", "date", "rating", "review"];

function csv(rows: string[][]) {
  return rows
    .map((row) => row.map((value) => `"${value.replaceAll('"', '""')}"`).join(","))
    .join("\n");
}

function recipeRow(input: {
  id: string;
  name: string;
  minutes: number;
  tags?: string;
  nutrition?: string;
  steps?: string;
  description?: string;
  ingredients?: string;
}) {
  return [
    input.name,
    input.id,
    String(input.minutes),
    "10",
    "2020-01-01",
    input.tags ?? "['main-dish']",
    input.nutrition ?? "[500.0, 5.0, 2.0, 3.0, 20.0, 1.0, 30.0]",
    "2",
    input.steps ?? "['Saute the chicken.', 'Simmer with spinach.']",
    input.description ?? "A quick chicken pasta dinner.",
    input.ingredients ?? "['boneless skinless chicken breasts', 'spinach', 'pasta']",
    "3",
  ];
}

async function writeFixtureDataset(dataDir: string) {
  await writeFile(
    path.join(dataDir, "RAW_recipes.csv"),
    csv([
      recipeHeaders,
      recipeRow({
        id: "2",
        name: "Chicken Spinach Pasta",
        minutes: 25,
        tags: "['main-dish', 'time-to-make', '30-minutes-or-less']",
      }),
      recipeRow({
        id: "1",
        name: "Chickpea Stew",
        minutes: 35,
        ingredients: "['garbanzo beans', 'tomatoes', 'onions']",
        steps: "['Boil the tomatoes.', 'Simmer the chickpeas.']",
        description: "A simple chickpea dinner.",
      }),
      recipeRow({
        id: "3",
        name: "Slow Dish",
        minutes: 181,
      }),
      recipeRow({
        id: "368257",
        name: "",
        minutes: 20,
      }),
    ]),
  );
  await writeFile(
    path.join(dataDir, "RAW_interactions.csv"),
    csv([
      interactionHeaders,
      ["u1", "1", "2020-01-01", "5", "great"],
      ["u2", "1", "2020-01-02", "4", "good"],
      ["u3", "2", "2020-01-03", "5", "great"],
      ["u4", "3", "2020-01-04", "5", "slow"],
    ]),
  );
}

function sampleRecipe(id: string): Recipe {
  return {
    id,
    name: `Recipe ${id}`,
    description: "A recipe description.",
    ingredients: [
      { rawName: "chicken breasts", canonicalName: "chicken breast" },
      { rawName: "spinach", canonicalName: "spinach" },
      { rawName: "pasta", canonicalName: "pasta" },
    ],
    tags: ["main dish"],
    steps: ["Saute the chicken."],
    minutes: 30,
    stepCount: 1,
    ingredientCount: 3,
    nutrition: {
      calories: 500,
      totalFatDailyValue: 5,
      sugarDailyValue: 2,
      sodiumDailyValue: 3,
      proteinDailyValue: 20,
      saturatedFatDailyValue: 1,
      carbohydratesDailyValue: 30,
    },
    rating: { average: 4.5, count: 12 },
  };
}

describe("Food.com recipe corpus", () => {
  let dataDir: string;
  let databasePath: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), "fridgefriend-foodcom-"));
    databasePath = path.join(tmpdir(), `fridgefriend-foodcom-${randomUUID()}.sqlite`);
    process.env.DATABASE_PATH = databasePath;
    await writeFixtureDataset(dataDir);
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
    await rm(databasePath, { force: true });
    await rm(`${databasePath}-wal`, { force: true });
    await rm(`${databasePath}-shm`, { force: true });
    delete process.env.DATABASE_PATH;
  });

  it("parses serialized Food.com fields, aggregates ratings, normalizes ingredients, and selects deterministically", async () => {
    const recipes = await loadFoodComRecipes({ dataDir, limit: 20_000 });

    expect(recipes.map((recipe) => recipe.id)).toEqual(["1", "2"]);
    expect(recipes[0]).toMatchObject({
      id: "1",
      rating: { average: 4.5, count: 2 },
      ingredients: [
        { rawName: "garbanzo beans", canonicalName: "chickpea" },
        { rawName: "tomatoes", canonicalName: "tomato" },
        { rawName: "onions", canonicalName: "onion" },
      ],
    });
    expect(recipes[1].ingredients[0]).toEqual({
      rawName: "boneless skinless chicken breasts",
      canonicalName: "chicken breast",
    });
    expect(buildFoodComRetrievalDocument(recipes[1])).toBe(
      "Recipe: Chicken Spinach Pasta\nDescription: A quick chicken pasta dinner.\nIngredients: chicken breast, spinach, pasta\nTags: main dish, 30 minutes or less\nCooking methods: saute, simmer",
    );
  });

  it("indexes normalized canonical ingredients for deterministic inventory retrieval", async () => {
    const recipes = await loadFoodComRecipes({ dataDir });
    upsertRecipes(recipes);

    expect(getRecipeCandidatesByIngredients({
      ingredients: ["garbanzo beans", "onions"],
      limit: 10,
    })).toEqual([{
      recipeId: "1",
      matchedIngredients: ["chickpea", "onion"],
      ingredientScore: 1,
    }]);
  });

  it("fails with a specific input error when either required file is unavailable", async () => {
    await rm(path.join(dataDir, "RAW_recipes.csv"));

    await expect(assertFoodComDataset(dataDir)).rejects.toThrow(
      `Food.com dataset input is invalid: RAW_recipes.csv is missing or unreadable in ${dataDir}. Expected readable RAW_recipes.csv and RAW_interactions.csv.`,
    );
  });

  it("upserts canonical recipes and Chroma documents idempotently", async () => {
    const documents = new Map<string, string>();
    const embeddedBatches: string[][] = [];
    const embeddings = {
      embedDocuments: async (values: string[]) => {
        embeddedBatches.push(values);
        return values.map((_, index) => [index + 1]);
      },
      embedQuery: async () => [1],
    };
    const collection = {
      handle: {
        get: async (input: {
          ids: string[];
        }) => ({
          ids: input.ids.filter((id) => documents.has(id)),
        }),
        upsert: async (input: {
          ids: string[];
          documents: string[];
        }) => {
          input.ids.forEach((id, index) => {
            documents.set(id, input.documents[index] ?? "");
          });
        },
        query: async () => ({ rows: () => [] }),
      },
    };

    const first = await indexFoodComRecipes({
      dataDir,
      vectorStoreDependencies: {
        embeddings,
        getCollection: async () => collection as never,
      },
    });
    const second = await indexFoodComRecipes({
      dataDir,
      vectorStoreDependencies: {
        embeddings,
        getCollection: async () => collection as never,
      },
    });

    expect(first).toEqual({
      selectedRecipes: 2,
      storedRecipes: 2,
      indexedDocuments: 2,
      skippedDocuments: [],
    });
    expect(second).toEqual({
      selectedRecipes: 2,
      storedRecipes: 2,
      indexedDocuments: 0,
      skippedDocuments: [],
    });
    expect(getRecipesByIds(["2", "1"]).map((recipe) => recipe.id)).toEqual(["2", "1"]);
    expect(documents.size).toBe(2);
    expect(documents.get("2")).toContain("Ingredients: chicken breast, spinach, pasta");
    expect(embeddedBatches).toHaveLength(1);
  });

  it("indexes retrieval metadata and returns sorted semantic candidates with higher scores first", async () => {
    const upserts: Array<{
      ids: string[];
      metadatas: Array<Record<string, unknown>>;
    }> = [];
    const collection = {
      handle: {
        get: async () => ({ ids: [] }),
        upsert: async (input: {
          ids: string[];
          metadatas: Array<Record<string, unknown>>;
        }) => {
          upserts.push(input);
        },
        query: async () => ({
          rows: () => [[
            { metadata: { recipeId: "b" }, distance: 1 },
            { metadata: { recipeId: "a" }, distance: 0 },
          ]],
        }),
      },
    };
    const embeddings = {
      embedDocuments: async (values: string[]) => values.map(() => [1]),
      embedQuery: async () => [1],
    };

    expect(await indexRecipesInChroma([sampleRecipe("a")], {
      embeddings,
      getCollection: async () => collection as never,
    })).toBe(1);
    expect(upserts[0]?.metadatas[0]).toMatchObject({
      documentType: "recipe",
      recipeId: "a",
      minutes: 30,
      calories: 500,
      proteinDailyValue: 20,
      averageRating: 4.5,
      ratingCount: 12,
    });
    await expect(searchRecipeCandidates({ query: "quick chicken dinner", limit: 30 }, {
      embeddings,
      getCollection: async () => collection as never,
    })).resolves.toEqual([
      { recipeId: "a", semanticScore: 1 },
      { recipeId: "b", semanticScore: 0.5 },
    ]);
  });

  it("skips existing Chroma recipe IDs before embedding missing recipes", async () => {
    const upserts: Array<{
      ids: string[];
      documents: string[];
    }> = [];
    const embedInputs: string[][] = [];
    const collection = {
      handle: {
        get: async (input: {
          ids: string[];
        }) => ({
          ids: input.ids.filter((id) => id === "a"),
        }),
        upsert: async (input: {
          ids: string[];
          documents: string[];
        }) => {
          upserts.push(input);
        },
        query: async () => ({ rows: () => [] }),
      },
    };
    const embeddings = {
      embedDocuments: async (values: string[]) => {
        embedInputs.push(values);
        return values.map(() => [1]);
      },
      embedQuery: async () => [1],
    };

    expect(await indexRecipesInChroma([sampleRecipe("a"), sampleRecipe("b")], {
      embeddings,
      getCollection: async () => collection as never,
    })).toBe(1);
    expect(upserts.map((upsert) => upsert.ids)).toEqual([["b"]]);
    expect(embedInputs).toHaveLength(1);
    expect(embedInputs[0]?.[0]).toContain("Recipe: Recipe b");
  });

  it("skips invalid embedding vectors without dropping valid recipes in the same batch", async () => {
    const skipped: Array<{
      recipeId: string;
      reason: string;
    }> = [];
    const upserts: Array<{
      ids: string[];
      embeddings: number[][];
    }> = [];
    const collection = {
      handle: {
        get: async () => ({ ids: [] }),
        upsert: async (input: {
          ids: string[];
          embeddings: number[][];
        }) => {
          upserts.push(input);
        },
        query: async () => ({ rows: () => [] }),
      },
    };
    const embeddings = {
      embedDocuments: async () => [[], [1]],
      embedQuery: async () => [1],
    };

    expect(await indexRecipesInChroma([sampleRecipe("a"), sampleRecipe("b")], {
      embeddings,
      getCollection: async () => collection as never,
      onSkippedRecipe: (skip) => skipped.push(skip),
    })).toBe(1);
    expect(skipped).toEqual([{
      recipeId: "a",
      reason: "embedding model returned an empty vector",
    }]);
    expect(upserts.map((upsert) => upsert.ids)).toEqual([["b"]]);
    expect(upserts[0]?.embeddings).toEqual([[1]]);
  });
});
