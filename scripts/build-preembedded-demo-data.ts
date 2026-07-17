import { access, writeFile } from "node:fs/promises";

import { getRecipeCollection } from "../app/server/chroma.server";
import { getDatabasePath } from "../app/server/sqlite.server";
import { loadDemoCorpusFile } from "../app/server/recipes/demo-corpus-file.server";
import { demoSeedPaths, serializeSeedMarker } from "../app/server/recipes/demo-seed.server";
import { countStoredRecipes, upsertRecipes } from "../app/server/recipes/repository.server";
import { indexRecipesInChroma } from "../app/server/recipes/vector-store.server";

async function fileExists(filePath: string) {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

async function main() {
  const { corpusPath, markerPath } = demoSeedPaths();
  const corpus = await loadDemoCorpusFile(corpusPath);
  const expectedCount = corpus.recipes.length;

  if (await fileExists(markerPath)) {
    throw new Error(`Prebuilt demo marker already exists at ${markerPath}. Create prebuilt data in an empty directory.`);
  }

  const storedRecipes = countStoredRecipes();

  if (storedRecipes !== 0 && storedRecipes !== expectedCount) {
    throw new Error(`Prebuilt SQLite has ${storedRecipes}/${expectedCount} recipes at ${getDatabasePath()}. Create prebuilt data in an empty directory.`);
  }

  if (storedRecipes === 0) {
    upsertRecipes(corpus.recipes);
  }

  const collection = await getRecipeCollection();
  const indexedBefore = await collection.handle.count();

  if (indexedBefore > expectedCount) {
    throw new Error(`Prebuilt Chroma has ${indexedBefore}/${expectedCount} recipes. Create prebuilt data in an empty directory.`);
  }

  await indexRecipesInChroma(corpus.recipes);

  const [storedCount, indexedCount] = await Promise.all([
    Promise.resolve(countStoredRecipes()),
    collection.handle.count(),
  ]);

  if (storedCount !== expectedCount || indexedCount !== expectedCount) {
    throw new Error(`Prebuilt demo verification failed: SQLite has ${storedCount}/${expectedCount} recipes and Chroma has ${indexedCount}/${expectedCount}.`);
  }

  await writeFile(markerPath, serializeSeedMarker(corpus), { flag: "wx" });
  process.stdout.write(`Prebuilt demo data ready: SQLite recipes ${storedCount}, Chroma recipes ${indexedCount}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
