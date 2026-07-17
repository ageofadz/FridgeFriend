import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  DEFAULT_DEMO_CORPUS_COUNT,
  DEFAULT_DEMO_CORPUS_SEED,
  selectDemoRecipeCorpus,
} from "../app/server/recipes/demo-corpus.server";
import { loadFoodComRecipes } from "../app/server/recipes/foodcom.server";

type Arguments = {
  count: number;
  dataDir: string;
  outputDir: string;
  seed: string;
};

function positiveInteger(value: string | undefined, flag: string) {
  const parsed = value ? Number(value) : NaN;

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Demo recipe corpus input is invalid: ${flag} requires a positive integer`);
  }

  return parsed;
}

function requiredPath(value: string | undefined, flag: string) {
  if (!value || value.startsWith("--")) {
    throw new Error(`Demo recipe corpus input is invalid: ${flag} requires a path`);
  }

  return path.resolve(value);
}

function parseArguments(args: string[]): Arguments {
  let count = DEFAULT_DEMO_CORPUS_COUNT;
  let dataDir: string | null = null;
  let outputDir: string | null = null;
  let seed = DEFAULT_DEMO_CORPUS_SEED;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const value = args[index + 1];

    if (argument === "--count") {
      count = positiveInteger(value, "--count");
      index += 1;
      continue;
    }

    if (argument === "--data-dir") {
      if (dataDir !== null) {
        throw new Error("Demo recipe corpus input is invalid: --data-dir was provided more than once");
      }

      dataDir = requiredPath(value, "--data-dir");
      index += 1;
      continue;
    }

    if (argument === "--output-dir") {
      if (outputDir !== null) {
        throw new Error("Demo recipe corpus input is invalid: --output-dir was provided more than once");
      }

      outputDir = requiredPath(value, "--output-dir");
      index += 1;
      continue;
    }

    if (argument === "--seed") {
      if (!value || value.startsWith("--")) {
        throw new Error("Demo recipe corpus input is invalid: --seed requires a value");
      }

      seed = value;
      index += 1;
      continue;
    }

    throw new Error(`Demo recipe corpus input is invalid: unexpected argument ${argument}`);
  }

  if (dataDir === null) {
    throw new Error("Demo recipe corpus input is invalid: --data-dir <path> is required");
  }

  if (outputDir === null) {
    throw new Error("Demo recipe corpus input is invalid: --output-dir <path> is required");
  }

  return { count, dataDir, outputDir, seed };
}

function markdownReport(result: ReturnType<typeof selectDemoRecipeCorpus>) {
  const coverageRows = result.coverage
    .map((record) => `| ${record.dimension} | ${record.label} | ${record.available} | ${record.target} | ${record.selected} |`)
    .join("\n");
  const previewRows = result.recipes
    .slice(0, 100)
    .map(({ coverage, recipe }) =>
      `| ${recipe.id} | ${recipe.name.replaceAll("|", "\\|")} | ${recipe.minutes} | ${(recipe.rating?.average ?? 0).toFixed(2)} | ${coverage.course.join(", ") || "-"} | ${coverage.cuisine.join(", ") || "-"} |`
    )
    .join("\n");

  return [
    "# FridgeFriend demo recipe corpus",
    "",
    `- Selected recipes: ${result.count}`,
    `- Quality candidates: ${result.candidates}`,
    `- Seed: ${result.seed}`,
    `- Taxonomy version: ${result.taxonomyVersion}`,
    "",
    "## Coverage",
    "",
    "| Dimension | Label | Available | Target | Selected |",
    "| --- | --- | ---: | ---: | ---: |",
    coverageRows,
    "",
    "## First 100 recipes by name",
    "",
    "| ID | Name | Minutes | Rating | Course | Cuisine |",
    "| --- | --- | ---: | ---: | --- | --- |",
    previewRows,
    "",
  ].join("\n");
}

async function main() {
  const input = parseArguments(process.argv.slice(2));
  const recipes = await loadFoodComRecipes({ dataDir: input.dataDir });
  const result = selectDemoRecipeCorpus(recipes, { count: input.count, seed: input.seed });
  const recipeSource = `${JSON.stringify(result.recipes, null, 2)}\n`;
  const manifest = {
    candidateCount: result.candidates,
    recipeCount: result.count,
    recipeSha256: createHash("sha256").update(recipeSource).digest("hex"),
    seed: result.seed,
    taxonomyVersion: result.taxonomyVersion,
    version: 1,
  };

  await mkdir(input.outputDir, { recursive: true });
  await Promise.all([
    writeFile(path.join(input.outputDir, "recipes.json"), recipeSource),
    writeFile(path.join(input.outputDir, "coverage-report.json"), `${JSON.stringify({
      candidates: result.candidates,
      count: result.count,
      coverage: result.coverage,
      seed: result.seed,
      taxonomyVersion: result.taxonomyVersion,
    }, null, 2)}\n`),
    writeFile(path.join(input.outputDir, "coverage-report.md"), markdownReport(result)),
    writeFile(path.join(input.outputDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`),
  ]);

  process.stdout.write(
    `Selected ${result.count} recipes from ${result.candidates} quality candidates. Inspect ${path.join(input.outputDir, "coverage-report.md")} and ${path.join(input.outputDir, "recipes.json")}\n`,
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
