import { z } from "zod";

import {
  EvalCaseKindSchema,
  EvalSplitSchema,
} from "./eval-result";

// ---------------------------------------------------------------------------
// Shared eval-case base (spec: "Eval case schemas > Common fields")
// ---------------------------------------------------------------------------

export const BaseEvalCaseSchema = z.object({
  caseId: z.string().min(1),
  revision: z.string().min(1),
  kind: EvalCaseKindSchema,
  split: EvalSplitSchema,
  description: z.string().min(1),
  tags: z.array(z.string()).default([]),
});
export type BaseEvalCase = z.infer<typeof BaseEvalCaseSchema>;

// ---------------------------------------------------------------------------
// Replay steps: identified, strictly ordered per call site
// ---------------------------------------------------------------------------

export const ReplayStepSchema = z.object({
  callId: z.string().min(1),
  expectedNode: z.string().min(1),
  expectedPromptName: z.string().optional(),
  expectedSchemaName: z.string().min(1),
  output: z.unknown(),
});
export type ReplayStep = z.infer<typeof ReplayStepSchema>;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

export const BoundingBoxSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  width: z.number().gt(0).max(1),
  height: z.number().gt(0).max(1),
});
export type BoundingBoxFixture = z.infer<typeof BoundingBoxSchema>;

export const StorageLocationSchema = z.enum(["fridge", "freezer", "pantry"]);

// Scanned inventory attached to an imageId (shape of app Inventory, kept
// structural so fixture rows validate without importing server modules).
export const InventoryFixtureItemSchema = z.looseObject({
  id: z.string().min(1),
  name: z.string().min(1),
});
export const InventoryFixtureSchema = z.looseObject({
  items: z.array(InventoryFixtureItemSchema),
});
export type InventoryFixture = z.infer<typeof InventoryFixtureSchema>;

export const MemoryFixtureSchema = z.looseObject({
  kind: z.enum([
    "external_inventory",
    "dietary_restriction",
    "dietary_preference",
    "goal",
    "semantic",
  ]),
  value: z.record(z.string(), z.unknown()),
});
export type MemoryFixture = z.infer<typeof MemoryFixtureSchema>;

export const RecipeFixtureSchema = z.looseObject({
  id: z.string().min(1),
  name: z.string().min(1),
});
export type RecipeFixture = z.infer<typeof RecipeFixtureSchema>;

export const KnowledgeFixtureSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  content: z.string().min(1),
  tags: z.array(z.string()).default([]),
});
export type KnowledgeFixture = z.infer<typeof KnowledgeFixtureSchema>;

export const ImageFixtureSchema = z.object({
  imageId: z.string().min(1),
  // Data URL, or a repo-relative path to a committed fixture image.
  dataUrl: z.string().optional(),
  fixturePath: z.string().optional(),
});
export type ImageFixture = z.infer<typeof ImageFixtureSchema>;

export const WorkspaceFixtureSchema = z.object({
  itemIds: z.array(z.string()).default([]),
  zoneIds: z.array(z.string()).default([]),
  recipeIds: z.array(z.string()).default([]),
  imageIds: z.array(z.string()).default([]),
  boundingBoxes: z
    .array(z.object({ imageId: z.string(), boundingBox: BoundingBoxSchema }))
    .default([]),
});
export type WorkspaceFixture = z.infer<typeof WorkspaceFixtureSchema>;

export const QueryFixturesSchema = z.object({
  inventory: InventoryFixtureSchema.nullable().default(null),
  memories: z.array(MemoryFixtureSchema).default([]),
  recipes: z.array(RecipeFixtureSchema).default([]),
  recipeCandidates: z.array(z.record(z.string(), z.unknown())).default([]),
  recipeTagCandidates: z.array(z.record(z.string(), z.unknown())).default([]),
  recipeIngredientCandidates: z.array(z.record(z.string(), z.unknown())).default([]),
  knowledgeDocuments: z.array(KnowledgeFixtureSchema).default([]),
  images: z.array(ImageFixtureSchema).default([]),
  workspace: WorkspaceFixtureSchema.default({
    itemIds: [],
    zoneIds: [],
    recipeIds: [],
    imageIds: [],
    boundingBoxes: [],
  }),
});
export type QueryFixtures = z.infer<typeof QueryFixturesSchema>;

// ---------------------------------------------------------------------------
// Graph input / resume (structural mirrors of QueryGraphInput / QueryResume)
// ---------------------------------------------------------------------------

export const QueryCaseInputSchema = z.object({
  userId: z.string().default("eval-user"),
  fridgeId: z.string().min(1),
  imageId: z.string().nullable().default(null),
  query: z.string().min(1),
  recipeContinuation: z.boolean().optional(),
  conversationContext: z.record(z.string(), z.unknown()).optional(),
  recentChatMessages: z
    .array(z.object({ role: z.enum(["user", "assistant"]), text: z.string() }))
    .optional(),
});
export type QueryCaseInput = z.infer<typeof QueryCaseInputSchema>;

export const QueryCaseResumeSchema = z.object({
  answers: z.record(z.string(), z.string()).default({}),
  skipped: z.array(z.string()).default([]),
  splitReview: z.object({ approved: z.boolean() }).optional(),
  inventoryMutationReview: z.object({ approved: z.boolean() }).optional(),
});
export type QueryCaseResume = z.infer<typeof QueryCaseResumeSchema>;

// ---------------------------------------------------------------------------
// Expectations
// ---------------------------------------------------------------------------

export const QUERY_INTENT_VALUES = [
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
export const QueryIntentExpectationSchema = z.enum(QUERY_INTENT_VALUES);

export const QueryExpectationSchema = z.object({
  intent: QueryIntentExpectationSchema.optional(),
  terminalRoute: z.string().optional(),
  requiredNodes: z.array(z.string()).default([]),
  forbiddenNodes: z.array(z.string()).default([]),
  orderedNodeGroups: z.array(z.array(z.string())).default([]),
  requiredActionTypes: z.array(z.string()).default([]),
  forbiddenActionTypes: z.array(z.string()).default([]),
  allowedItemIds: z.array(z.string()).optional(),
  allowedZoneIds: z.array(z.string()).optional(),
  allowedRecipeIds: z.array(z.string()).optional(),
  expectedInterrupt: z.boolean().optional(),
  expectedMutationCount: z.number().int().nonnegative().optional(),
  requiredFacts: z.array(z.string()).default([]),
  prohibitedClaims: z.array(z.string()).default([]),
  minimumRecipeProvenance: z.number().int().nonnegative().optional(),
  requireVerifiedMemoryWrite: z.boolean().optional(),
});
export type QueryExpectation = z.infer<typeof QueryExpectationSchema>;

// ---------------------------------------------------------------------------
// Query eval case
// ---------------------------------------------------------------------------

export const QueryEvalCaseSchema = BaseEvalCaseSchema.extend({
  input: QueryCaseInputSchema,
  fixtures: QueryFixturesSchema.default({
    inventory: null,
    memories: [],
    recipes: [],
    recipeCandidates: [],
    recipeTagCandidates: [],
    recipeIngredientCandidates: [],
    knowledgeDocuments: [],
    images: [],
    workspace: { itemIds: [], zoneIds: [], recipeIds: [], imageIds: [], boundingBoxes: [] },
  }),
  replay: z.array(ReplayStepSchema).optional(),
  // Resume payload applied after an expected interrupt (approve/reject flows).
  resume: QueryCaseResumeSchema.optional(),
  expected: QueryExpectationSchema,
});
export type QueryEvalCase = z.infer<typeof QueryEvalCaseSchema>;
