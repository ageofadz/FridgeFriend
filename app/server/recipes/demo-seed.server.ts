import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { getRecipeCollection } from "../chroma.server";
import { getDatabasePath } from "../sqlite.server";
import { loadDemoCorpusFile, type DemoCorpusFile } from "./demo-corpus-file.server";
import { countStoredRecipes, upsertRecipes } from "./repository.server";
import { indexRecipesInChroma } from "./vector-store.server";

const MARKER_VERSION = 1;

export type DemoSeedResult = {
  indexedRecipes: number;
  status: "already-seeded" | "seeded";
  storedRecipes: number;
};

type SeedMarker = {
  corpusDigest: string;
  recipeCount: number;
  version: number;
};

export type DemoSeedDependencies = {
  countIndexedRecipes: () => Promise<number>;
  countStoredRecipes: () => number;
  databasePath: string;
  indexRecipes: (corpus: DemoCorpusFile) => Promise<number>;
  loadCorpus: () => Promise<DemoCorpusFile>;
  markerPath: string;
  readMarker: () => Promise<string>;
  sqliteFileExists: () => Promise<boolean>;
  storeRecipes: (corpus: DemoCorpusFile) => number;
  writeMarker: (source: string) => Promise<void>;
};

function resetInstruction(markerPath: string) {
  return `Remove the FridgeFriend Compose volumes with docker compose down -v before trying again. Seed marker: ${markerPath}`;
}

export function serializeSeedMarker(corpus: DemoCorpusFile): string {
  const marker: SeedMarker = {
    corpusDigest: corpus.digest,
    recipeCount: corpus.recipes.length,
    version: MARKER_VERSION,
  };

  return `${JSON.stringify(marker)}\n`;
}

function parseMarker(source: string, markerPath: string): SeedMarker {
  let parsed: unknown;

  try {
    parsed = JSON.parse(source);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Demo seed marker is invalid at ${markerPath}: ${message}. ${resetInstruction(markerPath)}`);
  }

  if (
    !parsed ||
    typeof parsed !== "object" ||
    !(
      "version" in parsed &&
      "recipeCount" in parsed &&
      "corpusDigest" in parsed
    ) ||
    typeof parsed.version !== "number" ||
    typeof parsed.recipeCount !== "number" ||
    typeof parsed.corpusDigest !== "string"
  ) {
    throw new Error(`Demo seed marker is invalid at ${markerPath}. ${resetInstruction(markerPath)}`);
  }

  return parsed as SeedMarker;
}

async function exists(filePath: string) {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }

    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Demo seed could not inspect ${filePath}: ${message}`);
  }
}

export function createDemoSeedDependencies(input: {
  corpusPath: string;
  markerPath: string;
}): DemoSeedDependencies {
  return {
    countIndexedRecipes: async () => (await getRecipeCollection()).handle.count(),
    countStoredRecipes,
    databasePath: getDatabasePath(),
    indexRecipes: (corpus) => indexRecipesInChroma(corpus.recipes),
    loadCorpus: () => loadDemoCorpusFile(input.corpusPath),
    markerPath: input.markerPath,
    readMarker: () => readFile(input.markerPath, "utf8"),
    sqliteFileExists: () => exists(getDatabasePath()),
    storeRecipes: (corpus) => upsertRecipes(corpus.recipes),
    writeMarker: (source) => writeFile(input.markerPath, source, { flag: "wx" }),
  };
}

export async function seedDemoCorpus(dependencies: DemoSeedDependencies): Promise<DemoSeedResult> {
  const corpus = await dependencies.loadCorpus();
  const expectedCount = corpus.recipes.length;
  const markerExists = await exists(dependencies.markerPath);

  if (markerExists) {
    const marker = parseMarker(await dependencies.readMarker(), dependencies.markerPath);

    if (
      marker.version !== MARKER_VERSION ||
      marker.recipeCount !== expectedCount ||
      marker.corpusDigest !== corpus.digest
    ) {
      throw new Error(`Demo seed marker does not match the bundled corpus. ${resetInstruction(dependencies.markerPath)}`);
    }

    const [storedRecipes, indexedRecipes] = await Promise.all([
      dependencies.countStoredRecipes(),
      dependencies.countIndexedRecipes(),
    ]);

    if (storedRecipes !== expectedCount || indexedRecipes !== expectedCount) {
      throw new Error(
        `Demo seed state is incomplete: SQLite has ${storedRecipes}/${expectedCount} recipes and Chroma has ${indexedRecipes}/${expectedCount}. ${resetInstruction(dependencies.markerPath)}`,
      );
    }

    return { indexedRecipes, status: "already-seeded", storedRecipes };
  }

  if (await dependencies.sqliteFileExists()) {
    throw new Error(`Demo seed found SQLite data without a marker at ${dependencies.databasePath}. ${resetInstruction(dependencies.markerPath)}`);
  }

  const existingChromaRecipes = await dependencies.countIndexedRecipes();

  if (existingChromaRecipes !== 0) {
    throw new Error(`Demo seed found ${existingChromaRecipes} Chroma recipes without a marker. ${resetInstruction(dependencies.markerPath)}`);
  }

  const storedRecipes = dependencies.storeRecipes(corpus);
  const indexedRecipes = await dependencies.indexRecipes(corpus);
  const [storedCount, indexedCount] = await Promise.all([
    dependencies.countStoredRecipes(),
    dependencies.countIndexedRecipes(),
  ]);

  if (storedCount !== expectedCount || indexedCount !== expectedCount) {
    throw new Error(
      `Demo seed verification failed: SQLite has ${storedCount}/${expectedCount} recipes and Chroma has ${indexedCount}/${expectedCount}. ${resetInstruction(dependencies.markerPath)}`,
    );
  }

  await dependencies.writeMarker(serializeSeedMarker(corpus));

  return { indexedRecipes, status: "seeded", storedRecipes };
}

export function demoSeedPaths() {
  const corpusPath = process.env.DEMO_CORPUS_PATH ?? path.resolve("demo-corpus/recipes.json");
  const markerPath = process.env.DEMO_SEED_MARKER_PATH ?? path.join(path.dirname(getDatabasePath()), "demo-corpus.seed.json");

  return { corpusPath, markerPath };
}
