import {
  createDemoSeedDependencies,
  demoSeedPaths,
  seedDemoCorpus,
} from "../app/server/recipes/demo-seed.server";

async function main() {
  const paths = demoSeedPaths();
  const result = await seedDemoCorpus(createDemoSeedDependencies(paths));
  process.stdout.write(
    `Demo recipe corpus ${result.status}: SQLite recipes ${result.storedRecipes}, Chroma recipes ${result.indexedRecipes}\n`,
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
