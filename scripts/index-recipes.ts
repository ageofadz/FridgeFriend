import path from "node:path";

import { indexFoodComRecipes } from "../app/server/recipes/indexing.server";

function dataDirectoryFromArguments(args: string[]) {
  let dataDirectory: string | null = null;
  let limit: number | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];

    if (argument === "--limit") {
      const value = args[index + 1];
      const parsed = value ? Number(value) : NaN;

      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error("Food.com recipe index input is invalid: --limit requires a positive integer");
      }

      if (limit !== undefined) {
        throw new Error("Food.com recipe index input is invalid: --limit was provided more than once");
      }

      limit = parsed;
      index += 1;
      continue;
    }

    if (argument !== "--data-dir") {
      throw new Error(`Food.com recipe index input is invalid: unexpected argument ${argument}`);
    }

    const value = args[index + 1];

    if (!value || value.startsWith("--")) {
      throw new Error("Food.com recipe index input is invalid: --data-dir requires a path");
    }

    if (dataDirectory !== null) {
      throw new Error("Food.com recipe index input is invalid: --data-dir was provided more than once");
    }

    dataDirectory = value;
    index += 1;
  }

  if (dataDirectory === null) {
    throw new Error("Food.com recipe index input is invalid: --data-dir <path> is required");
  }

  return { dataDir: path.resolve(dataDirectory), limit };
}

async function main() {
  const input = dataDirectoryFromArguments(process.argv.slice(2));
  const result = await indexFoodComRecipes(input);
  process.stdout.write(
    [
      `Selected recipes: ${result.selectedRecipes}`,
      `SQLite recipes stored: ${result.storedRecipes}`,
      `Chroma recipes indexed: ${result.indexedDocuments}`,
      `Chroma recipes skipped: ${result.skippedDocuments.length}`,
    ].join("\n") + "\n",
  );

  if (result.skippedDocuments.length > 0) {
    const visibleSkips = result.skippedDocuments.slice(0, 25);

    for (const skip of visibleSkips) {
      process.stderr.write(`Skipped Food.com recipe ${skip.recipeId}: ${skip.reason}\n`);
    }

    if (result.skippedDocuments.length > visibleSkips.length) {
      process.stderr.write(
        `Skipped ${result.skippedDocuments.length - visibleSkips.length} additional Food.com recipes; rerun with existing vectors preserved after fixing the embedding provider.\n`,
      );
    }
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
