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

export const InventoryItemCandidateSchema = z.object({
  kind: z.literal("inventory_item"),
  scope: z.literal("fridge"),
  action: z.enum(["upsert", "remove", "consume"]),
  name: z.string(),
  storageLocation: StorageLocationSchema,
  quantity: QuantitySchema.nullable(),
  notes: z.string().nullable().default(null),
  explicit: z.boolean(),
});

export const DietaryRestrictionCandidateSchema = z.object({
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
  severity: z.preprocess(
    coerceDietaryRestrictionSeverity,
    z.enum(["avoid", "strict_avoid"]),
  ),
  notes: z.string().nullable().default(null),
  explicit: z.boolean(),
});

export const DietaryPreferenceCandidateSchema = z.object({
  kind: z.literal("preference"),
  scope: z.literal("user"),
  action: z.enum(["upsert", "remove"]),
  subject: z.string(),
  sentiment: z.preprocess(
    coercePreferenceSentiment,
    z.enum(["like", "dislike", "prefer", "avoid"]),
  ),
  strength: z.number().int().min(1).max(5),
  notes: z.string().nullable().default(null),
  explicit: z.boolean(),
});

export const GoalCandidateSchema = z.object({
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
});

export const MiscMemoryCandidateSchema = z.object({
  kind: z.literal("misc"),
  scope: z.enum(["user", "fridge"]),
  action: z.enum(["upsert", "remove"]),
  category: z.string(),
  content: z.string(),
  explicit: z.boolean(),
});

export const MemoryCandidateSchema = z.discriminatedUnion("kind", [
  InventoryItemCandidateSchema,
  DietaryRestrictionCandidateSchema,
  DietaryPreferenceCandidateSchema,
  GoalCandidateSchema,
  MiscMemoryCandidateSchema,
]);

function describeCandidateIssue(entry: unknown, error: z.ZodError) {
  const kind = entry && typeof entry === "object" && "kind" in entry ? String(entry.kind) : "unknown";
  const action = entry && typeof entry === "object" && "action" in entry ? String(entry.action) : "unknown";
  const issue = error.issues[0];

  return `kind=${kind} action=${action}: ${issue ? `${issue.path.join(".") || "candidate"} ${issue.message}` : "invalid candidate"}`;
}

type PreferenceSentiment = "like" | "dislike" | "prefer" | "avoid";
type DietaryRestrictionSeverity = "avoid" | "strict_avoid";

const PREFERENCE_SENTIMENTS: ReadonlyMap<string, PreferenceSentiment> = new Map([
  ["like", "like"],
  ["likes", "like"],
  ["liked", "like"],
  ["enjoy", "like"],
  ["enjoys", "like"],
  ["enjoyed", "like"],
  ["love", "like"],
  ["loves", "like"],
  ["loved", "like"],
  ["favorite", "like"],
  ["favourite", "like"],
  ["positive", "like"],
  ["dislike", "dislike"],
  ["dislikes", "dislike"],
  ["disliked", "dislike"],
  ["hate", "dislike"],
  ["hates", "dislike"],
  ["hated", "dislike"],
  ["negative", "dislike"],
  ["prefer", "prefer"],
  ["prefers", "prefer"],
  ["preferred", "prefer"],
  ["avoid", "avoid"],
  ["avoids", "avoid"],
  ["avoided", "avoid"],
] as const);

function canonicalPreferenceSentiment(value: string) {
  return PREFERENCE_SENTIMENTS.get(value.trim().toLocaleLowerCase()) ?? value;
}

function coerceDietaryRestrictionSeverity(value: unknown): unknown {
  if (typeof value === "string") {
    const normalized = value.trim().toLocaleLowerCase().replaceAll(" ", "_");

    if (normalized === "avoid" || normalized === "strict_avoid") {
      return normalized;
    }
  }

  if (value && typeof value === "object") {
    const candidate = value as Record<string, unknown>;
    const fields = [
      candidate.value,
      candidate.severity,
      candidate.restriction,
      candidate.label,
      candidate.type,
    ];

    for (const field of fields) {
      const coerced: unknown = coerceDietaryRestrictionSeverity(field);

      if (coerced === "avoid" || coerced === "strict_avoid") {
        return coerced;
      }
    }
  }

  return value;
}

function canonicalOrDefaultDietaryRestrictionSeverity(value: unknown): DietaryRestrictionSeverity {
  const coerced = coerceDietaryRestrictionSeverity(value);

  return coerced === "avoid" || coerced === "strict_avoid" ? coerced : "strict_avoid";
}

function canonicalOrDefaultPreferenceSentiment(value: unknown): PreferenceSentiment {
  const coerced = coercePreferenceSentiment(value);

  return typeof coerced === "string" && PREFERENCE_SENTIMENTS.has(coerced.trim().toLocaleLowerCase())
    ? PREFERENCE_SENTIMENTS.get(coerced.trim().toLocaleLowerCase()) ?? "like"
    : "like";
}

function coercePreferenceSentiment(value: unknown) {
  if (typeof value === "string") {
    return canonicalPreferenceSentiment(value);
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const candidate = value as Record<string, unknown>;
  const fields = [
    candidate.value,
    candidate.sentiment,
    candidate.polarity,
    candidate.preference,
    candidate.label,
  ];

  for (const field of fields) {
    if (typeof field !== "string") {
      continue;
    }

    const canonical = canonicalPreferenceSentiment(field);

    if (canonical !== field) {
      return canonical;
    }

    if (PREFERENCE_SENTIMENTS.has(field.trim().toLocaleLowerCase())) {
      return canonical;
    }
  }

  return value;
}

function parseProviderPreferenceCandidate(entry: unknown) {
  if (!entry || typeof entry !== "object") {
    return null;
  }

  const candidate = entry as Record<string, unknown>;

  if (
    candidate.kind !== "preference" ||
    candidate.explicit !== true ||
    typeof candidate.subject !== "string" ||
    candidate.subject.trim().length === 0
  ) {
    return null;
  }

  const action = candidate.action === "remove" ? "remove" : "upsert";
  const strength = typeof candidate.strength === "number" &&
    Number.isInteger(candidate.strength) &&
    candidate.strength >= 1 &&
    candidate.strength <= 5
    ? candidate.strength
    : 3;
  const parsed = DietaryPreferenceCandidateSchema.safeParse({
    kind: "preference",
    scope: "user",
    action,
    subject: candidate.subject,
    sentiment: canonicalOrDefaultPreferenceSentiment(candidate.sentiment),
    strength,
    notes: typeof candidate.notes === "string" ? candidate.notes : null,
    explicit: true,
  });

  return parsed.success ? parsed.data : null;
}

function repairedProviderCandidate(entry: unknown, error: z.ZodError) {
  const severityIssue = error.issues.some((issue) => issue.path.length === 1 && issue.path[0] === "severity");

  if (severityIssue) {
    return parseProviderDietaryRestrictionCandidate(entry);
  }

  const sentimentIssue = error.issues.some((issue) => issue.path.length === 1 && issue.path[0] === "sentiment");

  if (!sentimentIssue) {
    return null;
  }

  return parseProviderPreferenceCandidate(entry);
}

function parseProviderDietaryRestrictionCandidate(entry: unknown) {
  if (!entry || typeof entry !== "object") {
    return null;
  }

  const candidate = entry as Record<string, unknown>;

  if (
    candidate.kind !== "dietary_restriction" ||
    candidate.explicit !== true ||
    typeof candidate.subject !== "string" ||
    candidate.subject.trim().length === 0
  ) {
    return null;
  }

  const restrictionTypes = new Set(["allergy", "intolerance", "religious", "medical", "other"]);
  const action = candidate.action === "remove" ? "remove" : "upsert";
  const restrictionType = typeof candidate.restrictionType === "string" && restrictionTypes.has(candidate.restrictionType)
    ? candidate.restrictionType
    : "other";
  const parsed = DietaryRestrictionCandidateSchema.safeParse({
    kind: "dietary_restriction",
    scope: "user",
    action,
    restrictionType,
    subject: candidate.subject,
    severity: canonicalOrDefaultDietaryRestrictionSeverity(candidate.severity),
    notes: typeof candidate.notes === "string" ? candidate.notes : null,
    explicit: true,
  });

  return parsed.success ? parsed.data : null;
}

export const MemoryExtractionResultSchema = z.object({
  candidates: z.array(z.unknown()).default([]).transform((entries) =>
    entries.flatMap((entry): MemoryCandidate[] => {
      const parsed = MemoryCandidateSchema.safeParse(entry);

      if (parsed.success) {
        return [parsed.data];
      }

      const repaired = repairedProviderCandidate(entry, parsed.error);

      if (repaired) {
        return [repaired];
      }

      console.warn(
        `Memory extraction dropped an invalid candidate (${describeCandidateIssue(entry, parsed.error)})`,
      );
      return [];
    })
  ),
});

/**
 * Gemini-facing structured-output schema. The provider's JSON Schema subset
 * cannot express the per-kind discriminated union above (no oneOf and no
 * per-branch required lists), so kinds are flattened into one object with a
 * combined action enum and only the shared fields required. That means the
 * model can emit kind/action/field combinations the zod union rejects; the
 * field descriptions below spell out the valid combinations to steer the
 * model, and MemoryExtractionResultSchema drops any remaining invalid
 * candidates individually with a warning instead of failing the extraction.
 */
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
            description:
              "Durable memory category. Required fields per kind: inventory_item needs name, storageLocation, and quantity; dietary_restriction needs restrictionType, subject, and severity; preference needs subject, sentiment, and strength; goal needs goalType and description; misc needs category and content.",
          },
          scope: {
            type: "string",
            enum: ["user", "fridge"],
            description:
              "Whether the memory belongs to the user or current fridge. inventory_item must use fridge; dietary_restriction, preference, and goal must use user; misc may use either.",
          },
          action: {
            type: "string",
            enum: ["upsert", "remove", "consume", "deactivate"],
            description:
              "Requested persistence action. Valid actions per kind: inventory_item allows upsert, remove, or consume; dietary_restriction, preference, and misc allow upsert or remove; goal allows upsert or deactivate.",
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
            description: "Preference sentiment. Use exactly like, dislike, prefer, or avoid. Map enjoy/love/favorite/positive to like; hate/negative to dislike.",
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
