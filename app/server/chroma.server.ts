import { ChromaClient } from "chromadb";

import { optionalEnv } from "./env.server";

const DEFAULT_CHROMA_HOST = "127.0.0.1";
const DEFAULT_CHROMA_PORT = "8000";
const DEFAULT_CHROMA_PATH = ".data/chroma";

const COLLECTION_NAME = "fridgefriend_foundation";

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

export async function getFoundationCollection() {
  const url = getChromaUrl();
  const path = getChromaPath();

  try {
    const client = new ChromaClient({ path: url });
    const collection = await client.getOrCreateCollection({
      name: COLLECTION_NAME,
    });

    return {
      url,
      path,
      collection: COLLECTION_NAME,
      client,
      handle: collection,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Chroma connection failed for ${url} using ${path}: ${message}`);
  }
}
