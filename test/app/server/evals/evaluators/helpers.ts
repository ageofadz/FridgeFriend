import { EvalResultSchema, type EvalResult } from "../../../../../app/server/evals/schemas/eval-result";
import {
  QueryEvalCaseSchema,
  type QueryEvalCase,
} from "../../../../../app/server/evals/schemas/query-eval-case";
import {
  ScanEvalCaseSchema,
  type ScanEvalCase,
} from "../../../../../app/server/evals/schemas/scan-eval-case";
import type {
  FixtureSideEffectCounters,
  TrajectoryEvent,
} from "../../../../../app/server/evals/schemas/trajectory";

export function zeroCounters(): FixtureSideEffectCounters {
  return {
    inventoryWrites: 0,
    memoryWrites: 0,
    semanticMemoryIndexWrites: 0,
    enrichmentWrites: 0,
    workspaceActionsPlanned: 0,
  };
}

export function counters(overrides: Partial<FixtureSideEffectCounters> = {}): FixtureSideEffectCounters {
  return { ...zeroCounters(), ...overrides };
}

export function trajectoryOf(nodes: string[]): TrajectoryEvent[] {
  return nodes.map((node, sequence) => ({
    sequence,
    node,
    startedAt: new Date(1700000000000 + sequence).toISOString(),
    completedAt: new Date(1700000000001 + sequence).toISOString(),
    outcome: "completed" as const,
    stateKeysWritten: [],
    modelCallCount: 0,
    toolCallCount: 0,
  }));
}

export function queryCase(overrides: Record<string, unknown> = {}): QueryEvalCase {
  return QueryEvalCaseSchema.parse({
    caseId: "case-query-1",
    revision: "r1",
    kind: "route_contract",
    split: "smoke",
    description: "test query case",
    input: { fridgeId: "fridge-1", query: "what is in my fridge" },
    expected: {},
    ...overrides,
  });
}

export function scanCase(overrides: Record<string, unknown> = {}): ScanEvalCase {
  return ScanEvalCaseSchema.parse({
    caseId: "case-scan-1",
    revision: "r1",
    kind: "node_contract",
    split: "smoke",
    description: "test scan case",
    input: { fridgeId: "fridge-1", imageId: "img-1", storageLocation: "fridge" },
    fixtures: { images: [{ imageId: "img-1", dataUrl: "data:image/png;base64,AA==" }] },
    expected: { terminalRoute: "finalize_scan" },
    ...overrides,
  });
}

export function queryOutput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    answer: "You have milk.",
    intent: "inventory",
    terminalRoute: "respond",
    shoppingMode: "direct",
    recipeContinuation: false,
    workspaceActions: [],
    interrupted: false,
    interrupts: [],
    memoryWriteResults: [],
    memoryWriteVerification: null,
    recipeIds: [],
    recipeRetrievalAudit: null,
    counters: zeroCounters(),
    writes: [],
    grounding: { itemIds: [], zoneIds: [], recipeIds: [], imageIds: [] },
    ...overrides,
  };
}

export function evalResult(overrides: Partial<Record<keyof EvalResult, unknown>> = {}): EvalResult {
  return EvalResultSchema.parse({
    caseId: "case-query-1",
    revision: "r1",
    suite: "query",
    mode: "replay",
    status: "completed",
    threadId: "thread-1",
    model: "test-model",
    output: queryOutput(),
    ...overrides,
  });
}

export function feedbackByKey(feedback: { key: string; score: number; comment: string }[]) {
  return new Map(feedback.map((entry) => [entry.key, entry]));
}

// --- Scan output builders -------------------------------------------------

export function detection(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "det-1",
    img: "img-1",
    name: "milk",
    conf: 0.9,
    bbox: { x: 0.1, y: 0.1, width: 0.2, height: 0.3 },
    pack: "carton",
    qty: null,
    ...overrides,
  };
}

export function zoneMap(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    imageId: "img-1",
    zones: [
      {
        id: "zone-1",
        img: "img-1",
        type: "shelf",
        bbox: { x: 0, y: 0, width: 0.9, height: 0.4 },
        ord: 0,
        name: "Top shelf",
        conf: 0.9,
        partial: false,
      },
    ],
    ...overrides,
  };
}

export function placedPlacement(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    detectionId: "det-1",
    status: "placed",
    supportKind: "zone",
    supportId: "zone-1",
    depth: { back: 0.2, front: 0.8 },
    confidence: 0.9,
    ...overrides,
  };
}

export function inventoryItemRecord(name: string): Record<string, unknown> {
  return {
    id: `item-${name}`,
    name,
    label: name,
    cat: "dairy",
    subcat: null,
    qty: { amount: 1, unit: "count", precision: "estimated", fillLevel: null },
    pack: "carton",
    loc: { status: "unmatched", zoneId: null, zoneType: null, observations: [], confidence: null },
    conf: 0.9,
    src: ["img-1"],
    attrs: { brand: null, variant: null, opened: null, expirationDate: null },
    review: "inferred",
  };
}

export function inventoryRecord(itemNames: string[]): Record<string, unknown> {
  return {
    id: "inventory-1",
    fridgeId: "fridge-1",
    scanId: "scan-1",
    source: "gemini-vision",
    model: "test-model",
    createdAt: new Date(1700000000000).toISOString(),
    items: itemNames.map(inventoryItemRecord),
    zones: [],
  };
}

export function scanOutput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    terminalRoute: "finalize_scan",
    scanStatus: "completed",
    imageValidation: { valid: true, reason: "Looks like a fridge" },
    detectionValidation: { valid: true },
    zoneMapValidation: { valid: true },
    placementValidation: { valid: true },
    inventoryValidation: { valid: true },
    rawDetections: [detection()],
    zoneMaps: [zoneMap()],
    groundedPlacements: [placedPlacement()],
    inventory: null,
    error: null,
    ...overrides,
  };
}
