import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadDemoCorpusFile } from "../../../../app/server/recipes/demo-corpus-file.server";
import {
  seedDemoCorpus,
  type DemoSeedDependencies,
} from "../../../../app/server/recipes/demo-seed.server";

const corpus = JSON.stringify([{
  coverage: {},
  recipe: {
    id: "recipe-1",
    name: "Demo Recipe",
    description: "A complete demo recipe.",
    ingredients: [
      { rawName: "chicken breast", canonicalName: "chicken breast" },
      { rawName: "rice", canonicalName: "rice" },
      { rawName: "spinach", canonicalName: "spinach" },
    ],
    tags: ["main dish"],
    steps: ["Cook the chicken."],
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
  },
}]);

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function dependencies() {
  const directory = await mkdtemp(path.join(tmpdir(), "fridgefriend-demo-seed-"));
  directories.push(directory);
  const corpusPath = path.join(directory, "recipes.json");
  const markerPath = path.join(directory, "demo-corpus.seed.json");
  await writeFile(corpusPath, corpus);
  let stored = 0;
  let indexed = 0;

  const value: DemoSeedDependencies = {
    countIndexedRecipes: async () => indexed,
    countStoredRecipes: () => stored,
    databasePath: path.join(directory, "fridgefriend.sqlite"),
    indexRecipes: async (loaded) => {
      indexed = loaded.recipes.length;
      return indexed;
    },
    loadCorpus: () => loadDemoCorpusFile(corpusPath),
    markerPath,
    readMarker: () => readFile(markerPath, "utf8"),
    sqliteFileExists: async () => false,
    storeRecipes: (loaded) => {
      stored = loaded.recipes.length;
      return stored;
    },
    writeMarker: (source) => writeFile(markerPath, source, { flag: "wx" }),
  };

  return { value, setIndexed: (count: number) => { indexed = count; } };
}

describe("demo corpus seed", () => {
  it("seeds once and validates the matching marker without re-indexing", async () => {
    const { value } = await dependencies();

    await expect(seedDemoCorpus(value)).resolves.toEqual({
      indexedRecipes: 1,
      status: "seeded",
      storedRecipes: 1,
    });
    await expect(seedDemoCorpus(value)).resolves.toEqual({
      indexedRecipes: 1,
      status: "already-seeded",
      storedRecipes: 1,
    });
  });

  it("rejects a marker whose Chroma count is incomplete", async () => {
    const { value, setIndexed } = await dependencies();
    await seedDemoCorpus(value);
    setIndexed(0);

    await expect(seedDemoCorpus(value)).rejects.toThrow(
      "Demo seed state is incomplete: SQLite has 1/1 recipes and Chroma has 0/1",
    );
  });

  it("rejects an invalid corpus file", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "fridgefriend-demo-corpus-"));
    directories.push(directory);
    const corpusPath = path.join(directory, "recipes.json");
    await writeFile(corpusPath, "{}\n");

    await expect(loadDemoCorpusFile(corpusPath)).rejects.toThrow(
      "Demo recipe corpus is invalid: root value must be an array",
    );
  });
});
