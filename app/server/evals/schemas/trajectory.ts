import { z } from "zod";

export const TrajectoryOutcomeSchema = z.enum(["completed", "interrupted", "failed"]);
export type TrajectoryOutcome = z.infer<typeof TrajectoryOutcomeSchema>;

export const TrajectoryEventSchema = z.object({
  sequence: z.number().int().nonnegative(),
  node: z.string().min(1),
  startedAt: z.string(),
  completedAt: z.string().optional(),
  outcome: TrajectoryOutcomeSchema,
  stateKeysWritten: z.array(z.string()),
  modelCallCount: z.number().int().nonnegative(),
  toolCallCount: z.number().int().nonnegative(),
});
export type TrajectoryEvent = z.infer<typeof TrajectoryEventSchema>;

// Counters recorded by the side-effect-free fixture adapters. Safety
// evaluators assert on these instead of on full private state dumps.
export const FixtureSideEffectCountersSchema = z.object({
  inventoryWrites: z.number().int().nonnegative().default(0),
  memoryWrites: z.number().int().nonnegative().default(0),
  semanticMemoryIndexWrites: z.number().int().nonnegative().default(0),
  enrichmentWrites: z.number().int().nonnegative().default(0),
  workspaceActionsPlanned: z.number().int().nonnegative().default(0),
});
export type FixtureSideEffectCounters = z.infer<typeof FixtureSideEffectCountersSchema>;

// A state delta snapshot taken after a safety-sensitive node executed:
// which state keys the node wrote plus the fixture side-effect counters at
// that moment. No raw inventory/memory payloads are stored.
export const StateDeltaSchema = z.object({
  sequence: z.number().int().nonnegative(),
  node: z.string().min(1),
  stateKeysWritten: z.array(z.string()),
  counters: FixtureSideEffectCountersSchema,
});
export type StateDelta = z.infer<typeof StateDeltaSchema>;

export function trajectoryNodeNames(events: TrajectoryEvent[]): string[] {
  return [...events].sort((a, b) => a.sequence - b.sequence).map((event) => event.node);
}

export function hasOrderedNodeGroups(
  nodeNames: string[],
  orderedGroups: string[][],
): boolean {
  let searchFrom = 0;

  for (const group of orderedGroups) {
    let groupEnd = searchFrom;

    for (const node of group) {
      const index = nodeNames.indexOf(node, searchFrom);
      if (index === -1) return false;
      groupEnd = Math.max(groupEnd, index + 1);
    }

    searchFrom = groupEnd;
  }

  return true;
}
