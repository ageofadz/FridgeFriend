import type { BaseChatPromptTemplate } from "@langchain/core/prompts";
import type { Runnable } from "@langchain/core/runnables";
import { pull } from "langchain/hub";

import { requiredEnv } from "../env.server";

export const PROMPT_NAMESPACE = "fridgefriend";

export const PromptName = {
  ImageValidation: "fridge-perception",
  InventoryDetection: "inventory-detection",
  ZoneMap: "zone-map",
  LocationAdjudication: "location-adjudication",
  QueryMemoryExtraction: "query-memory-extraction",
  QueryRecipeSearch: "query-recipe-search",
  RecipeRetrievalGrade: "recipe-retrieval-grade",
  RecipeQueryRewrite: "recipe-query-rewrite",
  RecipeTournamentEvaluation: "recipe-tournament-evaluation",
  QueryResponse: "query-response",
  WorkspaceActionPlan: "workspace-action-plan",
} as const;

export type PromptName = (typeof PromptName)[keyof typeof PromptName];

export function buildPromptRef(name: PromptName, environment: string) {
  const suffix = environment === "dev" ? "latest" : environment;
  return `${PROMPT_NAMESPACE}-${name}:${suffix}`;
}

export type LoadedPrompt<TPrompt> = {
  name: PromptName;
  ref: string;
  prompt: TPrompt;
};

export type PromptBundle = {
  imageValidation: LoadedPrompt<BaseChatPromptTemplate>;
  inventoryDetection: LoadedPrompt<BaseChatPromptTemplate>;
  zoneMap: LoadedPrompt<BaseChatPromptTemplate>;
  locationAdjudication: LoadedPrompt<BaseChatPromptTemplate>;
  queryMemoryExtraction: LoadedPrompt<BaseChatPromptTemplate>;
  queryRecipeSearch: LoadedPrompt<BaseChatPromptTemplate>;
  recipeRetrievalGrade: LoadedPrompt<BaseChatPromptTemplate>;
  recipeQueryRewrite: LoadedPrompt<BaseChatPromptTemplate>;
  recipeTournamentEvaluation: LoadedPrompt<BaseChatPromptTemplate>;
  queryResponse: LoadedPrompt<BaseChatPromptTemplate>;
  workspaceActionPlan: LoadedPrompt<BaseChatPromptTemplate>;
};

let promptBundlePromise: Promise<PromptBundle> | null = null;

async function pullPrompt<TPrompt extends Runnable>(
  name: PromptName,
): Promise<LoadedPrompt<TPrompt>> {
  const ref = buildPromptRef(name, requiredEnv("LANGSMITH_PROMPT_ENVIRONMENT"));

  try {
    const prompt = await pull<TPrompt>(ref, {
      apiKey: requiredEnv("LANGSMITH_API_KEY"),
    });

    return {
      name,
      ref,
      prompt,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to pull Prompt Hub prompt ${ref}: ${message}`);
  }
}

export function loadPromptBundle(): Promise<PromptBundle> {
  if (!promptBundlePromise) {
    promptBundlePromise = loadPromptBundleUncached().catch((error) => {
      promptBundlePromise = null;
      throw error;
    });
  }
  return promptBundlePromise;
}

async function loadPromptBundleUncached(): Promise<PromptBundle> {
  const [
    imageValidation,
    inventoryDetection,
    zoneMap,
    locationAdjudication,
    queryMemoryExtraction,
    queryRecipeSearch,
    recipeRetrievalGrade,
    recipeQueryRewrite,
    recipeTournamentEvaluation,
    queryResponse,
    workspaceActionPlan,
  ] = await Promise.all([
    pullPrompt<BaseChatPromptTemplate>(PromptName.ImageValidation),
    pullPrompt<BaseChatPromptTemplate>(PromptName.InventoryDetection),
    pullPrompt<BaseChatPromptTemplate>(PromptName.ZoneMap),
    pullPrompt<BaseChatPromptTemplate>(PromptName.LocationAdjudication),
    pullPrompt<BaseChatPromptTemplate>(PromptName.QueryMemoryExtraction),
    pullPrompt<BaseChatPromptTemplate>(PromptName.QueryRecipeSearch),
    pullPrompt<BaseChatPromptTemplate>(PromptName.RecipeRetrievalGrade),
    pullPrompt<BaseChatPromptTemplate>(PromptName.RecipeQueryRewrite),
    pullPrompt<BaseChatPromptTemplate>(PromptName.RecipeTournamentEvaluation),
    pullPrompt<BaseChatPromptTemplate>(PromptName.QueryResponse),
    pullPrompt<BaseChatPromptTemplate>(PromptName.WorkspaceActionPlan),
  ]);
  return {
    imageValidation,
    inventoryDetection,
    zoneMap,
    locationAdjudication,
    queryMemoryExtraction,
    queryRecipeSearch,
    recipeRetrievalGrade,
    recipeQueryRewrite,
    recipeTournamentEvaluation,
    queryResponse,
    workspaceActionPlan,
  };
}
