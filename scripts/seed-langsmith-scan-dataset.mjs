import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";
import { config } from "dotenv";
import { Client } from "langsmith";

config({ quiet: true });

const DEFAULT_JSONL_PATH = "examples/langsmith-fridge-image-examples.jsonl";
const DEFAULT_DATASET_NAME = "FridgeFriend scan_graph fridge-positive";
const DEFAULT_FRIDGE_ID = "dataset-fridge";
const JPEG_DATA_URL_PREFIX = "data:image/jpeg;base64,";

function argValue(name, defaultValue) {
  const prefix = `--${name}=`;
  const arg = process.argv.slice(2).find((value) => value.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : defaultValue;
}

function hasFlag(name) {
  return process.argv.slice(2).includes(`--${name}`);
}

function requiredEnv(name) {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function databasePath() {
  return process.env.DATABASE_PATH ?? ".data/fridgefriend.sqlite";
}

function readJsonlRows(filePath) {
  const content = readFileSync(filePath, "utf8");

  return content
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Invalid JSON on ${filePath}:${index + 1}: ${message}`);
      }
    });
}

function validateRow(row, index) {
  const rowNumber = index + 1;
  const imageFilename = row?.inputs?.image_filename;
  const imageDataUrl = row?.inputs?.image_data_url;

  if (typeof imageFilename !== "string" || imageFilename.length === 0) {
    throw new Error(`Row ${rowNumber} is missing inputs.image_filename`);
  }

  if (
    typeof imageDataUrl !== "string" ||
    !imageDataUrl.startsWith(JPEG_DATA_URL_PREFIX)
  ) {
    throw new Error(`Row ${rowNumber} is missing a JPEG inputs.image_data_url`);
  }

  return {
    imageFilename,
    imageDataUrl,
    metadata: row.metadata ?? {},
    outputs: row.outputs ?? {},
  };
}

function upsertSqliteImages(rows) {
  const sqlitePath = databasePath();
  const directory = path.dirname(sqlitePath);

  if (directory && directory !== ".") {
    mkdirSync(directory, { recursive: true });
  }

  const sqlite = new Database(sqlitePath);

  try {
    sqlite.pragma("journal_mode = WAL");
    sqlite.exec(`
      create table if not exists fridge_images (
        id text primary key,
        data_url text not null,
        original_name text,
        created_at text not null
      )
    `);

    const upsert = sqlite.prepare(`
      insert into fridge_images (id, data_url, original_name, created_at)
      values (@id, @dataUrl, @originalName, @createdAt)
      on conflict(id) do update set
        data_url = excluded.data_url,
        original_name = excluded.original_name
    `);
    const now = new Date().toISOString();
    const transaction = sqlite.transaction((validatedRows) => {
      for (const row of validatedRows) {
        upsert.run({
          id: row.imageFilename,
          dataUrl: row.imageDataUrl,
          originalName:
            typeof row.metadata.source_filename === "string"
              ? row.metadata.source_filename
              : row.imageFilename,
          createdAt: now,
        });
      }
    });

    transaction(rows);
  } finally {
    sqlite.close();
  }

  return sqlitePath;
}

async function getOrCreateDataset(client, datasetName) {
  try {
    return await client.readDataset({ datasetName });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (!message.includes("not found") && !message.includes("404")) {
      throw error;
    }

    return client.createDataset(datasetName, {
      description:
        "FridgeFriend scan_graph examples seeded from local image JSONL. Inputs use SQLite image IDs.",
      dataType: "kv",
      inputsSchema: {
        type: "object",
        properties: {
          fridgeId: { type: "string" },
          imageIds: {
            type: "array",
            items: { type: "string" },
          },
        },
        required: ["fridgeId", "imageIds"],
      },
    });
  }
}

async function seedLangSmithDataset(rows, options) {
  const client = new Client({
    apiKey: requiredEnv("LANGSMITH_API_KEY"),
    apiUrl: requiredEnv("LANGSMITH_ENDPOINT"),
  });
  const dataset = await getOrCreateDataset(client, options.datasetName);
  const existingImageIds = new Set();

  for await (const example of client.listExamples({
    datasetId: dataset.id,
    limit: 100,
  })) {
    const imageId = example.metadata?.imageId;

    if (typeof imageId === "string") {
      existingImageIds.add(imageId);
    }
  }

  const uploads = rows
    .filter((row) => row.metadata.split === options.split)
    .filter((row) => !existingImageIds.has(row.imageFilename))
    .map((row) => ({
      dataset_id: dataset.id,
      inputs: {
        fridgeId: options.fridgeId,
        imageIds: [row.imageFilename],
      },
      outputs: {
        isFridge: row.outputs.isFridge,
      },
      metadata: {
        ...row.metadata,
        imageId: row.imageFilename,
        source: options.jsonlPath,
      },
      split: row.metadata.split,
    }));

  if (uploads.length > 0) {
    await client.createExamples(uploads);
  }

  return {
    datasetName: options.datasetName,
    createdExamples: uploads.length,
    skippedExamples: rows.filter((row) => row.metadata.split === options.split)
      .length - uploads.length,
  };
}

const options = {
  jsonlPath: argValue("jsonl", DEFAULT_JSONL_PATH),
  datasetName: argValue("dataset", DEFAULT_DATASET_NAME),
  fridgeId: argValue("fridge-id", DEFAULT_FRIDGE_ID),
  split: argValue("split", "fridge-positive"),
  langsmith: hasFlag("langsmith"),
};
const rows = readJsonlRows(options.jsonlPath).map(validateRow);
const sqlitePath = upsertSqliteImages(rows);

process.stdout.write(
  `Seeded ${rows.length} fridge images into ${sqlitePath} using image_filename as id.\n`,
);

if (options.langsmith) {
  const result = await seedLangSmithDataset(rows, options);
  process.stdout.write(
    `LangSmith dataset ${result.datasetName}: created ${result.createdExamples}, skipped ${result.skippedExamples} existing examples.\n`,
  );
}
