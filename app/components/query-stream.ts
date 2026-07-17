import { z } from "zod";

import {
  AgentActivityEventSchema,
  WorkspaceActionSchema,
  type AgentActivityEvent,
  type WorkspaceAction,
} from "../workspace/contracts";

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
  | { type: "expiry_plan"; plan: ExpiryPlan }
  | {
    type: "clarification";
    questions: InventoryClarificationQuestion[];
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
    intent: string | null;
    recipes: RecipeCard[];
    expiryPlan?: ExpiryPlan;
    visualEvidence: QueryVisualEvidence[];
    workspaceActions: WorkspaceAction[];
    agentEvents: AgentActivityEvent[];
  }
  | { type: "workspace_action"; action: WorkspaceAction }
  | { type: "agent_event"; event: AgentActivityEvent }
  | {
    type: "error";
    error: string;
  };

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

export type QueryVisualEvidence = {
  itemId: string;
  displayName: string;
  dataUrl: string;
};

export type InventoryClarificationQuestion = {
  itemId: string;
  field: "identity" | "quantity" | "fill_level" | "expiration_date" | "opened";
  question: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isRecipeCard(value: unknown): value is RecipeCard {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    (typeof value.description === "string" || value.description === null) &&
    typeof value.minutes === "number" &&
    Array.isArray(value.matchedIngredients) &&
    value.matchedIngredients.every((ingredient) => typeof ingredient === "string") &&
    Array.isArray(value.missingIngredients) &&
    value.missingIngredients.every((ingredient) => typeof ingredient === "string") &&
    Array.isArray(value.matchedTags) &&
    value.matchedTags.every((tag) => typeof tag === "string") &&
    Array.isArray(value.matchBadges) &&
    value.matchBadges.every((badge) => typeof badge === "string") &&
    (value.usesSoonIngredients === undefined || Array.isArray(value.usesSoonIngredients) && value.usesSoonIngredients.every((ingredient) => typeof ingredient === "string")) &&
    (value.tournamentPlacement === undefined || value.tournamentPlacement === "winner" || value.tournamentPlacement === "finalist")
  );
}

function isExpiryPlanItem(value: unknown): value is ExpiryPlanItem {
  return isRecord(value) &&
    typeof value.id === "string" &&
    (typeof value.visibleItemId === "string" || value.visibleItemId === null) &&
    typeof value.name === "string" && typeof value.ingredientName === "string" &&
    typeof value.storageLocation === "string" && typeof value.date === "string" &&
    typeof value.label === "string" && typeof value.wasteScore === "number" &&
    Number.isFinite(value.wasteScore) &&
    (value.urgency === "fresh" || value.urgency === "use_soon" || value.urgency === "urgent" || value.urgency === "expired" || value.urgency === "unknown") &&
    (value.source === "user_date" || value.source === "observed_date" || value.source === "recorded_date" || value.source === "estimated") &&
    (value.confidence === "high" || value.confidence === "medium" || value.confidence === "low") &&
    (typeof value.dateIssue === "string" || value.dateIssue === null);
}

function isExpiryPlan(value: unknown): value is ExpiryPlan {
  return isRecord(value) && Array.isArray(value.items) && value.items.every(isExpiryPlanItem) &&
    Array.isArray(value.priorityItems) && value.priorityItems.every(isExpiryPlanItem) &&
    Array.isArray(value.expiredItems) && value.expiredItems.every(isExpiryPlanItem);
}

function isRecipeCards(value: unknown): value is RecipeCard[] {
  return Array.isArray(value) && value.every(isRecipeCard);
}

export function parseQueryStreamEvent(line: string): QueryStreamEvent {
  let payload: unknown;

  try {
    payload = JSON.parse(line);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Query stream event was not valid JSON: ${message}`);
  }

  if (!isRecord(payload) || typeof payload.type !== "string") {
    throw new Error("Query stream event did not include a type");
  }

  if (payload.type === "status" && typeof payload.message === "string") {
    return {
      type: "status",
      message: payload.message,
      node: typeof payload.node === "string" ? payload.node : undefined,
    };
  }

  if (
    payload.type === "tool" &&
    typeof payload.name === "string" &&
    typeof payload.message === "string" &&
    (payload.status === "started" ||
      payload.status === "progress" ||
      payload.status === "finished")
  ) {
    return {
      type: "tool",
      name: payload.name,
      status: payload.status,
      message: payload.message,
    };
  }

  if (payload.type === "token" && typeof payload.text === "string") {
    return {
      type: "token",
      text: payload.text,
    };
  }

  if (
    payload.type === "recipe_tournament_started" &&
    typeof payload.candidateCount === "number" &&
    Number.isInteger(payload.candidateCount) &&
    payload.candidateCount > 0 &&
    typeof payload.displaySlotCount === "number" &&
    Number.isInteger(payload.displaySlotCount) &&
    payload.displaySlotCount > 0
  ) {
    return {
      type: "recipe_tournament_started",
      candidateCount: payload.candidateCount,
      displaySlotCount: payload.displaySlotCount,
    };
  }

  if (
    payload.type === "recipe_tournament_update" &&
    isRecipeCards(payload.recipes) &&
    typeof payload.evaluatedCount === "number" &&
    Number.isInteger(payload.evaluatedCount) &&
    typeof payload.totalCount === "number" &&
    Number.isInteger(payload.totalCount) &&
    Array.isArray(payload.droppedRecipeIds) &&
    payload.droppedRecipeIds.every((recipeId) => typeof recipeId === "string")
  ) {
    return {
      type: "recipe_tournament_update",
      recipes: payload.recipes,
      evaluatedCount: payload.evaluatedCount,
      totalCount: payload.totalCount,
      droppedRecipeIds: payload.droppedRecipeIds,
    };
  }

  if (
    payload.type === "recipe_tournament_finished" &&
    isRecipeCards(payload.recipes)
  ) {
    return {
      type: "recipe_tournament_finished",
      recipes: payload.recipes,
    };
  }

  if (payload.type === "expiry_plan" && isExpiryPlan(payload.plan)) {
    return { type: "expiry_plan", plan: payload.plan };
  }

  if (
    payload.type === "clarification" &&
    Array.isArray(payload.questions) &&
    payload.questions.every((question) =>
      isRecord(question) &&
      typeof question.itemId === "string" &&
      (question.field === "identity" || question.field === "quantity" || question.field === "fill_level" || question.field === "expiration_date" || question.field === "opened") &&
      typeof question.question === "string"
    )
  ) {
    return { type: "clarification", questions: payload.questions as InventoryClarificationQuestion[] };
  }

  if (
    payload.type === "inventory_split_review" &&
    typeof payload.zoneId === "string" &&
    typeof payload.summary === "string" &&
    Array.isArray(payload.items) &&
    payload.items.every((item) => isRecord(item) && typeof item.label === "string" && typeof item.name === "string")
  ) {
    return {
      type: "inventory_split_review",
      zoneId: payload.zoneId,
      summary: payload.summary,
      items: payload.items as Array<{ label: string; name: string }>,
    };
  }

  if (
    payload.type === "final" &&
    typeof payload.answer === "string" &&
    isRecipeCards(payload.recipes) &&
    Array.isArray(payload.visualEvidence) &&
    payload.visualEvidence.every(
      (evidence) =>
        isRecord(evidence) &&
        typeof evidence.itemId === "string" &&
        typeof evidence.displayName === "string" &&
        typeof evidence.dataUrl === "string",
    )
  ) {
    const actions = z.array(WorkspaceActionSchema).safeParse(payload.workspaceActions ?? []);
    const events = z.array(AgentActivityEventSchema).safeParse(payload.agentEvents ?? []);
    if (!actions.success || !events.success) {
      throw new Error("Query stream final event contained invalid workspace data");
    }
    return {
      type: "final",
      answer: payload.answer,
      intent: typeof payload.intent === "string" ? payload.intent : null,
      recipes: payload.recipes as RecipeCard[],
      expiryPlan: isExpiryPlan(payload.expiryPlan) ? payload.expiryPlan : undefined,
      visualEvidence: payload.visualEvidence as QueryVisualEvidence[],
      workspaceActions: actions.data,
      agentEvents: events.data,
    };
  }

  if (payload.type === "workspace_action") {
    const action = WorkspaceActionSchema.safeParse(payload.action);
    if (action.success) return { type: "workspace_action", action: action.data };
  }

  if (payload.type === "agent_event") {
    const event = AgentActivityEventSchema.safeParse(payload.event);
    if (event.success) return { type: "agent_event", event: event.data };
  }

  if (payload.type === "error" && typeof payload.error === "string") {
    return {
      type: "error",
      error: payload.error,
    };
  }

  throw new Error(`Query stream event had invalid shape for ${payload.type}`);
}

export function createQueryStreamParser(
  onEvent: (event: QueryStreamEvent) => void,
) {
  let buffer = "";

  function flushLine(line: string) {
    if (line.trim().length === 0) {
      return;
    }

    onEvent(parseQueryStreamEvent(line));
  }

  return {
    push(chunk: string) {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        flushLine(line);
      }
    },
    close() {
      flushLine(buffer);
      buffer = "";
    },
  };
}

export async function readQueryStream(
  response: Response,
  onEvent: (event: QueryStreamEvent) => void,
) {
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `HTTP ${response.status}`);
  }

  if (!response.body) {
    throw new Error("Query graph response did not include a stream body");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parser = createQueryStreamParser(onEvent);

  while (true) {
    const result = await reader.read();

    if (result.done) {
      break;
    }

    parser.push(decoder.decode(result.value, { stream: true }));
  }

  const remaining = decoder.decode();

  if (remaining.length > 0) {
    parser.push(remaining);
  }

  parser.close();
}
