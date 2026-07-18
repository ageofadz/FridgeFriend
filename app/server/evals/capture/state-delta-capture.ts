import type { StateDelta } from "../schemas/trajectory";
import { cloneCounters, type FixtureSideEffectLog } from "../fixtures/fixture-workspace-adapter";

/**
 * Safety-sensitive nodes whose state writes are snapshotted alongside the
 * side-effect counters (spec: mutation proposal/review, memory persistence,
 * workspace action planning, inventory enrichment persistence).
 */
export const DEFAULT_SAFETY_NODES = [
  "apply_memory_writes",
  "review_inventory_split",
  "plan_workspace_actions",
  "persist_inventory_enrichment",
  "index_semantic_memory",
] as const;

export type StateDeltaCapture = {
  deltas: StateDelta[];
  onNodeUpdate(input: { sequence: number; node: string; stateKeysWritten: string[] }): void;
};

const ZERO_COUNTERS = {
  inventoryWrites: 0,
  memoryWrites: 0,
  semanticMemoryIndexWrites: 0,
  enrichmentWrites: 0,
  workspaceActionsPlanned: 0,
};

/**
 * Collects StateDelta snapshots for safety-sensitive nodes from the same
 * updates stream that trajectory capture consumes. Counters are cloned at
 * snapshot time so later writes never mutate an earlier delta.
 */
export function captureStateDeltas(input: {
  safetyNodes?: readonly string[];
  sideEffectLog?: FixtureSideEffectLog;
} = {}): StateDeltaCapture {
  const safetyNodes = new Set(input.safetyNodes ?? DEFAULT_SAFETY_NODES);
  const deltas: StateDelta[] = [];

  return {
    deltas,
    onNodeUpdate({ sequence, node, stateKeysWritten }) {
      if (!safetyNodes.has(node)) {
        return;
      }

      deltas.push({
        sequence,
        node,
        stateKeysWritten: [...stateKeysWritten],
        counters: input.sideEffectLog ? cloneCounters(input.sideEffectLog) : { ...ZERO_COUNTERS },
      });
    },
  };
}
