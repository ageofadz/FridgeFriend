import { z } from "zod";

export const STORAGE_LOCATIONS = [
  "fridge",
  "freezer",
  "pantry",
  "counter",
  "cupboard",
  "other",
] as const;

export const QUANTITY_PRECISIONS = ["exact", "estimated", "unknown"] as const;

export const StorageLocationSchema = z.enum(STORAGE_LOCATIONS);

export const QuantitySchema = z.object({
  amount: z.number().nullable(),
  unit: z.string(),
  precision: z.enum(QUANTITY_PRECISIONS),
});

export const QuantityProviderSchema = {
  type: "object",
  properties: {
    amount: {
      type: "number",
      nullable: true,
      description: "Numeric quantity amount, or null when unknown.",
    },
    unit: {
      type: "string",
      description: "Quantity unit such as item, package, pound, gram, cup, or unknown.",
    },
    precision: {
      type: "string",
      enum: QUANTITY_PRECISIONS,
      description: "How exact the quantity is.",
    },
  },
  required: ["amount", "unit", "precision"],
} as const;

export const MemoryCandidateSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("inventory_item"),
    scope: z.literal("fridge"),
    action: z.enum(["upsert", "remove", "consume"]),
    name: z.string(),
    storageLocation: StorageLocationSchema,
    quantity: QuantitySchema.nullable(),
    notes: z.string().nullable().default(null),
    explicit: z.boolean(),
  }),
  z.object({
    kind: z.literal("dietary_restriction"),
    scope: z.literal("user"),
    action: z.enum(["upsert", "remove"]),
    restrictionType: z.enum([
      "allergy",
      "intolerance",
      "religious",
      "medical",
      "other",
    ]),
    subject: z.string(),
    severity: z.enum(["avoid", "strict_avoid"]),
    notes: z.string().nullable().default(null),
    explicit: z.boolean(),
  }),
  z.object({
    kind: z.literal("preference"),
    scope: z.literal("user"),
    action: z.enum(["upsert", "remove"]),
    subject: z.string(),
    sentiment: z.enum(["like", "dislike", "prefer", "avoid"]),
    strength: z.number().int().min(1).max(5),
    notes: z.string().nullable().default(null),
    explicit: z.boolean(),
  }),
  z.object({
    kind: z.literal("goal"),
    scope: z.literal("user"),
    action: z.enum(["upsert", "deactivate"]),
    goalType: z.enum([
      "high_protein",
      "weight_loss",
      "budget",
      "quick_meals",
      "reduce_waste",
      "other",
    ]),
    description: z.string(),
    targetValue: z.number().nullable().default(null),
    targetUnit: z.string().nullable().default(null),
    priority: z.number().int().min(1).max(5).default(1),
    explicit: z.boolean(),
  }),
  z.object({
    kind: z.literal("misc"),
    scope: z.enum(["user", "fridge"]),
    action: z.enum(["upsert", "remove"]),
    category: z.string(),
    content: z.string(),
    explicit: z.boolean(),
  }),
]);

export const MemoryExtractionResultSchema = z.object({
  candidates: z.array(MemoryCandidateSchema).default([]),
});

export const MemoryExtractionResultProviderSchema = {
  type: "object",
  properties: {
    candidates: {
      type: "array",
      items: {
        type: "object",
        properties: {
          kind: {
            type: "string",
            enum: [
              "inventory_item",
              "dietary_restriction",
              "preference",
              "goal",
              "misc",
            ],
            description: "Durable memory category.",
          },
          scope: {
            type: "string",
            enum: ["user", "fridge"],
            description: "Whether the memory belongs to the user or current fridge.",
          },
          action: {
            type: "string",
            enum: ["upsert", "remove", "consume", "deactivate"],
            description: "Requested persistence action.",
          },
          name: {
            type: "string",
            description: "Inventory item name.",
          },
          storageLocation: {
            type: "string",
            enum: STORAGE_LOCATIONS,
            description: "Inventory storage location.",
          },
          quantity: {
            type: "object",
            nullable: true,
            properties: QuantityProviderSchema.properties,
            required: QuantityProviderSchema.required,
            description: "Inventory quantity, or null when unstated.",
          },
          restrictionType: {
            type: "string",
            enum: ["allergy", "intolerance", "religious", "medical", "other"],
            description: "Dietary restriction type.",
          },
          subject: {
            type: "string",
            description: "Restriction, preference, or goal subject.",
          },
          severity: {
            type: "string",
            enum: ["avoid", "strict_avoid"],
            description: "Dietary restriction severity.",
          },
          sentiment: {
            type: "string",
            enum: ["like", "dislike", "prefer", "avoid"],
            description: "Preference sentiment.",
          },
          strength: {
            type: "integer",
            minimum: 1,
            maximum: 5,
            description: "Preference strength from 1 to 5.",
          },
          goalType: {
            type: "string",
            enum: [
              "high_protein",
              "weight_loss",
              "budget",
              "quick_meals",
              "reduce_waste",
              "other",
            ],
            description: "Goal category.",
          },
          description: {
            type: "string",
            description: "Goal description.",
          },
          targetValue: {
            type: "number",
            nullable: true,
            description: "Goal target value, or null when unstated.",
          },
          targetUnit: {
            type: "string",
            nullable: true,
            description: "Goal target unit, or null when unstated.",
          },
          priority: {
            type: "integer",
            minimum: 1,
            maximum: 5,
            description: "Goal priority from 1 to 5.",
          },
          category: {
            type: "string",
            description: "Miscellaneous memory category.",
          },
          content: {
            type: "string",
            description: "Miscellaneous durable memory content.",
          },
          notes: {
            type: "string",
            nullable: true,
            description: "Optional note, or null when none.",
          },
          explicit: {
            type: "boolean",
            description: "True only when explicitly stated by the user.",
          },
        },
        required: ["kind", "scope", "action", "explicit"],
      },
      description: "Durable memory candidates extracted from the user message.",
    },
  },
  required: ["candidates"],
} as const;

export type StorageLocation = z.infer<typeof StorageLocationSchema>;
export type Quantity = z.infer<typeof QuantitySchema>;
export type MemoryCandidate = z.infer<typeof MemoryCandidateSchema>;

export type MemoryValidationResult = {
  candidate: MemoryCandidate;
  accepted: boolean;
  reason: string;
};

export type MemoryWriteResult = {
  kind: MemoryCandidate["kind"];
  action: MemoryCandidate["action"];
  status: "persisted" | "skipped";
  targetId: string | null;
  message: string;
};

export type ExternalInventoryMemory = {
  id: string;
  fridgeId: string;
  name: string;
  canonicalName: string | null;
  storageLocation: StorageLocation;
  quantity: Quantity | null;
  status: "available" | "possibly_available" | "consumed" | "removed";
  confidence: number;
  source: string;
  notes: string | null;
  expirationDate?: string | null;
  expirationDateSource?: "user" | "observed" | null;
  lastConfirmedAt: string;
  createdAt: string;
  updatedAt: string;
};

export type DietaryRestrictionMemory = {
  id: string;
  userId: string;
  restrictionType: "allergy" | "intolerance" | "religious" | "medical" | "other";
  subject: string;
  severity: "avoid" | "strict_avoid";
  notes: string | null;
  source: string;
  createdAt: string;
  updatedAt: string;
};

export type DietaryPreferenceMemory = {
  id: string;
  userId: string;
  subject: string;
  sentiment: "like" | "dislike" | "prefer" | "avoid";
  strength: number;
  notes: string | null;
  source: string;
  createdAt: string;
  updatedAt: string;
};

export type GoalMemory = {
  id: string;
  userId: string;
  goalType:
    | "high_protein"
    | "weight_loss"
    | "budget"
    | "quick_meals"
    | "reduce_waste"
    | "other";
  description: string;
  targetValue: number | null;
  targetUnit: string | null;
  priority: number;
  active: boolean;
  source: string;
  createdAt: string;
  updatedAt: string;
};

export type SemanticMemory = {
  id: string;
  namespaceType: "user" | "fridge";
  namespaceId: string;
  category: string;
  content: string;
  source: string;
  confidence: number;
  active: boolean;
  createdAt: string;
  updatedAt: string;
};

export type MemoryContext = {
  externalInventory: ExternalInventoryMemory[];
  dietaryRestrictions: DietaryRestrictionMemory[];
  dietaryPreferences: DietaryPreferenceMemory[];
  activeGoals: GoalMemory[];
  semanticMemories: SemanticMemory[];
};
