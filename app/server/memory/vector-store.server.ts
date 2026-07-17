import {
  GoogleGenerativeAI,
  TaskType,
  type EmbedContentRequest,
} from "@google/generative-ai";
import type { Metadata, Where } from "chromadb";

import { getMemoryCollection } from "../chroma.server";
import { requiredEnv } from "../env.server";
import type { SemanticMemory } from "./schemas";

const MEMORY_EMBEDDING_MODEL = "gemini-embedding-2";
const MEMORY_EMBEDDING_DIMENSIONS = 768;

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

function createMemoryEmbeddingModel() {
  return new GoogleGenerativeAI(requiredEnv("GOOGLE_API_KEY")).getGenerativeModel({
    model: MEMORY_EMBEDDING_MODEL,
  });
}

function memoryEmbeddingRequest(
  text: string,
  taskType: TaskType,
): MemoryEmbedContentRequest {
  return {
    content: { role: "user", parts: [{ text: text.replace(/\n/g, " ") }] },
    taskType,
    outputDimensionality: MEMORY_EMBEDDING_DIMENSIONS,
  };
}

function assertMemoryEmbedding(values: number[] | undefined, label: string) {
  if (!values) {
    throw new Error(`${label} embedding response did not include vector values`);
  }

  if (values.length !== MEMORY_EMBEDDING_DIMENSIONS) {
    throw new Error(
      `${label} embedding returned ${values.length} dimensions; expected ${MEMORY_EMBEDDING_DIMENSIONS}`,
    );
  }

  return values;
}

async function embedMemoryText(text: string, taskType: TaskType, label: string) {
  const model = createMemoryEmbeddingModel();
  const response = await model.embedContent(memoryEmbeddingRequest(text, taskType));

  return assertMemoryEmbedding(response.embedding.values, label);
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

export async function indexSemanticMemory(memory: SemanticMemory) {
  try {
    const embedding = await embedMemoryText(
      memory.content,
      TaskType.RETRIEVAL_DOCUMENT,
      `Memory ${memory.id}`,
    );
    const collection = await getMemoryCollection();

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

function scopeWhere(scopeType: "user" | "fridge", scopeId: string): Where {
  return {
    $and: [
      { documentType: "memory" },
      { scopeType },
      { scopeId },
      { active: true },
    ],
  };
}

export async function searchSemanticMemoryIds(input: SemanticMemorySearchInput) {
  const query = input.query.trim();

  if (query.length === 0) {
    return [];
  }

  try {
    const collection = await getMemoryCollection();
    const memoryVectorCount = await collection.handle.count();

    if (memoryVectorCount === 0) {
      return [];
    }

    const queryEmbedding = await embedMemoryText(
      query,
      TaskType.RETRIEVAL_QUERY,
      "Memory query",
    );
    const [userResults, fridgeResults] = await Promise.all([
      collection.handle.query<MemoryMetadata>({
        queryEmbeddings: [queryEmbedding],
        nResults: input.limit,
        where: scopeWhere("user", input.userId),
        include: ["metadatas", "distances"],
      }),
      collection.handle.query<MemoryMetadata>({
        queryEmbeddings: [queryEmbedding],
        nResults: input.limit,
        where: scopeWhere("fridge", input.fridgeId),
        include: ["metadatas", "distances"],
      }),
    ]);

    const seen = new Set<string>();

    return [...userResults.rows()[0], ...fridgeResults.rows()[0]]
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

export async function clearMemoryEmbeddings() {
  try {
    const collection = await getMemoryCollection();
    const beforeCount = await collection.handle.count();

    if (beforeCount === 0) {
      return {
        deletedCount: 0,
        remainingCount: 0,
      };
    }

    await collection.handle.delete({
      where: {
        documentType: "memory",
      },
    });

    const remainingCount = await collection.handle.count();

    return {
      deletedCount: beforeCount - remainingCount,
      remainingCount,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Memory Chroma clear failed: ${message}`);
  }
}
