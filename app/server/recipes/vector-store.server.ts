import {
  GoogleGenerativeAI,
  TaskType,
  type BatchEmbedContentsRequest,
  type EmbedContentRequest,
} from "@google/generative-ai";
import type { Metadata, Where } from "chromadb";

import { getRecipeCollection, normalizeEmbedding } from "../chroma.server";
import { requiredEnv } from "../env.server";
import { chunk } from "./chunk";
import { buildRecipeRetrievalText } from "./normalization";
import type { Recipe, RecipeCandidate, RecipeIndexSkip } from "./types";

const DEFAULT_RECIPE_CANDIDATE_LIMIT = 30;
export const MAX_RECIPE_CANDIDATE_LIMIT = 120;
const RECIPE_EMBEDDING_MODEL = "gemini-embedding-001";
const RECIPE_EMBEDDING_DIMENSIONS = 1536;
const RECIPE_INDEX_BATCH_SIZE = 100;

type RecipeEmbedContentRequest = EmbedContentRequest & {
  outputDimensionality: number;
};

type RecipeBatchEmbedContentsRequest = BatchEmbedContentsRequest & {
  requests: RecipeEmbedContentRequest[];
};

type RecipeMetadata = Metadata & {
  documentType: "recipe";
  recipeId: string;
  minutes: number;
  calories: number;
  hasCalories: boolean;
  proteinDailyValue: number;
  hasProteinDailyValue: boolean;
  averageRating: number;
  ratingCount: number;
};

type RecipeEmbeddings = {
  embedDocuments(documents: string[]): Promise<number[][]>;
  embedQuery(query: string): Promise<number[]>;
};

type RecipeCollectionHandle = {
  get(input: {
    ids: string[];
    include: [];
  }): Promise<{
    ids: string[];
  }>;
  upsert(input: {
    ids: string[];
    embeddings: number[][];
    documents: string[];
    metadatas: RecipeMetadata[];
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

type RecipeCollection = {
  handle: RecipeCollectionHandle;
};

export type RecipeVectorStoreDependencies = {
  embeddings?: RecipeEmbeddings;
  getCollection?: () => Promise<RecipeCollection>;
  onSkippedRecipe?: (skip: RecipeIndexSkip) => void;
};

export type RecipeSearchInput = {
  query: string;
  limit?: number;
  /**
   * Optional hard constraints pushed down into the Chroma metadata filter so
   * constrained searches retrieve `limit` eligible candidates instead of
   * retrieving `limit` rows and starving the post-retrieval filter.
   */
  maxMinutes?: number | null;
  maxCalories?: number | null;
  minProteinDailyValue?: number | null;
};

function createRecipeEmbeddings(taskType: TaskType): RecipeEmbeddings {
  const model = new GoogleGenerativeAI(requiredEnv("GOOGLE_API_KEY")).getGenerativeModel({
    model: RECIPE_EMBEDDING_MODEL,
  });

  const requestForText = (text: string): RecipeEmbedContentRequest => ({
    content: { role: "user", parts: [{ text: text.replace(/\n/g, " ") }] },
    taskType,
    outputDimensionality: RECIPE_EMBEDDING_DIMENSIONS,
  });

  return {
    async embedDocuments(documents) {
      const response = await model.batchEmbedContents({
        requests: documents.map(requestForText),
      } as RecipeBatchEmbedContentsRequest);

      if (response.embeddings.length !== documents.length) {
        throw new Error(`Recipe embedding returned ${response.embeddings.length} vectors for ${documents.length} documents`);
      }

      return response.embeddings.map((embedding, index) => normalizeRecipeEmbedding(
        embedding.values,
        `Recipe document ${index + 1}`,
      ));
    },
    async embedQuery(query) {
      const response = await model.embedContent(requestForText(query));
      return normalizeRecipeEmbedding(response.embedding.values, "Recipe query");
    },
  };
}

function normalizeRecipeEmbedding(values: number[] | undefined, label: string) {
  return normalizeEmbedding(values, RECIPE_EMBEDDING_DIMENSIONS, label);
}

function metadataForRecipe(recipe: Recipe): RecipeMetadata {
  return {
    documentType: "recipe",
    recipeId: recipe.id,
    minutes: recipe.minutes,
    calories: recipe.nutrition.calories ?? -1,
    hasCalories: recipe.nutrition.calories !== null,
    proteinDailyValue: recipe.nutrition.proteinDailyValue ?? -1,
    hasProteinDailyValue: recipe.nutrition.proteinDailyValue !== null,
    averageRating: recipe.rating?.average ?? -1,
    ratingCount: recipe.rating?.count ?? 0,
  };
}

function similarityFromDistance(distance: number) {
  return 1 / (1 + Math.max(distance, 0));
}

function validateLimit(limit: number) {
  if (!Number.isInteger(limit) || limit <= 0 || limit > MAX_RECIPE_CANDIDATE_LIMIT) {
    throw new Error(
      `Food.com recipe candidate limit must be an integer from 1 to ${MAX_RECIPE_CANDIDATE_LIMIT}; received ${limit}`,
    );
  }
}

/**
 * Builds the Chroma metadata filter for a recipe search. Numeric constraints
 * ride along with the vector query so retrieval returns eligible candidates.
 * Recipes with unknown nutrition are stored with `-1` sentinels plus `hasX`
 * flags; a search constrained on a nutrient excludes unknown values, matching
 * the JS post-filter in recipe-retrieval (which is kept as a second guard).
 */
function recipeSearchWhere(input: RecipeSearchInput): Where {
  const clauses: Where[] = [{ documentType: "recipe" }];

  if (input.maxMinutes !== null && input.maxMinutes !== undefined) {
    clauses.push({ minutes: { $lte: input.maxMinutes } });
  }

  if (input.maxCalories !== null && input.maxCalories !== undefined) {
    clauses.push({ hasCalories: true }, { calories: { $lte: input.maxCalories } });
  }

  if (input.minProteinDailyValue !== null && input.minProteinDailyValue !== undefined) {
    clauses.push(
      { hasProteinDailyValue: true },
      { proteinDailyValue: { $gte: input.minProteinDailyValue } },
    );
  }

  return clauses.length === 1 ? clauses[0] : { $and: clauses };
}

function collectionLoader(dependencies: RecipeVectorStoreDependencies) {
  return dependencies.getCollection ?? getRecipeCollection as () => Promise<RecipeCollection>;
}

async function missingRecipes(collection: RecipeCollection, batch: Recipe[]) {
  const existing = await collection.handle.get({
    ids: batch.map((recipe) => recipe.id),
    include: [],
  });
  const existingIds = new Set(existing.ids);

  return batch.filter((recipe) => !existingIds.has(recipe.id));
}

function invalidEmbeddingReason(vector: number[] | undefined) {
  if (!Array.isArray(vector)) {
    return "embedding model returned no vector";
  }

  if (vector.length === 0) {
    return "embedding model returned an empty vector";
  }

  if (vector.some((value) => typeof value !== "number" || !Number.isFinite(value))) {
    return "embedding model returned a vector with a non-finite numeric value";
  }

  return null;
}

function validEmbeddingRecords(
  recipes: Recipe[],
  documents: string[],
  vectors: number[][],
  onSkippedRecipe: (skip: RecipeIndexSkip) => void,
) {
  const valid: Array<{
    recipe: Recipe;
    document: string;
    vector: number[];
  }> = [];

  recipes.forEach((recipe, index) => {
    const vector = vectors[index];
    const reason = invalidEmbeddingReason(vector);

    if (reason) {
      onSkippedRecipe({ recipeId: recipe.id, reason });
      return;
    }

    valid.push({
      recipe,
      document: documents[index] ?? "",
      vector,
    });
  });

  if (vectors.length > recipes.length) {
    throw new Error(
      `Embedding model returned ${vectors.length} vectors for ${recipes.length} recipes`,
    );
  }

  return valid;
}

export async function indexRecipesInChroma(
  recipes: Recipe[],
  dependencies: RecipeVectorStoreDependencies = {},
): Promise<number> {
  if (recipes.length === 0) {
    return 0;
  }

  try {
    const embeddings = dependencies.embeddings ?? createRecipeEmbeddings(TaskType.RETRIEVAL_DOCUMENT);
    const collection = await collectionLoader(dependencies)();
    const onSkippedRecipe = dependencies.onSkippedRecipe ?? (() => undefined);
    let indexed = 0;

    for (const batch of chunk(recipes, RECIPE_INDEX_BATCH_SIZE)) {
      const missing = await missingRecipes(collection, batch);

      if (missing.length === 0) {
        continue;
      }

      const documents = missing.map(buildRecipeRetrievalText);
      const vectors = await embeddings.embedDocuments(documents);
      const valid = validEmbeddingRecords(missing, documents, vectors, onSkippedRecipe);

      if (valid.length === 0) {
        continue;
      }

      await collection.handle.upsert({
        ids: valid.map(({ recipe }) => recipe.id),
        embeddings: valid.map(({ vector }) => vector),
        documents: valid.map(({ document }) => document),
        metadatas: valid.map(({ recipe }) => metadataForRecipe(recipe)),
      });
      indexed += valid.length;
    }

    return indexed;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Food.com recipe Chroma indexing failed: ${message}`);
  }
}

export async function searchRecipeCandidates(
  input: RecipeSearchInput,
  dependencies: RecipeVectorStoreDependencies = {},
): Promise<RecipeCandidate[]> {
  const query = input.query.trim();
  const limit = input.limit ?? DEFAULT_RECIPE_CANDIDATE_LIMIT;
  validateLimit(limit);

  if (!query) {
    return [];
  }

  try {
    const embeddings = dependencies.embeddings ?? createRecipeEmbeddings(TaskType.RETRIEVAL_QUERY);
    const collection = await collectionLoader(dependencies)();
    const queryEmbedding = await embeddings.embedQuery(query);
    const result = await collection.handle.query<RecipeMetadata>({
      queryEmbeddings: [queryEmbedding],
      nResults: limit,
      where: recipeSearchWhere(input),
      include: ["metadatas", "distances"],
    });
    const candidates = result.rows()[0] ?? [];
    const seen = new Set<string>();

    return candidates
      .map((candidate) => {
        const recipeId = candidate.metadata?.recipeId;
        const distance = candidate.distance;

        if (!recipeId || distance === null || distance === undefined || !Number.isFinite(distance)) {
          throw new Error("Chroma returned a recipe candidate without a valid recipe ID and distance");
        }

        return {
          recipeId,
          semanticScore: similarityFromDistance(distance),
        } satisfies RecipeCandidate;
      })
      .filter((candidate) => {
        if (seen.has(candidate.recipeId)) {
          return false;
        }

        seen.add(candidate.recipeId);
        return true;
      })
      .sort((left, right) =>
        right.semanticScore - left.semanticScore || left.recipeId.localeCompare(right.recipeId)
      );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Food.com recipe Chroma search failed: ${message}`);
  }
}
