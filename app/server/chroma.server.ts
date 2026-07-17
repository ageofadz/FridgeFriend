import { ChromaClient, ChromaUniqueError } from "chromadb";

import { optionalEnv } from "./env.server";

const DEFAULT_CHROMA_HOST = "127.0.0.1";
const DEFAULT_CHROMA_PORT = "8000";
const DEFAULT_CHROMA_PATH = ".data/chroma";
const DEFAULT_CHROMA_TENANT = "default_tenant";
const DEFAULT_CHROMA_DATABASE = "default_database";

const COLLECTION_NAME = "fridgefriend_foundation";
const MEMORY_COLLECTION_NAME = "fridgefriend_memory";
const RECIPE_COLLECTION_NAME = "fridgefriend_recipes";

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

export function getChromaTenant() {
  return optionalEnv("CHROMA_TENANT") ?? DEFAULT_CHROMA_TENANT;
}

export function getChromaDatabase() {
  return optionalEnv("CHROMA_DATABASE") ?? DEFAULT_CHROMA_DATABASE;
}

async function ensureCollection(client: ChromaClient, name: string) {
  try {
    await client.createCollection({
      name,
      embeddingFunction: null,
    });
  } catch (error) {
    if (error instanceof ChromaUniqueError) {
      return;
    }

    throw error;
  }
}

function chromaApiBaseUrl(url: string) {
  return url.replace(/\/+$/, "");
}

async function getCollectionId(url: string, name: string) {
  const endpoint = [
    chromaApiBaseUrl(url),
    "api/v2/tenants",
    encodeURIComponent(getChromaTenant()),
    "databases",
    encodeURIComponent(getChromaDatabase()),
    "collections",
    encodeURIComponent(name),
  ].join("/");
  const response = await fetch(endpoint);

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Chroma collection ${name} lookup failed with ${response.status}: ${text}`);
  }

  const payload = await response.json() as unknown;

  if (
    typeof payload !== "object" ||
    payload === null ||
    !("id" in payload) ||
    typeof payload.id !== "string"
  ) {
    throw new Error(`Chroma collection ${name} lookup returned no collection id`);
  }

  return payload.id;
}

export function getChromaPath() {
  return optionalEnv("CHROMA_PATH") ?? DEFAULT_CHROMA_PATH;
}

export function getChromaUrl() {
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
    await ensureCollection(client, name);
    const collectionId = await getCollectionId(url, name);

    return {
      url,
      path,
      collection: name,
      client,
      handle: client.collection(collectionId),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Chroma connection failed for ${url} using ${path}: ${message}`);
  }
}

export async function getFoundationCollection() {
  return getCollection(COLLECTION_NAME);
}

export async function getMemoryCollection() {
  return getCollection(MEMORY_COLLECTION_NAME);
}

export async function getRecipeCollection() {
  return getCollection(RECIPE_COLLECTION_NAME);
}
