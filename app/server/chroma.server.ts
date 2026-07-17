import { ChromaClient } from "chromadb";

import { optionalEnv } from "./env.server";

const DEFAULT_CHROMA_HOST = "127.0.0.1";
const DEFAULT_CHROMA_PORT = "8000";
const DEFAULT_CHROMA_PATH = ".data/chroma";
const DEFAULT_CHROMA_TENANT = "default_tenant";
const DEFAULT_CHROMA_DATABASE = "default_database";

const MEMORY_COLLECTION_NAME = "fridgefriend_memory";
const RECIPE_COLLECTION_NAME = "fridgefriend_recipes";
const INTENT_EXAMPLE_COLLECTION_NAME = "fridgefriend_intent_examples";

function createChromaClient(url: string) {
  try {
    const parsed = new URL(url);
    const port = Number(parsed.port || (parsed.protocol === "https:" ? "443" : "80"));

    if (!Number.isInteger(port) || port <= 0) {
      throw new Error(`invalid port ${parsed.port}`);
    }

    return new ChromaClient({
      host: parsed.hostname,
      port,
      ssl: parsed.protocol === "https:",
      tenant: getChromaTenant(),
      database: getChromaDatabase(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Chroma URL is invalid: ${url}: ${message}`);
  }
}

function getChromaTenant() {
  return optionalEnv("CHROMA_TENANT") ?? DEFAULT_CHROMA_TENANT;
}

function getChromaDatabase() {
  return optionalEnv("CHROMA_DATABASE") ?? DEFAULT_CHROMA_DATABASE;
}

/**
 * L2-normalizes an embedding vector after validating its shape. Gemini
 * embedding vectors are only pre-normalized at the full 3072-dimension output,
 * so truncated outputs (for example 768 or 1536 dimensions) must be normalized
 * before they are stored or queried for cosine/L2 distances to be meaningful.
 */
export function normalizeEmbedding(
  values: number[] | undefined,
  dimensions: number,
  label: string,
) {
  if (!values) {
    throw new Error(`${label} embedding response did not include vector values`);
  }

  if (values.length !== dimensions) {
    throw new Error(`${label} embedding returned ${values.length} dimensions; expected ${dimensions}`);
  }

  if (values.some((value) => !Number.isFinite(value))) {
    throw new Error(`${label} embedding returned a non-finite numeric value`);
  }

  const magnitude = Math.hypot(...values);

  if (!Number.isFinite(magnitude) || magnitude === 0) {
    throw new Error(`${label} embedding returned a zero-length vector`);
  }

  return values.map((value) => value / magnitude);
}

function getChromaPath() {
  return optionalEnv("CHROMA_PATH") ?? DEFAULT_CHROMA_PATH;
}

function getChromaUrl() {
  const configuredUrl = optionalEnv("CHROMA_URL");
  if (configuredUrl) {
    return configuredUrl;
  }

  const host = optionalEnv("CHROMA_HOST") ?? DEFAULT_CHROMA_HOST;
  const port = optionalEnv("CHROMA_PORT") ?? DEFAULT_CHROMA_PORT;
  return `http://${host}:${port}`;
}

async function getCollection(name: string) {
  const url = getChromaUrl();
  const path = getChromaPath();

  try {
    const client = createChromaClient(url);
    // embeddingFunction is null because callers always supply pre-computed
    // vectors; getOrCreateCollection returns a handle usable for upsert/query.
    const handle = await client.getOrCreateCollection({
      name,
      embeddingFunction: null,
    });

    return {
      url,
      path,
      collection: name,
      client,
      handle,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Chroma connection failed for ${url} using ${path}: ${message}`);
  }
}

export async function getMemoryCollection() {
  return getCollection(MEMORY_COLLECTION_NAME);
}

export async function getRecipeCollection() {
  return getCollection(RECIPE_COLLECTION_NAME);
}

export async function getIntentExampleCollection() {
  return getCollection(INTENT_EXAMPLE_COLLECTION_NAME);
}
