import type { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { z } from "zod";

import type { Recipe, RecipeCandidate } from "../../recipes/types";
import type { HouseholdInventoryOperationResult } from "../../memory/repository.server";
import type { PromptBundle } from "../../prompts/registry.server";
import type {
  MemoryContext,
  MemoryValidationResult,
  MemoryWriteResult,
  SemanticMemory,
} from "../../memory/schemas";
import type { Inventory } from "../../scan/schemas/inventory";
import type {
  AppliedSeededInventoryAssertion,
  SeededInventoryAssertion,
} from "../services/seeded-inventory-assertion.server";
import {
  AgentActivityEventSchema,
  ConversationContextSchema,
  WorkspaceActionSchema,
  type AgentActivityEvent,
  type ConversationContext,
  type WorkspaceAction,
} from "../../../workspace/contracts";

export const QUERY_INTENTS = [
  "inventory",
  "expiry",
  "food_knowledge",
  "recipe",
  "shopping",
  "space",
  "clarification",
] as const;

export const QUERY_VISIBLE_RESPONSE_TAG = "query_visible_response";

export const QueryIntentSchema = z.enum(QUERY_INTENTS);

export const InventoryEnrichmentFieldSchema = z.enum([
  "identity",
  "quantity",
  "fill_level",
  "expiration_date",
  "opened",
]);

export const EnrichmentRequirementSchema = z.object({
  itemNames: z.array(z.string().trim().min(1)).default([]),
  fields: z.array(InventoryEnrichmentFieldSchema).default([]),
});

export type EnrichmentRequirement = z.infer<typeof EnrichmentRequirementSchema>;

export const IntentResponseSchema = z.object({
  intent: QueryIntentSchema,
  recipeContinuation: z.boolean().optional().default(false),
  enrichment: EnrichmentRequirementSchema.optional().default({ itemNames: [], fields: [] }),
});

export const IntentResponseProviderSchema = {
  type: "object",
  properties: {
    intent: {
      type: "string",
      enum: QUERY_INTENTS,
      description: "The request category.",
    },
    recipeContinuation: {
      type: "boolean",
      description: "True only when the request should continue an existing recipe search session rather than start a new recipe search.",
    },
    enrichment: {
      type: "object",
      properties: {
        itemNames: { type: "array", items: { type: "string" } },
        fields: {
          type: "array",
          items: { type: "string", enum: ["identity", "quantity", "fill_level", "expiration_date", "opened"] },
        },
      },
      required: ["itemNames", "fields"],
      description: "Only inventory facts needed to answer the request. Leave both arrays empty when the coarse inventory is sufficient.",
    },
  },
  required: ["intent", "enrichment"],
} as const;

export type QueryIntent = z.infer<typeof QueryIntentSchema>;

export const RecipeSearchRequestSchema = z.object({
  semanticQuery: z.string().trim().min(1),
  useAvailableIngredients: z.boolean().default(false),
  excludedIngredients: z.array(z.string().trim().min(1)).default([]),
  dietaryRestrictions: z.array(z.string().trim().min(1)).default([]),
  maxMinutes: z.number().finite().positive().nullable().default(null),
  maxCalories: z.number().finite().nonnegative().nullable().default(null),
  minProteinDailyValue: z.number().finite().nonnegative().nullable().default(null),
  preferredIngredients: z.array(z.string().trim().min(1)).default([]),
  requiredTags: z.array(z.string().trim().min(1)).default([]),
  preferredTags: z.array(z.string().trim().min(1)).default([]),
  excludedTags: z.array(z.string().trim().min(1)).default([]),
  memoryPreferredTags: z.array(z.string().trim().min(1)).default([]),
  memoryExcludedTags: z.array(z.string().trim().min(1)).default([]),
  memoryGoalTags: z.array(z.string().trim().min(1)).default([]),
  continuation: z.boolean().default(false),
});

export type RecipeSearchRequest = z.infer<typeof RecipeSearchRequestSchema>;

export const RecipeSearchSessionSchema = z.object({
  profile: RecipeSearchRequestSchema,
  inventoryFingerprint: z.string(),
  shownRecipeIds: z.array(z.string()),
});

export type RecipeSearchSession = z.infer<typeof RecipeSearchSessionSchema>;

export const RecipeSearchRequestProviderSchema = {
  type: "object",
  properties: {
    semanticQuery: {
      type: "string",
      description: "Meal, flavor, cuisine, cooking style, or recipe intent to retrieve.",
    },
    useAvailableIngredients: {
      type: "boolean",
      description: "True only when the user asks what they can make from their currently available ingredients without stating a separate recipe intent.",
    },
    excludedIngredients: {
      type: "array",
      items: { type: "string" },
      description: "Ingredients the user explicitly excluded.",
    },
    dietaryRestrictions: {
      type: "array",
      items: { type: "string" },
      description: "Dietary constraints the user explicitly stated.",
    },
    maxMinutes: {
      type: "number",
      nullable: true,
      description: "Maximum cooking time in minutes, or null when unstated.",
    },
    maxCalories: {
      type: "number",
      nullable: true,
      description: "Maximum calories, or null when unstated.",
    },
    minProteinDailyValue: {
      type: "number",
      nullable: true,
      description: "Minimum protein daily value percent, or null when unstated.",
    },
    preferredIngredients: {
      type: "array",
      items: { type: "string" },
      description: "Ingredients the user explicitly wants included. These are hard recipe-ingredient constraints unless useAvailableIngredients is true.",
    },
    requiredTags: {
      type: "array",
      items: { type: "string" },
      description: "Categorical Food.com constraints the user explicitly requires.",
    },
    preferredTags: {
      type: "array",
      items: { type: "string" },
      description: "Categorical Food.com preferences the user explicitly requests.",
    },
    excludedTags: {
      type: "array",
      items: { type: "string" },
      description: "Categorical Food.com tags the user explicitly excludes.",
    },
  },
  required: [
    "semanticQuery",
    "useAvailableIngredients",
    "excludedIngredients",
    "dietaryRestrictions",
    "maxMinutes",
    "maxCalories",
    "minProteinDailyValue",
    "preferredIngredients",
    "requiredTags",
    "preferredTags",
    "excludedTags",
  ],
} as const;

export type QueryGraphInput = {
  userId?: string;
  fridgeId: string;
  imageId: string | null;
  query: string;
  threadId?: string;
  conversationContext?: ConversationContext;
};

export const InventoryClarificationQuestionSchema = z.object({
  itemId: z.string(),
  field: InventoryEnrichmentFieldSchema,
  question: z.string(),
});

export const InventoryClarificationResumeSchema = z.object({
  answers: z.record(z.string(), z.string().trim()).default({}),
  skipped: z.array(z.string()).default([]),
});

export type InventoryClarificationResume = z.infer<typeof InventoryClarificationResumeSchema>;

export const InventorySplitReviewResumeSchema = z.object({
  approved: z.boolean(),
});

export const QueryResumeSchema = InventoryClarificationResumeSchema.extend({
  splitReview: InventorySplitReviewResumeSchema.optional(),
});

export type QueryResume = z.infer<typeof QueryResumeSchema>;

export type RecipeCard = {
  id: string;
  name: string;
  description: string | null;
  minutes: number;
  matchedIngredients: string[];
  missingIngredients: string[];
  matchedTags: string[];
  matchBadges: string[];
  usesSoonIngredients?: string[];
  tournamentPlacement?: "winner" | "finalist";
};

export type ExpiryPlanItem = {
  id: string;
  visibleItemId: string | null;
  name: string;
  ingredientName: string;
  storageLocation: string;
  urgency: "fresh" | "use_soon" | "urgent" | "expired" | "unknown";
  source: "user_date" | "observed_date" | "recorded_date" | "estimated";
  confidence: "high" | "medium" | "low";
  date: string;
  label: string;
  dateIssue: string | null;
  wasteScore: number;
};

export type ExpiryPlan = {
  items: ExpiryPlanItem[];
  priorityItems: ExpiryPlanItem[];
  expiredItems: ExpiryPlanItem[];
};

export type RecipeRetrievalGrade = {
  relevant: boolean;
  reason: string;
};

export type QueryVisualEvidence = {
  itemId: string;
  displayName: string;
  dataUrl: string;
};

export const WorkspaceActionPlanSchema = z.object({
  actions: z.array(WorkspaceActionSchema).default([]),
});

export const WorkspaceActionPlanProviderSchema = {
  type: "object",
  properties: {
    actions: {
      type: "array",
      items: { type: "object" },
    },
  },
  required: ["actions"],
} as const;

export type QueryStreamEvent =
  | {
    type: "status";
    message: string;
    node?: string;
  }
  | {
    type: "tool";
    name: string;
    status: "started" | "progress" | "finished";
    message: string;
  }
  | {
    type: "token";
    text: string;
  }
  | {
    type: "recipe_tournament_started";
    candidateCount: number;
    displaySlotCount: number;
  }
  | {
    type: "recipe_tournament_update";
    recipes: RecipeCard[];
    evaluatedCount: number;
    totalCount: number;
    droppedRecipeIds: string[];
  }
  | {
    type: "recipe_tournament_finished";
    recipes: RecipeCard[];
  }
  | {
    type: "expiry_plan";
    plan: ExpiryPlan;
  }
  | {
    type: "clarification";
    questions: z.infer<typeof InventoryClarificationQuestionSchema>[];
  }
  | {
    type: "inventory_split_review";
    zoneId: string;
    summary: string;
    items: Array<{ label: string; name: string }>;
  }
  | {
    type: "final";
    answer: string;
    intent: QueryIntent | null;
    recipes: RecipeCard[];
    expiryPlan?: ExpiryPlan;
    visualEvidence: QueryVisualEvidence[];
    workspaceActions?: WorkspaceAction[];
    agentEvents?: AgentActivityEvent[];
  }
  | {
    type: "workspace_action";
    action: WorkspaceAction;
  }
  | {
    type: "agent_event";
    event: AgentActivityEvent;
  }
  | {
    type: "error";
    error: string;
  };

export type QueryGraphDependencies = {
  promptBundle?: Pick<
    PromptBundle,
    "queryMemoryExtraction" | "queryRecipeSearch" | "queryResponse"
  > & Partial<Pick<PromptBundle, "workspaceActionPlan" | "recipeRetrievalGrade" | "recipeQueryRewrite" | "recipeTournamentEvaluation">>;
  loadInventoryForImage?: (imageId: string) => Inventory | null;
  householdInventoryTool?: {
    invoke(input: {
      operation: "list";
      location?: "fridge" | "freezer" | "pantry" | "cupboard" | "counter" | "other";
      locations?: Array<"fridge" | "freezer" | "pantry" | "cupboard" | "counter" | "other">;
      ids?: string[];
      names?: string[];
      search?: string;
      statuses?: Array<"available" | "possibly_available" | "consumed" | "removed">;
      hasQuantity?: boolean;
      hasNotes?: boolean;
      expiringBefore?: string;
      fields?: Array<
        | "id"
        | "fridgeId"
        | "name"
        | "canonicalName"
        | "storageLocation"
        | "quantity"
        | "status"
        | "confidence"
        | "source"
        | "notes"
        | "expirationDate"
        | "expirationDateSource"
        | "lastConfirmedAt"
        | "createdAt"
        | "updatedAt"
      >;
      limit?: number;
      sortBy?: "name" | "storageLocation" | "updatedAt" | "expirationDate";
      sortDirection?: "asc" | "desc";
    }): HouseholdInventoryOperationResult | Promise<HouseholdInventoryOperationResult>;
  };
  loadMemoryContext?: (input: {
    userId: string;
    fridgeId: string;
    query: string;
  }) => MemoryContext | Promise<MemoryContext>;
  persistMemoryValidations?: (input: {
    userId: string;
    fridgeId: string;
    validations: MemoryValidationResult[];
  }) => Array<{
    result: MemoryWriteResult;
    semanticMemory: SemanticMemory | null;
  }> | Promise<Array<{
    result: MemoryWriteResult;
    semanticMemory: SemanticMemory | null;
  }>>;
  indexSemanticMemory?: (memory: SemanticMemory) => Promise<void>;
  intentModel?: ChatGoogleGenerativeAI;
  seededInventoryAssertionModel?: ChatGoogleGenerativeAI;
  applySeededInventoryAssertions?: (input: {
    seededItems: ConversationContext["seededItems"];
    assertions: SeededInventoryAssertion[];
  }) => AppliedSeededInventoryAssertion[] | Promise<AppliedSeededInventoryAssertion[]>;
  recipeSearchModel?: ChatGoogleGenerativeAI;
  recipeRetrievalGradeModel?: ChatGoogleGenerativeAI;
  recipeQueryRewriteModel?: ChatGoogleGenerativeAI;
  recipeTournamentModel?: ChatGoogleGenerativeAI;
  searchRecipeCandidates?: (input: {
    query: string;
    limit: number;
  }) => Promise<RecipeCandidate[]>;
  getRecipesByIds?: (recipeIds: string[]) => Recipe[] | Promise<Recipe[]>;
  listFoodComTags?: () => string[] | Promise<string[]>;
  getRecipeCandidatesByTags?: (input: {
    requiredTags: string[];
    preferredTags: string[];
    excludedTags: string[];
    limit: number;
  }) => Array<{
    recipeId: string;
    matchedTags: string[];
    tagScore: number;
  }> | Promise<Array<{
    recipeId: string;
    matchedTags: string[];
    tagScore: number;
  }>>;
  getRecipeCandidatesByIngredients?: (input: {
    ingredients: string[];
    limit: number;
  }) => Array<{
    recipeId: string;
    matchedIngredients: string[];
    ingredientScore: number;
  }> | Promise<Array<{
    recipeId: string;
    matchedIngredients: string[];
    ingredientScore: number;
  }>>;
  memoryExtractionModel?: ChatGoogleGenerativeAI;
  responseModel?: ChatGoogleGenerativeAI;
  enrichmentModel?: ChatGoogleGenerativeAI;
  drawerSplitModel?: ChatGoogleGenerativeAI;
  workspaceActionModel?: ChatGoogleGenerativeAI;
  loadImageDataUrlForQuery?: (
    imageId: string,
  ) => string | null | Promise<string | null>;
};
