import { ReducedValue, StateSchema } from "@langchain/langgraph";
import { z } from "zod";

import {
  MemoryCandidateSchema,
  type DietaryPreferenceMemory,
  type DietaryRestrictionMemory,
  type ExternalInventoryMemory,
  type GoalMemory,
  type MemoryValidationResult,
  type MemoryWriteResult,
  type SemanticMemory,
} from "../memory/schemas";
import { DEFAULT_USER_ID } from "../sqlite.server";
import {
  QueryIntentSchema,
  RecipeRetrievalAuditSchema,
  RecipeSearchRequestSchema,
  RecipeSearchSessionSchema,
} from "./schemas/query";
import type { RankedRecipe } from "./services/recipe-retrieval.server";
import type { RecipeTournamentEvaluation } from "./services/recipe-tournament.server";
import type { RecipeCandidate } from "../recipes/types";

export const FridgeQueryState = new StateSchema({
  userId: z.string().default(DEFAULT_USER_ID),
  fridgeId: z.string(),
  imageId: z.string().nullable().default(null),
  query: z.string(),
  threadId: z.string().default(""),
  requestId: z.string().default("").optional(),
  intent: QueryIntentSchema.nullable().default(null),
  recipeSearch: RecipeSearchRequestSchema.nullable().default(null),
  lastRecipeSearch: RecipeSearchRequestSchema.nullable().default(null),
  recipeSearchSession: RecipeSearchSessionSchema.nullable().default(null),
  recipeClarification: z.string().nullable().default(null),
  recipeSearchError: z.string().nullable().default(null),
  shownRecipeIds: z.array(z.string()).default([]),
  // Persists across turns (never reset by normalizeQueryInput) so a follow-up
  // "show me more recipes" turn can tell whether the last search ran dry.
  recipeSearchExhausted: z.boolean().default(false),
  recipeRewriteCount: z.number().int().nonnegative().default(0),
  recipeRetrievalGrade: z.object({ relevant: z.boolean(), reason: z.string() }).nullable().default(null),
  recipeRetrievalAudit: RecipeRetrievalAuditSchema.nullable().default(null),
  recipeCandidates: z.array(z.custom<RecipeCandidate>()).default([]),
  recipeInputIngredients: z.array(z.string()).default([]),
  tournamentCandidates: z.array(z.custom<RankedRecipe>()).default([]),
  tournamentCandidate: z.custom<RankedRecipe>().nullable().default(null),
  tournamentEvaluations: new ReducedValue(
    z.array(z.custom<RecipeTournamentEvaluation>()).default(() => []),
    { reducer: (current, update) => current.concat(update) },
  ),
  memoryCandidates: z.array(MemoryCandidateSchema).default([]),
  memoryValidations: z.array(z.custom<MemoryValidationResult>()).default([]),
  memoryWriteResults: z.array(z.custom<MemoryWriteResult>()).default([]),
  pendingSemanticMemories: z.array(z.custom<SemanticMemory>()).default([]),
  indexedSemanticMemoryIds: z.array(z.string()).default([]),
  completedOperationKeys: z.array(z.string()).default([]),
  externalInventory: z.array(z.custom<ExternalInventoryMemory>()).default([]),
  dietaryRestrictions: z.array(z.custom<DietaryRestrictionMemory>()).default([]),
  dietaryPreferences: z.array(z.custom<DietaryPreferenceMemory>()).default([]),
  activeGoals: z.array(z.custom<GoalMemory>()).default([]),
  semanticMemories: z.array(z.custom<SemanticMemory>()).default([]),
  visualEvidence: z.array(z.object({
    cropId: z.string(),
    itemId: z.string(),
    displayName: z.string(),
    imageId: z.string(),
  })).default([]),
  context: z.record(z.string(), z.unknown()).default({}),
  answer: z.string().nullable().default(null),
});

export type FridgeQueryStateValue = typeof FridgeQueryState.State;
