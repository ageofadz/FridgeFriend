import { z } from "zod";

export const OrganizationPlanStatusSchema = z.enum([
  "pending",
  "completed",
  "stale",
  "superseded",
]);

export const OrganizationPlanPrioritySchema = z.enum([
  "food_safety_freshness",
  "placement_correction",
]);

export const OrganizationMoveSchema = z.object({
  itemId: z.string().min(1),
  fromZoneId: z.string().min(1),
  toZoneId: z.string().min(1),
  rationale: z.string().trim().min(1),
});

export const OrganizationPlanDraftSchema = z.object({
  summary: z.string().trim().min(1),
  moves: z.array(OrganizationMoveSchema).min(1),
});

export const OrganizationPlanSchema = OrganizationPlanDraftSchema.extend({
  id: z.string().min(1),
  requestId: z.string().min(1),
  userId: z.string().min(1),
  fridgeId: z.string().min(1),
  imageId: z.string().min(1),
  inventoryFingerprint: z.string().min(1),
  priority: OrganizationPlanPrioritySchema,
  status: OrganizationPlanStatusSchema,
  createdAt: z.string().min(1),
  completedAt: z.string().nullable(),
});

export const OrganizationPlanProviderSchema = {
  type: "object",
  properties: {
    summary: { type: "string" },
    moves: {
      type: "array",
      items: {
        type: "object",
        properties: {
          itemId: { type: "string" },
          fromZoneId: { type: "string" },
          toZoneId: { type: "string" },
          rationale: { type: "string" },
        },
        required: ["itemId", "fromZoneId", "toZoneId", "rationale"],
      },
    },
  },
  required: ["summary", "moves"],
} as const;

export type OrganizationPlan = z.infer<typeof OrganizationPlanSchema>;
export type OrganizationPlanDraft = z.infer<typeof OrganizationPlanDraftSchema>;
