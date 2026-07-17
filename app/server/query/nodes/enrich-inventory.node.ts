import { getWriter, interrupt } from "@langchain/langgraph";
import { z } from "zod";

import {
  CHAT_VISION_PROVIDER as CHAT_PROVIDER,
  CHAT_VISION_MODEL as VISION_MODEL,
} from "../../ai/chat-model.server";
import { appendFridgeInventoryEnrichments } from "../../inventories.server";
import type { InventoryEnrichment } from "../../scan/schemas/inventory";
import { createVisionModel } from "../../scan/services/vision-model.server";
import { promptMessages } from "../../scan/services/prompt-messages.server";
import type { QueryGraphDependencies } from "../schemas/query";
import {
  InventoryClarificationResumeSchema,
  InventoryEnrichmentFieldSchema,
  type InventoryClarificationResume,
} from "../schemas/query";
import { createQueryModel } from "../services/query-model.server";
import { cropImageBoundingBoxDataUrl } from "../services/focused-visual-context.server";
import { loadInventoryContext } from "../services/inventory-context.server";
import type { FridgeQueryStateValue } from "../state";

const MAX_ENRICHMENT_ATTEMPTS = 2;
const MAX_ENRICHMENT_ITEMS = 5;

const EnrichmentValuesSchema = z.object({
  label: z.string().min(1).nullable().default(null),
  variant: z.string().min(1).nullable().default(null),
  amount: z.number().nonnegative().nullable().default(null),
  unit: z.enum(["count", "g", "kg", "oz", "lb", "ml", "l", "package", "container", "unknown"]).nullable().default(null),
  fillLevel: z.number().min(0).max(1).nullable().default(null),
  expirationDate: z.string().min(1).nullable().default(null),
  opened: z.boolean().nullable().default(null),
  confidence: z.number().min(0).max(1).default(0.5),
});

type EnrichmentField = z.infer<typeof InventoryEnrichmentFieldSchema>;
type EnrichmentStep = {
  itemId: string;
  displayName: string;
  fields: EnrichmentField[];
  method: "focused_vlm" | "ask_user";
  imageId: string | null;
  boundingBox: { x: number; y: number; width: number; height: number } | null;
};
type PendingInventoryEnrichment = InventoryEnrichment & { itemId: string };
type InventoryContext = NonNullable<Awaited<ReturnType<typeof loadInventoryContext>>>;
type InventoryContextItem = InventoryContext["items"][number];

function normalizedTerms(value: string) {
  return value.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean);
}

function enrichmentRequirement(state: FridgeQueryStateValue) {
  const routing = state.context.intentRouting;
  if (typeof routing !== "object" || routing === null || !("enrichment" in routing)) {
    return { itemNames: [], fields: [] as EnrichmentField[] };
  }

  const parsed = z.object({
    enrichment: z.object({
      itemNames: z.array(z.string()).default([]),
      fields: z.array(InventoryEnrichmentFieldSchema).default([]),
    }),
  }).safeParse(routing);

  return parsed.success ? parsed.data.enrichment : { itemNames: [], fields: [] as EnrichmentField[] };
}

function enrichmentContext(state: FridgeQueryStateValue) {
  const current = state.context.inventoryEnrichment;
  return z.object({
    attempts: z.number().int().nonnegative().default(0),
    plan: z.array(z.custom<EnrichmentStep>()).default([]),
    limitations: z.array(z.string()).default([]),
  }).parse(current ?? {});
}

function pendingInventoryEnrichments(state: FridgeQueryStateValue) {
  return z.array(z.custom<PendingInventoryEnrichment>()).parse(state.context.pendingInventoryEnrichments ?? []);
}

function inventoryEnrichmentOperationKey(imageId: string, enrichment: PendingInventoryEnrichment) {
  return `inventory_enrichment:${imageId}:${JSON.stringify(enrichment)}`;
}

function fieldIsKnown(item: InventoryContextItem, field: EnrichmentField) {
  if (field === "identity") return item.attributes.variant !== null || item.confidence >= 0.9;
  if (field === "quantity") return item.quantity.amount !== null && item.quantity.precision !== "unknown";
  if (field === "fill_level") return item.quantity.fillLevel !== null;
  if (field === "expiration_date") return item.attributes.expirationDate !== null;
  return item.attributes.opened !== null;
}

function matchingItems(
  inventory: InventoryContext,
  itemNames: string[],
) {
  if (itemNames.length === 0) return [];
  const requested = itemNames.map(normalizedTerms).filter((terms) => terms.length > 0);
  const requestedIds = new Set(itemNames.map((itemName) => itemName.trim()).filter(Boolean));
  return inventory.items.filter((item) => {
    if (requestedIds.has(item.id)) {
      return true;
    }

    const terms = new Set(normalizedTerms(`${item.displayName} ${item.canonicalName}`));
    return requested.some((candidate) => candidate.some((term) => terms.has(term)));
  });
}

function questionFor(step: EnrichmentStep) {
  const field = step.fields[0];
  if (field === "quantity") return `How much ${step.displayName} do you have?`;
  if (field === "opened") return `Is the ${step.displayName} opened?`;
  if (field === "expiration_date") return `What is the expiry date on the ${step.displayName}?`;
  if (field === "identity") return `What exactly is the ${step.displayName}?`;
  return `How full is the ${step.displayName}?`;
}

function clarificationKey(itemId: string, field: EnrichmentField) {
  return `${itemId}:${field}`;
}

function fieldsWithValues(values: z.infer<typeof EnrichmentValuesSchema>, requested: EnrichmentField[]) {
  return requested.filter((field) => {
    if (field === "identity") return values.label !== null || values.variant !== null;
    if (field === "quantity") return values.amount !== null;
    if (field === "fill_level") return values.fillLevel !== null;
    if (field === "expiration_date") return values.expirationDate !== null;
    return values.opened !== null;
  });
}

function enrichmentMethodFor(field: EnrichmentField, observation: InventoryContextItem["location"]["observations"][number] | null) {
  if (!observation) return "ask_user" as const;
  return field === "identity" || field === "quantity" || field === "fill_level"
    ? "focused_vlm" as const
    : "ask_user" as const;
}

function selectedDetailCommand(query: string) {
  const normalizedQuery = query.toLowerCase().replace(/\s+/g, " ").trim();
  return normalizedQuery === "get more detail about this." ||
    normalizedQuery === "get more detail about this";
}

export function createAssessInventoryEnrichmentNode(deps: QueryGraphDependencies = {}) {
  return async function assessInventoryEnrichmentNode(state: FridgeQueryStateValue) {
    if (state.intent === "expiry") {
      return { context: { ...state.context, inventoryEnrichment: { attempts: 0, plan: [], limitations: [] } } };
    }
    const requirement = enrichmentRequirement(state);
    const current = enrichmentContext(state);
    if (current.plan.some((step) => step.method === "ask_user")) {
      return { context: { ...state.context, inventoryEnrichment: current } };
    }

    const inventory = await loadInventoryContext(state, deps);
    if (!inventory || requirement.fields.length === 0 || requirement.itemNames.length === 0) {
      return { context: { ...state.context, inventoryEnrichment: { ...current, plan: [] } } };
    }

    if (current.attempts >= MAX_ENRICHMENT_ATTEMPTS) {
      return {
        context: {
          ...state.context,
          inventoryEnrichment: {
            ...current,
            plan: [],
            limitations: [...current.limitations, "The requested inventory details could not be confirmed within the enrichment limit."],
          },
        },
      };
    }

    const plan = matchingItems(inventory, requirement.itemNames)
      .flatMap((item) => {
        const fields = requirement.fields.filter((field) => !fieldIsKnown(item, field));
        const observation = state.imageId
          ? item.location.observations.find((candidate) => candidate.imageId === state.imageId) ?? null
          : null;
        return fields.map((field) => ({
          itemId: item.id,
          displayName: item.displayName,
          fields: [field],
          method: selectedDetailCommand(state.query) && observation
            ? "focused_vlm" as const
            : enrichmentMethodFor(field, observation),
          imageId: observation?.imageId ?? null,
          boundingBox: observation?.boundingBox ?? null,
        }));
      })
      .slice(0, MAX_ENRICHMENT_ITEMS);

    return {
      context: {
        ...state.context,
        inventoryEnrichment: { ...current, plan },
      },
    };
  };
}

export function routeInventoryEnrichment(state: FridgeQueryStateValue) {
  const current = enrichmentContext(state);
  if (current.plan.length === 0) return "continue";
  if (current.plan.some((step) => step.method === "focused_vlm")) return "focused_vlm";
  return "ask_user";
}

export function createRunFocusedInventoryEnrichmentNode(deps: QueryGraphDependencies = {}) {
  return async function runFocusedInventoryEnrichmentNode(state: FridgeQueryStateValue) {
    const writer = getWriter();
    const current = enrichmentContext(state);
    const model = deps.enrichmentModel ?? createVisionModel();
    const loadedPrompt = deps.promptBundle?.focusedInventoryEnrichment;
    if (!loadedPrompt) throw new Error("Focused inventory enrichment prompt is unavailable.");
    const structuredModel = model.withStructuredOutput(EnrichmentValuesSchema, { name: "FocusedInventoryEnrichment" });
    const pending: PendingInventoryEnrichment[] = [];
    const limitations = [...current.limitations];

    for (const step of current.plan.filter((candidate) => candidate.method === "focused_vlm")) {
      if (!step.imageId || !step.boundingBox) {
        limitations.push(`No source image is available to inspect ${step.displayName}.`);
        continue;
      }

      writer?.({ type: "agent_event", event: { type: "enrichment_started", itemId: step.itemId, fields: step.fields } });
      try {
        const crop = await cropImageBoundingBoxDataUrl({
          imageId: step.imageId,
          boundingBox: step.boundingBox,
          loadImageDataUrlForQuery: deps.loadImageDataUrlForQuery,
        });
        const result = await structuredModel.invoke(await promptMessages(loadedPrompt, {
          focused_inventory_enrichment_context_json: JSON.stringify({ item: step.displayName, requestedFields: step.fields }),
          image_data_url: crop,
        }), { tags: ["query", "focused_enrichment"], metadata: { imageId: step.imageId, itemId: step.itemId, provider: CHAT_PROVIDER, model: VISION_MODEL, langsmithPromptName: loadedPrompt.name, langsmithPromptRef: loadedPrompt.ref } });
        const parsed = EnrichmentValuesSchema.safeParse(result);
        if (!parsed.success) {
          const error = `Focused visual enrichment returned invalid output for ${step.displayName}: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`;
          limitations.push(error);
          writer?.({ type: "agent_event", event: { type: "enrichment_failed", itemId: step.itemId, error } });
          continue;
        }
        const fields = fieldsWithValues(parsed.data, step.fields);
        pending.push({
          itemId: step.itemId,
          source: "focused_vlm",
          fields,
          confidence: parsed.data.confidence,
          observedAt: new Date().toISOString(),
          imageId: step.imageId,
          boundingBox: step.boundingBox,
          values: parsed.data,
        });
        for (const field of step.fields.filter((field) => !fields.includes(field))) {
          current.plan.push({
            ...step,
            fields: [field],
            method: "ask_user",
            imageId: null,
            boundingBox: null,
          });
        }
        writer?.({ type: "agent_event", event: { type: "enrichment_completed", itemId: step.itemId, fields: step.fields } });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        limitations.push(`Focused visual enrichment failed for ${step.displayName}: ${message}`);
        writer?.({ type: "agent_event", event: { type: "enrichment_failed", itemId: step.itemId, error: message } });
      }
    }

    return {
      context: {
        ...state.context,
        inventoryEnrichment: {
          attempts: current.attempts + 1,
          plan: current.plan.filter((step) => step.method === "ask_user"),
          limitations,
        },
        pendingInventoryEnrichments: [
          ...pendingInventoryEnrichments(state),
          ...pending.filter((entry) => entry.fields.length > 0),
        ],
      },
    };
  };
}

async function structuredAnswer(input: {
  state: FridgeQueryStateValue;
  step: EnrichmentStep;
  answer: string;
  source: "user" | "inference";
  model: ReturnType<typeof createQueryModel>;
  promptBundle: QueryGraphDependencies["promptBundle"];
}) {
  const model = input.model.withStructuredOutput(EnrichmentValuesSchema, { name: "InventoryClarificationValue" });
  const loadedPrompt = input.source === "user" ? input.promptBundle?.inventoryClarificationUser : input.promptBundle?.inventoryClarificationInference;
  if (!loadedPrompt) throw new Error("Inventory clarification prompt is unavailable.");
  const result = await model.invoke(await promptMessages(loadedPrompt, {
    inventory_clarification_context_json: JSON.stringify({ item: input.step.displayName, requestedFields: input.step.fields, answer: input.answer, query: input.state.query }),
  }));
  return EnrichmentValuesSchema.safeParse(result);
}

export function createRequestInventoryClarificationNode(deps: QueryGraphDependencies = {}) {
  return async function requestInventoryClarificationNode(state: FridgeQueryStateValue) {
    const writer = getWriter();
    const current = enrichmentContext(state);
    const steps = current.plan.filter((step) => step.method === "ask_user");
    const questions = steps.flatMap((step) => step.fields.map((field) => ({ itemId: step.itemId, field, question: questionFor({ ...step, fields: [field] }) }))).slice(0, MAX_ENRICHMENT_ITEMS);
    for (const question of questions) {
      writer?.({ type: "agent_event", event: { type: "clarification_required", itemId: question.itemId, question: question.question } });
    }
    const resumed = interrupt({ type: "inventory_clarification", questions });
    const parsedResume = InventoryClarificationResumeSchema.safeParse(resumed);
    const resume: InventoryClarificationResume = parsedResume.success ? parsedResume.data : { answers: {}, skipped: questions.map((question) => clarificationKey(question.itemId, question.field)) };
    const model = deps.enrichmentModel ?? createQueryModel();
    const pending: PendingInventoryEnrichment[] = [];
    const limitations = [...current.limitations];

    for (const question of questions) {
      const step = steps.find((candidate) => candidate.itemId === question.itemId && candidate.fields.includes(question.field));
      if (!step) continue;
      const key = clarificationKey(question.itemId, question.field);
      const answer = resume.answers[key];
      const source = answer ? "user" as const : "inference" as const;
      const parsed = await structuredAnswer({ state, step: { ...step, fields: [question.field] }, answer: answer ?? "The user skipped this question.", source, model, promptBundle: deps.promptBundle });
      if (!parsed.success) {
        limitations.push(`Could not parse the clarification for ${step.displayName}: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
        continue;
      }
      const fields = fieldsWithValues(parsed.data, [question.field]);
      if (fields.length === 0) {
        limitations.push(`${step.displayName} remains unconfirmed.`);
        continue;
      }
      pending.push({
        itemId: step.itemId,
        source,
        fields,
        confidence: source === "user" ? 1 : Math.min(parsed.data.confidence, 0.3),
        observedAt: new Date().toISOString(),
        imageId: null,
        boundingBox: null,
        values: parsed.data,
      });
    }

    return {
      context: {
        ...state.context,
        inventoryEnrichment: { attempts: current.attempts + 1, plan: [], limitations },
        pendingInventoryEnrichments: [
          ...pendingInventoryEnrichments(state),
          ...pending,
        ],
      },
    };
  };
}

export function createPersistInventoryEnrichmentNode() {
  return async function persistInventoryEnrichmentNode(state: FridgeQueryStateValue) {
    const pending = pendingInventoryEnrichments(state);

    if (!state.imageId || pending.length === 0) {
      return {
        context: {
          ...state.context,
          pendingInventoryEnrichments: [],
        },
      };
    }

    const pendingWrites = pending.filter((enrichment) =>
      !state.completedOperationKeys.includes(inventoryEnrichmentOperationKey(state.imageId!, enrichment))
    );

    if (pendingWrites.length > 0) {
      appendFridgeInventoryEnrichments({
        imageId: state.imageId,
        enrichments: pendingWrites,
      });
    }

    return {
      completedOperationKeys: [
        ...state.completedOperationKeys,
        ...pendingWrites.map((enrichment) => inventoryEnrichmentOperationKey(state.imageId!, enrichment)),
      ],
      context: {
        ...state.context,
        pendingInventoryEnrichments: [],
      },
    };
  };
}
