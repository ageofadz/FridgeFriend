import { ChatPromptTemplate, type BaseChatPromptTemplate } from "@langchain/core/prompts";
import type { Runnable } from "@langchain/core/runnables";
import { pull } from "langchain/hub";

import promptDefinitions from "./prompts.json";

import { getLangSmithConfig } from "../langsmith.server";

const PROMPT_NAMESPACE = "fridgefriend";

const RECIPE_PROMPT_REVISIONS = {
  "query-recipe-search": "e698678c42c64a5e3f67b3432d3e3bf492f4411c103097f8fef4a6cdb50450c1",
  "recipe-retrieval-grade": "955d9b7184d3fd296088036f3353243b64da183a789673718dfdbaf7d891a6c0",
  "recipe-tournament-evaluation": "9c4f3e5cdffa7a0b06bcc6df6bc3620fb8cb42d97bf17604d211962e0305da92",
  "query-response": "d0d875334af058c1478636b7494a032197477afc8b07afbbab0ea5949fc2db12",
} as const;

export const PromptName = {
  ImageValidation: "fridge-perception",
  InventoryDetection: "inventory-detection",
  ZoneMap: "zone-map",
  GroundItemPlacements: "ground-item-placements",
  QueryMemoryExtraction: "query-memory-extraction",
  QueryRecipeSearch: "query-recipe-search",
  RecipeRetrievalGrade: "recipe-retrieval-grade",
  RecipeTournamentEvaluation: "recipe-tournament-evaluation",
  GroceryRecipeSelection: "grocery-recipe-selection",
  GroceryAisleAssignment: "grocery-aisle-assignment",
  QueryResponse: "query-response",
  WorkspaceActionPlan: "workspace-action-plan",
  IntentRouting: "intent-routing",
  SeededInventoryAssertions: "seeded-inventory-assertions",
  FocusedInventoryEnrichment: "focused-inventory-enrichment",
  InventoryClarificationUser: "inventory-clarification-user",
  InventoryClarificationInference: "inventory-clarification-inference",
  ScopedInventorySplit: "scoped-inventory-split",
  OrganizationPlan: "organization-plan",
  SeededBoundingBoxIdentification: "seeded-bounding-box-identification",
  EvalQueryAnswerGroundedness: "eval-query-answer-groundedness",
  EvalScanSemanticGrounding: "eval-scan-semantic-grounding",
} as const;

export type PromptName = (typeof PromptName)[keyof typeof PromptName];

function buildPromptRef(name: PromptName) {
  const revision = RECIPE_PROMPT_REVISIONS[name as keyof typeof RECIPE_PROMPT_REVISIONS];
  return `${PROMPT_NAMESPACE}-${name}:${revision ?? "latest"}`;
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
  groundItemPlacements: LoadedPrompt<BaseChatPromptTemplate>;
  queryMemoryExtraction: LoadedPrompt<BaseChatPromptTemplate>;
  queryRecipeSearch: LoadedPrompt<BaseChatPromptTemplate>;
  recipeRetrievalGrade: LoadedPrompt<BaseChatPromptTemplate>;
  recipeTournamentEvaluation: LoadedPrompt<BaseChatPromptTemplate>;
  groceryRecipeSelection: LoadedPrompt<BaseChatPromptTemplate>;
  groceryAisleAssignment: LoadedPrompt<BaseChatPromptTemplate>;
  queryResponse: LoadedPrompt<BaseChatPromptTemplate>;
  workspaceActionPlan: LoadedPrompt<BaseChatPromptTemplate>;
  intentRouting: LoadedPrompt<BaseChatPromptTemplate>;
  seededInventoryAssertions: LoadedPrompt<BaseChatPromptTemplate>;
  focusedInventoryEnrichment: LoadedPrompt<BaseChatPromptTemplate>;
  inventoryClarificationUser: LoadedPrompt<BaseChatPromptTemplate>;
  inventoryClarificationInference: LoadedPrompt<BaseChatPromptTemplate>;
  scopedInventorySplit: LoadedPrompt<BaseChatPromptTemplate>;
  organizationPlan: LoadedPrompt<BaseChatPromptTemplate>;
  seededBoundingBoxIdentification: LoadedPrompt<BaseChatPromptTemplate>;
};

export type EvalPromptBundle = PromptBundle & {
  evalQueryAnswerGroundedness: LoadedPrompt<BaseChatPromptTemplate>;
  evalScanSemanticGrounding: LoadedPrompt<BaseChatPromptTemplate>;
};

let promptBundlePromise: Promise<PromptBundle> | null = null;
let evalPromptBundlePromise: Promise<EvalPromptBundle> | null = null;

async function hubPrompt<TPrompt extends Runnable>(
  name: PromptName,
): Promise<LoadedPrompt<TPrompt>> {
  const config = getLangSmithConfig();

  if (!config) {
    throw new Error("LangSmith Prompt Hub was requested without a complete LangSmith configuration");
  }

  const ref = buildPromptRef(name);

  try {
    const prompt = await pull<TPrompt>(ref, {
      apiKey: config.apiKey,
      apiUrl: config.endpoint,
    });

    return {
      name,
      ref,
      prompt,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const revision = RECIPE_PROMPT_REVISIONS[name as keyof typeof RECIPE_PROMPT_REVISIONS];
    if (revision) {
      throw new Error(`Approved recipe Prompt Hub prompt ${ref} could not load: ${message}`);
    }
    throw new Error(`Prompt Hub prompt ${ref} could not load: ${message}`);
  }
}

function bundledPrompt<TPrompt extends Runnable>(name: PromptName): LoadedPrompt<TPrompt> {
  const definition = promptDefinitions.find((entry) => entry.name === name);

  if (!definition) {
    throw new Error(`Bundled prompt definition was missing for ${name}`);
  }

  return {
    name,
    ref: `bundled:${name}`,
    prompt: ChatPromptTemplate.fromMessages(
      definition.messages as never,
      { templateFormat: definition.templateFormat as "mustache" },
    ) as unknown as TPrompt,
  };
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

export function loadEvalPromptBundle(): Promise<EvalPromptBundle> {
  if (!evalPromptBundlePromise) {
    evalPromptBundlePromise = loadEvalPromptBundleUncached().catch((error) => {
      evalPromptBundlePromise = null;
      throw error;
    });
  }
  return evalPromptBundlePromise;
}

async function loadEvalPromptBundleUncached(): Promise<EvalPromptBundle> {
  const prompt = getLangSmithConfig() ? hubPrompt : bundledPrompt;
  const [bundle, evalQueryAnswerGroundedness, evalScanSemanticGrounding] = await Promise.all([
    loadPromptBundle(),
    prompt<BaseChatPromptTemplate>(PromptName.EvalQueryAnswerGroundedness),
    prompt<BaseChatPromptTemplate>(PromptName.EvalScanSemanticGrounding),
  ]);

  return {
    ...bundle,
    evalQueryAnswerGroundedness,
    evalScanSemanticGrounding,
  };
}

async function loadPromptBundleUncached(): Promise<PromptBundle> {
  const prompt = getLangSmithConfig() ? hubPrompt : bundledPrompt;
  const [
    imageValidation,
    inventoryDetection,
    zoneMap,
    groundItemPlacements,
    queryMemoryExtraction,
    queryRecipeSearch,
    recipeRetrievalGrade,
    recipeTournamentEvaluation,
    groceryRecipeSelection,
    groceryAisleAssignment,
    queryResponse,
    workspaceActionPlan,
    intentRouting,
    seededInventoryAssertions,
    focusedInventoryEnrichment,
    inventoryClarificationUser,
    inventoryClarificationInference,
    scopedInventorySplit,
    organizationPlan,
    seededBoundingBoxIdentification,
  ] = await Promise.all([
    prompt<BaseChatPromptTemplate>(PromptName.ImageValidation),
    prompt<BaseChatPromptTemplate>(PromptName.InventoryDetection),
    prompt<BaseChatPromptTemplate>(PromptName.ZoneMap),
    prompt<BaseChatPromptTemplate>(PromptName.GroundItemPlacements),
    prompt<BaseChatPromptTemplate>(PromptName.QueryMemoryExtraction),
    prompt<BaseChatPromptTemplate>(PromptName.QueryRecipeSearch),
    prompt<BaseChatPromptTemplate>(PromptName.RecipeRetrievalGrade),
    prompt<BaseChatPromptTemplate>(PromptName.RecipeTournamentEvaluation),
    prompt<BaseChatPromptTemplate>(PromptName.GroceryRecipeSelection),
    prompt<BaseChatPromptTemplate>(PromptName.GroceryAisleAssignment),
    prompt<BaseChatPromptTemplate>(PromptName.QueryResponse),
    prompt<BaseChatPromptTemplate>(PromptName.WorkspaceActionPlan),
    prompt<BaseChatPromptTemplate>(PromptName.IntentRouting),
    prompt<BaseChatPromptTemplate>(PromptName.SeededInventoryAssertions),
    prompt<BaseChatPromptTemplate>(PromptName.FocusedInventoryEnrichment),
    prompt<BaseChatPromptTemplate>(PromptName.InventoryClarificationUser),
    prompt<BaseChatPromptTemplate>(PromptName.InventoryClarificationInference),
    prompt<BaseChatPromptTemplate>(PromptName.ScopedInventorySplit),
    prompt<BaseChatPromptTemplate>(PromptName.OrganizationPlan),
    prompt<BaseChatPromptTemplate>(PromptName.SeededBoundingBoxIdentification),
  ]);
  return {
    imageValidation,
    inventoryDetection,
    zoneMap,
    groundItemPlacements,
    queryMemoryExtraction,
    queryRecipeSearch,
    recipeRetrievalGrade,
    recipeTournamentEvaluation,
    groceryRecipeSelection,
    groceryAisleAssignment,
    queryResponse,
    workspaceActionPlan,
    intentRouting,
    seededInventoryAssertions,
    focusedInventoryEnrichment,
    inventoryClarificationUser,
    inventoryClarificationInference,
    scopedInventorySplit,
    organizationPlan,
    seededBoundingBoxIdentification,
  };
}
