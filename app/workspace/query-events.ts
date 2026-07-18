import { z } from "zod";

import { OrganizationPlanSchema } from "../server/organization/schemas";
import { AgentActivityEventSchema, WorkspaceActionSchema } from "./contracts";

// Client-safe schemas for the NDJSON query stream. This module is bundled into
// the browser, so it must never import server-only code (.server.ts modules or
// node builtins) — only zod and other shared workspace contracts.

export const QUERY_INTENTS = [
  "inventory",
  "expiry",
  "food_knowledge",
  "recipe",
  "shopping",
  "space",
  "organization",
  "placement_correction",
  "general_chat",
  "clarification",
] as const;

export const QueryIntentSchema = z.enum(QUERY_INTENTS);
export type QueryIntent = z.infer<typeof QueryIntentSchema>;

export const InventoryEnrichmentFieldSchema = z.enum([
  "identity",
  "quantity",
  "fill_level",
  "expiration_date",
  "opened",
]);
export type InventoryEnrichmentField = z.infer<typeof InventoryEnrichmentFieldSchema>;

export const InventoryClarificationQuestionSchema = z.object({
  itemId: z.string(),
  field: InventoryEnrichmentFieldSchema,
  question: z.string(),
});
export type InventoryClarificationQuestion = z.infer<typeof InventoryClarificationQuestionSchema>;

export const RecipeCardSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  minutes: z.number(),
  matchedIngredients: z.array(z.string()),
  missingIngredients: z.array(z.string()),
  matchedTags: z.array(z.string()),
  matchBadges: z.array(z.string()),
  usesSoonIngredients: z.array(z.string()).optional(),
});
export type RecipeCard = z.infer<typeof RecipeCardSchema>;

export const ExpiryPlanItemSchema = z.object({
  id: z.string(),
  visibleItemId: z.string().nullable(),
  name: z.string(),
  ingredientName: z.string(),
  storageLocation: z.string(),
  urgency: z.enum(["fresh", "use_soon", "urgent", "expired", "unknown"]),
  source: z.enum(["user_date", "observed_date", "recorded_date", "estimated"]),
  confidence: z.enum(["high", "medium", "low"]),
  date: z.string(),
  label: z.string(),
  dateIssue: z.string().nullable(),
  wasteScore: z.number().finite(),
});
export type ExpiryPlanItem = z.infer<typeof ExpiryPlanItemSchema>;

export const ExpiryPlanSchema = z.object({
  items: z.array(ExpiryPlanItemSchema),
  priorityItems: z.array(ExpiryPlanItemSchema),
  expiredItems: z.array(ExpiryPlanItemSchema),
});
export type ExpiryPlan = z.infer<typeof ExpiryPlanSchema>;

export const GROCERY_AISLES = [
  "produce",
  "meat_seafood",
  "dairy_eggs",
  "bakery",
  "dry_goods",
  "canned_goods",
  "frozen",
  "condiments_spices",
  "beverages",
  "other",
] as const;

export const GroceryAisleSchema = z.enum(GROCERY_AISLES);
export type GroceryAisle = z.infer<typeof GroceryAisleSchema>;

// The grocery plan carries the same recipe card shape the rest of the stream
// uses (the previous separate schema had drifted into a structural duplicate).
export const GroceryPlanRecipeSchema = RecipeCardSchema;

export const GroceryPlanItemSchema = z.object({
  ingredient: z.string().min(1),
  aisle: GroceryAisleSchema,
  recipeIds: z.array(z.string()).min(1),
  recipeNames: z.array(z.string()).min(1),
});
export type GroceryPlanItem = z.infer<typeof GroceryPlanItemSchema>;

export const GroceryPlanSchema = z.object({
  recipes: z.array(GroceryPlanRecipeSchema).min(3).max(6),
  items: z.array(GroceryPlanItemSchema),
});
export type GroceryPlan = z.infer<typeof GroceryPlanSchema>;

export const PantryCompletionSuggestionSchema = z.object({
  ingredient: z.string().min(1),
  aisle: GroceryAisleSchema,
  recipeIds: z.array(z.string()).min(1),
  recipeNames: z.array(z.string()).min(1),
  supportingRecipeCount: z.number().int().positive(),
});
export type PantryCompletionSuggestion = z.infer<typeof PantryCompletionSuggestionSchema>;

export const PantryCompletionUnlockedRecipeSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  suggestedIngredients: z.array(z.string().min(1)).min(1).max(3),
});
export type PantryCompletionUnlockedRecipe = z.infer<typeof PantryCompletionUnlockedRecipeSchema>;

export const PantryCompletionPlanSchema = z.object({
  eligibleRecipeCount: z.number().int().nonnegative(),
  unlockedRecipeCount: z.number().int().positive(),
  unlockedRecipes: z.array(PantryCompletionUnlockedRecipeSchema).min(1),
  suggestions: z.array(PantryCompletionSuggestionSchema).min(1).max(3),
});
export type PantryCompletionPlan = z.infer<typeof PantryCompletionPlanSchema>;

export const QueryVisualEvidenceSchema = z.object({
  cropId: z.string(),
  itemId: z.string(),
  displayName: z.string(),
  imageId: z.string(),
});
export type QueryVisualEvidence = z.infer<typeof QueryVisualEvidenceSchema>;

export const RecipeRetrievalAuditSchema = z.object({
  vectorCandidates: z.number().int().nonnegative(),
  tagSqlCandidates: z.number().int().nonnegative(),
  ingredientSqlCandidates: z.number().int().nonnegative(),
  deduplicatedCandidateIds: z.number().int().nonnegative(),
  canonicalHydrationCount: z.number().int().nonnegative(),
  hardFilterRejections: z.number().int().nonnegative(),
  coverageRankedCandidates: z.number().int().nonnegative(),
  tournamentCandidates: z.number().int().nonnegative(),
  terminalReason: z.enum([
    "ready",
    "search_unavailable",
    "vector_empty",
    "candidate_sources_empty",
    "canonical_hydration_empty",
    "hard_constraints_rejected",
    "coverage_rejected",
    "tournament_empty",
    "tournament_complete",
  ]),
});
export type RecipeRetrievalAudit = z.infer<typeof RecipeRetrievalAuditSchema>;

export const DietaryRestrictionSchema = z.object({
  id: z.string(),
  userId: z.string(),
  restrictionType: z.enum(["allergy", "intolerance", "religious", "medical", "other"]),
  subject: z.string(),
  severity: z.enum(["avoid", "strict_avoid"]),
  notes: z.string().nullable(),
  source: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type DietaryRestriction = z.infer<typeof DietaryRestrictionSchema>;

export const DietaryPreferenceSchema = z.object({
  id: z.string(),
  userId: z.string(),
  subject: z.string(),
  sentiment: z.enum(["like", "dislike", "prefer", "avoid"]),
  strength: z.number().int().min(1).max(5),
  notes: z.string().nullable(),
  source: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type DietaryPreference = z.infer<typeof DietaryPreferenceSchema>;

export const GoalMemorySchema = z.object({
  id: z.string(),
  userId: z.string(),
  goalType: z.enum(["high_protein", "weight_loss", "budget", "quick_meals", "reduce_waste", "other"]),
  description: z.string(),
  targetValue: z.number().nullable(),
  targetUnit: z.string().nullable(),
  priority: z.number().int().min(1).max(5),
  active: z.boolean(),
  source: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type GoalMemory = z.infer<typeof GoalMemorySchema>;

export const QueryStreamEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("status"),
    message: z.string(),
    node: z.string().optional(),
  }),
  z.object({
    type: z.literal("tool"),
    name: z.string(),
    status: z.enum(["started", "progress", "finished"]),
    message: z.string(),
  }),
  z.object({
    type: z.literal("token"),
    text: z.string(),
  }),
  z.object({
    type: z.literal("recipe_tournament_started"),
    candidateCount: z.number().int().positive(),
    displaySlotCount: z.number().int().positive(),
  }),
  z.object({
    type: z.literal("recipe_tournament_update"),
    recipes: z.array(RecipeCardSchema),
    evaluatedCount: z.number().int(),
    totalCount: z.number().int(),
    droppedRecipeIds: z.array(z.string()),
  }),
  z.object({
    type: z.literal("recipe_tournament_finished"),
    recipes: z.array(RecipeCardSchema),
  }),
  z.object({
    type: z.literal("expiry_plan"),
    plan: ExpiryPlanSchema,
  }),
  z.object({
    type: z.literal("grocery_plan_progress"),
    stage: z.enum(["selecting_recipes", "building_list"]),
  }),
  z.object({
    type: z.literal("grocery_plan"),
    plan: GroceryPlanSchema,
  }),
  z.object({
    type: z.literal("grocery_plan_error"),
    error: z.string(),
  }),
  z.object({
    type: z.literal("pantry_completion_progress"),
    stage: z.enum(["analyzing_recipes", "assigning_aisles"]),
  }),
  z.object({
    type: z.literal("pantry_completion"),
    plan: PantryCompletionPlanSchema,
  }),
  z.object({
    type: z.literal("pantry_completion_error"),
    error: z.string(),
  }),
  z.object({
    type: z.literal("pantry_completion_clarification"),
    message: z.string(),
  }),
  z.object({
    type: z.literal("organization_plan"),
    plan: OrganizationPlanSchema,
  }),
  z.object({
    type: z.literal("clarification"),
    questions: z.array(InventoryClarificationQuestionSchema),
  }),
  z.object({
    type: z.literal("inventory_split_review"),
    scopeLabel: z.string(),
    summary: z.string(),
    items: z.array(z.object({ label: z.string(), name: z.string() })),
  }),
  z.object({
    type: z.literal("inventory_mutation_review"),
    operation: z.enum(["consume", "remove"]),
    itemName: z.string(),
    storageLocation: z.string(),
  }),
  z.object({
    type: z.literal("inventory_updated"),
    inventory: z.unknown(),
  }),
  z.object({
    type: z.literal("memory_update"),
    status: z.enum(["verified", "failed"]),
    message: z.string(),
    changedKinds: z.array(z.enum(["inventory_item", "dietary_restriction", "preference", "goal", "misc"])),
    dietaryRestrictions: z.array(DietaryRestrictionSchema),
    dietaryPreferences: z.array(DietaryPreferenceSchema),
    activeGoals: z.array(GoalMemorySchema),
  }),
  z.object({
    type: z.literal("final"),
    answer: z.string(),
    // Unknown intents degrade to null instead of failing the whole event.
    intent: QueryIntentSchema.nullable().catch(null),
    recipes: z.array(RecipeCardSchema),
    expiryPlan: ExpiryPlanSchema.optional(),
    groceryPlan: GroceryPlanSchema.optional(),
    groceryPlanError: z.string().optional(),
    pantryCompletionPlan: PantryCompletionPlanSchema.optional(),
    pantryCompletionError: z.string().optional(),
    pantryCompletionClarification: z.string().optional(),
    organizationPlan: OrganizationPlanSchema.optional(),
    visualEvidence: z.array(QueryVisualEvidenceSchema),
    dietaryRestrictions: z.array(DietaryRestrictionSchema),
    dietaryPreferences: z.array(DietaryPreferenceSchema),
    activeGoals: z.array(GoalMemorySchema),
    workspaceActions: z.array(WorkspaceActionSchema).optional(),
    agentEvents: z.array(AgentActivityEventSchema).optional(),
    retrievalAudit: RecipeRetrievalAuditSchema.optional(),
    memoryWriteVerificationError: z.string().optional(),
  }),
  z.object({
    type: z.literal("workspace_action"),
    action: WorkspaceActionSchema,
  }),
  z.object({
    type: z.literal("agent_event"),
    event: AgentActivityEventSchema,
  }),
  z.object({
    type: z.literal("error"),
    error: z.string(),
  }),
]);

export type QueryStreamEvent = z.infer<typeof QueryStreamEventSchema>;
