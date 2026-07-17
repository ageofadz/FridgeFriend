import {
  GoogleGenerativeAI,
  TaskType,
  type EmbedContentRequest,
} from "@google/generative-ai";
import type { Metadata, Where } from "chromadb";

import { getMemoryCollection, normalizeEmbedding } from "../chroma.server";
import { requiredEnv } from "../env.server";
import type { SemanticMemory } from "./schemas";

// gemini-embedding-001 is the valid Gemini embedding model (the previously
// configured "gemini-embedding-2" does not exist). We keep 768 dimensions — a
// supported Matryoshka output size requested via outputDimensionality — so
// existing `fridgefriend_memory` collections indexed with 768-dim vectors stay
// compatible; a Chroma collection's dimensionality is fixed by its first
// insert. Truncated (non-3072) gemini-embedding-001 vectors are not
// unit-length, so we L2-normalize them before indexing and querying.
const MEMORY_EMBEDDING_MODEL = "gemini-embedding-001";
export const MEMORY_EMBEDDING_DIMENSIONS = 768;

type MemoryEmbedContentRequest = EmbedContentRequest & {
  outputDimensionality: number;
};

type MemoryMetadata = Metadata & {
  documentType: "memory";
  scopeType: "user" | "fridge";
  scopeId: string;
  category: string;
  memoryId: string;
  active: boolean;
};

export type SemanticMemorySearchInput = {
  query: string;
  userId: string;
  fridgeId: string;
  limit: number;
};

type MemoryCollectionHandle = {
  upsert(input: {
    ids: string[];
    embeddings: number[][];
    documents: string[];
    metadatas: MemoryMetadata[];
  }): Promise<void>;
  query<TMetadata extends Metadata>(input: {
    queryEmbeddings: number[][];
    nResults: number;
    where: Where;
    include: ["metadatas", "distances"];
  }): Promise<{
    rows(): Array<Array<{
      metadata?: TMetadata | null;
      distance?: number | null;
    }>>;
  }>;
};

type MemoryCollection = {
  handle: MemoryCollectionHandle;
};

export type MemoryVectorStoreDependencies = {
  embedText?: (text: string, taskType: TaskType) => Promise<number[] | undefined>;
  getCollection?: () => Promise<MemoryCollection>;
};

function createMemoryEmbedder() {
  const model = new GoogleGenerativeAI(requiredEnv("GOOGLE_API_KEY")).getGenerativeModel({
    model: MEMORY_EMBEDDING_MODEL,
  });

  return async (text: string, taskType: TaskType) => {
    const request: MemoryEmbedContentRequest = {
      content: { role: "user", parts: [{ text: text.replace(/\n/g, " ") }] },
      taskType,
      outputDimensionality: MEMORY_EMBEDDING_DIMENSIONS,
    };
    const response = await model.embedContent(request);
    return response.embedding.values;
  };
}

function collectionLoader(dependencies: MemoryVectorStoreDependencies) {
  return dependencies.getCollection ?? (getMemoryCollection as () => Promise<MemoryCollection>);
}

async function embedMemoryText(
  text: string,
  taskType: TaskType,
  label: string,
  dependencies: MemoryVectorStoreDependencies,
) {
  const embedText = dependencies.embedText ?? createMemoryEmbedder();
  const values = await embedText(text, taskType);

  return normalizeEmbedding(values, MEMORY_EMBEDDING_DIMENSIONS, label);
}

function metadataForMemory(memory: SemanticMemory): MemoryMetadata {
  return {
    documentType: "memory",
    scopeType: memory.namespaceType,
    scopeId: memory.namespaceId,
    category: memory.category,
    memoryId: memory.id,
    active: memory.active,
  };
}

export async function indexSemanticMemory(
  memory: SemanticMemory,
  dependencies: MemoryVectorStoreDependencies = {},
) {
  try {
    const embedding = await embedMemoryText(
      memory.content,
      TaskType.RETRIEVAL_DOCUMENT,
      `Memory ${memory.id}`,
      dependencies,
    );
    const collection = await collectionLoader(dependencies)();

    await collection.handle.upsert({
      ids: [memory.id],
      embeddings: [embedding],
      documents: [memory.content],
      metadatas: [metadataForMemory(memory)],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Memory Chroma indexing failed for ${memory.id}: ${message}`);
  }
}

function scopeWhere(input: Pick<SemanticMemorySearchInput, "userId" | "fridgeId">): Where {
  return {
    $and: [
      { documentType: "memory" },
      { active: true },
      {
        $or: [
          { scopeType: "user", scopeId: input.userId },
          { scopeType: "fridge", scopeId: input.fridgeId },
        ],
      },
    ],
  };
}

export async function searchSemanticMemoryIds(
  input: SemanticMemorySearchInput,
  dependencies: MemoryVectorStoreDependencies = {},
) {
  const query = input.query.trim();

  if (query.length === 0) {
    return [];
  }

  try {
    const collection = await collectionLoader(dependencies)();
    const queryEmbedding = await embedMemoryText(
      query,
      TaskType.RETRIEVAL_QUERY,
      "Memory query",
      dependencies,
    );
    const results = await collection.handle.query<MemoryMetadata>({
      queryEmbeddings: [queryEmbedding],
      nResults: input.limit,
      where: scopeWhere(input),
      include: ["metadatas", "distances"],
    });

    const seen = new Set<string>();

    return [...results.rows()[0] ?? []]
      .sort((left, right) => (left.distance ?? 0) - (right.distance ?? 0))
      .flatMap((row) => {
        const memoryId = row.metadata?.memoryId;

        if (!memoryId || seen.has(memoryId)) {
          return [];
        }

        seen.add(memoryId);
        return [memoryId];
      })
      .slice(0, input.limit);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Memory Chroma search failed: ${message}`);
  }
}
