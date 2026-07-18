import { z } from "zod";

import type { EvalFeedback, EvalResult } from "../schemas/eval-result";
import {
  FixtureSideEffectCountersSchema,
  type FixtureSideEffectCounters,
} from "../schemas/trajectory";

export function zeroCounters(): FixtureSideEffectCounters {
  return {
    inventoryWrites: 0,
    memoryWrites: 0,
    semanticMemoryIndexWrites: 0,
    enrichmentWrites: 0,
    workspaceActionsPlanned: 0,
  };
}

export function feedback(key: string, score: number, comment: string): EvalFeedback {
  return { key, score: Math.min(1, Math.max(0, score)), comment };
}

export function passFail(key: string, passed: boolean, comment: string): EvalFeedback {
  return feedback(key, passed ? 1 : 0, comment);
}

const emptyGrounding = {
  itemIds: [] as string[],
  zoneIds: [] as string[],
  recipeIds: [] as string[],
  imageIds: [] as string[],
};

// Defensive structural mirror of the eval-graph QueryEvalOutput contract.
// Every field falls back to a safe default so evaluators never throw on a
// partially-populated output record.
export const QueryEvalOutputSchema = z.looseObject({
  answer: z.string().nullable().catch(null),
  intent: z.string().nullable().catch(null),
  terminalRoute: z.string().catch(""),
  shoppingMode: z.string().catch("direct"),
  recipeContinuation: z.boolean().catch(false),
  workspaceActions: z.array(z.unknown()).catch([]),
  interrupted: z.boolean().catch(false),
  interrupts: z.array(z.unknown()).catch([]),
  memoryWriteResults: z.array(z.unknown()).catch([]),
  memoryWriteVerification: z.unknown(),
  recipeIds: z.array(z.string()).catch([]),
  recipeRetrievalAudit: z.unknown(),
  counters: FixtureSideEffectCountersSchema.catch(zeroCounters()),
  countersBeforeResume: FixtureSideEffectCountersSchema.optional().catch(undefined),
  writes: z
    .array(z.looseObject({ kind: z.string().catch(""), target: z.string().catch("") }))
    .catch([]),
  grounding: z
    .object({
      itemIds: z.array(z.string()).default([]),
      zoneIds: z.array(z.string()).default([]),
      recipeIds: z.array(z.string()).default([]),
      imageIds: z.array(z.string()).default([]),
    })
    .catch({ ...emptyGrounding }),
});
export type QueryEvalOutput = z.infer<typeof QueryEvalOutputSchema>;

export function readQueryOutput(result: EvalResult): QueryEvalOutput {
  return QueryEvalOutputSchema.parse(result.output ?? {});
}

// Defensive structural mirror of the eval-graph ScanEvalOutput contract.
export const ScanEvalOutputSchema = z.looseObject({
  terminalRoute: z.string().catch(""),
  scanStatus: z.string().catch(""),
  imageValidation: z.unknown(),
  detectionValidation: z.unknown(),
  zoneMapValidation: z.unknown(),
  placementValidation: z.unknown(),
  inventoryValidation: z.unknown(),
  rawDetections: z.array(z.unknown()).catch([]),
  zoneMaps: z.array(z.unknown()).catch([]),
  groundedPlacements: z.array(z.unknown()).catch([]),
  inventory: z.unknown(),
  error: z.unknown(),
});
export type ScanEvalOutput = z.infer<typeof ScanEvalOutputSchema>;

export function readScanOutput(result: EvalResult): ScanEvalOutput {
  return ScanEvalOutputSchema.parse(result.output ?? {});
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function recordsOf(values: unknown[]): Record<string, unknown>[] {
  return values.flatMap((value) => {
    const record = asRecord(value);
    return record ? [record] : [];
  });
}

export function stringsOf(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}
