import { z } from "zod";

import type { FridgeFriendChatModel } from "../../ai/chat-model.server";
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
  ConversationContextSchema,
  WorkspaceActionSchema,
  type ConversationContext,
} from "../../../workspace/contracts";
import {
  GROCERY_AISLES,
  GroceryAisleSchema,
  InventoryEnrichmentFieldSchema,
  QUERY_INTENTS,
  QueryIntentSchema,
} from "../../../workspace/query-events";

// The stream-event schemas (QueryStreamEventSchema and its payloads) live in
// the client-safe shared module and are re-exported here so existing server
// imports keep working.
export {
  QueryIntentSchema,
  InventoryEnrichmentFieldSchema,
  RecipeCardSchema,
  ExpiryPlanSchema,
  GroceryPlanSchema,
  PantryCompletionPlanSchema,
  QueryVisualEvidenceSchema,
  QueryStreamEventSchema,
} from "../../../workspace/query-events";
export type {
  QueryIntent,
  RecipeCard,
  ExpiryPlan,
  GroceryAisle,
  GroceryPlanItem,
  GroceryPlan,
  PantryCompletionPlan,
  QueryVisualEvidence,
  QueryStreamEvent,
} from "../../../workspace/query-events";

export const QUERY_VISIBLE_RESPONSE_TAG = "query_visible_response";

const ShoppingModeSchema = z.enum(["direct", "grocery_planner", "pantry_completion"]);

const EnrichmentRequirementSchema = z.object({
  itemNames: z.array(z.string().trim().min(1)).default([]),
  fields: z.array(InventoryEnrichmentFieldSchema).default([]),
});

export type EnrichmentRequirement = z.infer<typeof EnrichmentRequirementSchema>;

export const IntentResponseSchema = z.object({
  intent: QueryIntentSchema,
  recipeContinuation: z.boolean().optional().default(false),
  shoppingMode: ShoppingModeSchema.optional().default("direct"),
  enrichment: EnrichmentRequirementSchema.optional().default({ itemNames: [], fields: [] }),
  memoryUpdateRequested: z.boolean().optional().default(false),
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
    shoppingMode: {
      type: "string",
      enum: ["direct", "grocery_planner", "pantry_completion"],
      description: "For shopping requests, use grocery_planner for a shopping trip, grocery list, or meal-shopping plan; pantry_completion for pantry staples or ingredients that unlock more recipes; direct for a specific restock or inventory question.",
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
    memoryUpdateRequested: {
      type: "boolean",
      description: "True only when the user explicitly states durable inventory outside the scanned storage, a dietary restriction or identity, a food preference, a personal goal, or a durable household fact that should be saved.",
    },
  },
  required: ["intent", "enrichment", "memoryUpdateRequested"],
} as const;

const RecipeSearchFacetKindSchema = z.enum([
  "meal",
  "cuisine",
  "flavor",
  "method",
  "dish",
]);

export const RecipeSearchFacetSchema = z.object({
  kind: RecipeSearchFacetKindSchema,
  text: z.string().trim().min(1),
});

export type RecipeSearchFacet = z.infer<typeof RecipeSearchFacetSchema>;

export const RecipeSearchInterpretationSchema = z.object({
  facets: z.array(RecipeSearchFacetSchema).max(8).default([]),
  intent: z.object({
    specific: z.boolean(),
  }),
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
});

export type RecipeSearchInterpretation = z.infer<typeof RecipeSearchInterpretationSchema>;

export const RecipeSearchPlanSchema = z.object({
  userFacets: z.array(RecipeSearchFacetSchema).default([]),
  userTags: z.array(z.string().trim().min(1)).default([]),
  memoryTags: z.array(z.string().trim().min(1)).default([]),
  inventoryIngredients: z.array(z.string().trim().min(1)).default([]),
});

export type RecipeSearchPlan = z.infer<typeof RecipeSearchPlanSchema>;

export const RecipeSearchRequestSchema = z.object({
  semanticQuery: z.string().trim().min(1),
  semanticQueryWithoutInventory: z.string().trim().min(1),
  vectorCandidateLimit: z.number().int().min(1).max(120).default(50),
  correctiveAttempt: z.boolean().default(false),
  plan: RecipeSearchPlanSchema,
  intent: z.object({
    specific: z.boolean(),
    relatedSemanticQuery: z.string().trim().min(1).nullable(),
  }).optional(),
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

export const RecipeRetrievalTerminalReasonSchema = z.enum([
  "ready",
  "search_unavailable",
  "vector_empty",
  "candidate_sources_empty",
  "canonical_hydration_empty",
  "hard_constraints_rejected",
  "coverage_rejected",
  "tournament_empty",
  "tournament_complete",
]);

export const RecipeRetrievalAuditSchema = z.object({
  vectorCandidates: z.number().int().nonnegative(),
  tagSqlCandidates: z.number().int().nonnegative(),
  ingredientSqlCandidates: z.number().int().nonnegative(),
  deduplicatedCandidateIds: z.number().int().nonnegative(),
  canonicalHydrationCount: z.number().int().nonnegative(),
  hardFilterRejections: z.number().int().nonnegative(),
  coverageRankedCandidates: z.number().int().nonnegative(),
  tournamentCandidates: z.number().int().nonnegative(),
  terminalReason: RecipeRetrievalTerminalReasonSchema,
});

export type RecipeRetrievalAudit = z.infer<typeof RecipeRetrievalAuditSchema>;

export const RecipeSearchSessionSchema = z.object({
  profile: RecipeSearchRequestSchema,
  inventoryFingerprint: z.string(),
  shownRecipeIds: z.array(z.string()),
});

export const RecipeSearchRequestProviderSchema = {
  type: "object",
  properties: {
    facets: {
      type: "array",
      items: {
        type: "object",
        properties: {
          kind: {
            type: "string",
            enum: ["meal", "cuisine", "flavor", "method", "dish"],
          },
          text: {
            type: "string",
            description: "An exact phrase copied from the user's request. Do not paraphrase or add terms.",
          },
        },
        required: ["kind", "text"],
      },
    },
    intent: {
      type: "object",
      properties: {
        specific: {
          type: "boolean",
          description: "True when the user named a dish, meal style, cuisine, flavor, or other recipe theme that should take priority over general inventory coverage.",
        },
      },
      required: ["specific"],
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
      description: "Ingredients the user explicitly mentions as retrieval and ranking signals. Multiple entries may be alternatives rather than an all-of requirement.",
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
    "facets",
    "intent",
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
  requestId?: string;
  recipeContinuation?: boolean;
  conversationContext?: ConversationContext;
};

export const InventoryClarificationResumeSchema = z.object({
  answers: z.record(z.string(), z.string().trim()).default({}),
  skipped: z.array(z.string()).default([]),
});

export type InventoryClarificationResume = z.infer<typeof InventoryClarificationResumeSchema>;

const InventorySplitReviewResumeSchema = z.object({
  approved: z.boolean(),
});

const InventoryMutationReviewResumeSchema = z.object({
  approved: z.boolean(),
});

export const QueryResumeSchema = InventoryClarificationResumeSchema.extend({
  splitReview: InventorySplitReviewResumeSchema.optional(),
  inventoryMutationReview: InventoryMutationReviewResumeSchema.optional(),
});

export type QueryResume = z.infer<typeof QueryResumeSchema>;

export const GroceryRecipeSelectionSchema = z.object({
  recipeIds: z.array(z.string()).min(3).max(6),
});

export const GroceryRecipeSelectionProviderSchema = {
  type: "object",
  properties: {
    recipeIds: {
      type: "array",
      minItems: 3,
      maxItems: 6,
      items: { type: "string" },
    },
  },
  required: ["recipeIds"],
} as const;

export const GroceryAisleAssignmentSchema = z.object({
  assignments: z.array(z.object({
    ingredient: z.string().min(1),
    aisle: GroceryAisleSchema,
  })),
});

export const GroceryAisleAssignmentProviderSchema = {
  type: "object",
  properties: {
    assignments: {
      type: "array",
      items: {
        type: "object",
        properties: {
          ingredient: { type: "string" },
          aisle: { type: "string", enum: GROCERY_AISLES },
        },
        required: ["ingredient", "aisle"],
      },
    },
  },
  required: ["assignments"],
} as const;

export type RecipeRetrievalGrade = {
  relevant: boolean;
  reason: string;
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

export type QueryGraphDependencies = {
  promptBundle?: Pick<
    PromptBundle,
    "queryMemoryExtraction" | "queryRecipeSearch" | "queryResponse"
  > & Partial<Pick<PromptBundle, "workspaceActionPlan" | "recipeRetrievalGrade" | "recipeTournamentEvaluation" | "groceryRecipeSelection" | "groceryAisleAssignment" | "intentRouting" | "seededInventoryAssertions" | "focusedInventoryEnrichment" | "inventoryClarificationUser" | "inventoryClarificationInference" | "scopedInventorySplit" | "organizationPlan">>;
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
  intentModel?: FridgeFriendChatModel;
  seededInventoryAssertionModel?: FridgeFriendChatModel;
  applySeededInventoryAssertions?: (input: {
    seededItems: ConversationContext["seededItems"];
    assertions: SeededInventoryAssertion[];
  }) => AppliedSeededInventoryAssertion[] | Promise<AppliedSeededInventoryAssertion[]>;
  recipeSearchModel?: FridgeFriendChatModel;
  recipeRetrievalGradeModel?: FridgeFriendChatModel;
  recipeTournamentModel?: FridgeFriendChatModel;
  groceryRecipeSelectionModel?: FridgeFriendChatModel;
  groceryAisleAssignmentModel?: FridgeFriendChatModel;
  organizationPlannerModel?: FridgeFriendChatModel;
  searchRecipeCandidates?: (input: {
    query: string;
    limit: number;
    maxMinutes?: number | null;
    maxCalories?: number | null;
    minProteinDailyValue?: number | null;
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
  getPantryCompletionRecipeCandidates?: (input: {
    ingredients: string[];
    universalIngredients: readonly string[];
    minMissingIngredients: number;
    maxMissingIngredients: number;
    limit: number;
  }) => Array<{
    recipeId: string;
    matchedIngredients: string[];
    ingredientScore: number;
    missingIngredientCount: number;
  }> | Promise<Array<{
    recipeId: string;
    matchedIngredients: string[];
    ingredientScore: number;
    missingIngredientCount: number;
  }>>;
  memoryExtractionModel?: FridgeFriendChatModel;
  responseModel?: FridgeFriendChatModel;
  enrichmentModel?: FridgeFriendChatModel;
  inventorySplitModel?: FridgeFriendChatModel;
  workspaceActionModel?: FridgeFriendChatModel;
  loadImageDataUrlForQuery?: (
    imageId: string,
  ) => string | null | Promise<string | null>;
};
