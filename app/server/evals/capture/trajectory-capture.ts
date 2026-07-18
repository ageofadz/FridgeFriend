import { AsyncLocalStorageProviderSingleton } from "@langchain/core/singletons";
import { isGraphInterrupt } from "@langchain/langgraph";

import type { TrajectoryEvent, StateDelta } from "../schemas/trajectory";
import type { FixtureSideEffectLog } from "../fixtures/fixture-workspace-adapter";
import { captureStateDeltas } from "./state-delta-capture";

type StreamableGraph = {
  stream(
    value: unknown,
    config?: Record<string, unknown>,
  ): Promise<AsyncIterable<unknown>> | AsyncIterable<unknown>;
};

export type CaptureGraphRunResult<TState> = {
  trajectory: TrajectoryEvent[];
  stateDeltas: StateDelta[];
  interrupts: Array<Record<string, unknown>>;
  state: TState | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function interruptPayloads(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];

  return value.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    return isRecord(entry.value) ? [entry.value] : [entry];
  });
}

/**
 * Streams one production-graph run (streamMode ["updates", "values"]) and
 * builds the ordered TrajectoryEvent list plus safety-node state deltas from
 * a single stream. Interrupt frames are excluded from the trajectory; the
 * preceding node's outcome flips to "interrupted" and the payloads are
 * returned separately. When the production graph runs nested inside an
 * eval-graph node, LangGraph surfaces its interrupt as a thrown
 * GraphInterrupt rather than an __interrupt__ frame — both are handled
 * identically. Timestamps are per-update approximations.
 *
 * Pass the same `assignedModelCalls` record across an interrupt/resume pair
 * so per-node model call counts are not double-attributed after the resume.
 */
export async function captureGraphRun<TState = Record<string, unknown>>(input: {
  graph: StreamableGraph;
  value: unknown;
  config?: Record<string, unknown>;
  modelCallCounts?: () => Record<string, number>;
  assignedModelCalls?: Record<string, number>;
  safetyNodes?: readonly string[];
  sideEffectLog?: FixtureSideEffectLog;
  sequenceStart?: number;
}): Promise<CaptureGraphRunResult<TState>> {
  const trajectory: TrajectoryEvent[] = [];
  const interrupts: Array<Record<string, unknown>> = [];
  const deltaCapture = captureStateDeltas({
    safetyNodes: input.safetyNodes,
    sideEffectLog: input.sideEffectLog,
  });
  const assigned = input.assignedModelCalls ?? {};
  let sequence = input.sequenceStart ?? 0;
  let state: TState | null = null;

  const recordInterrupt = (payloads: Array<Record<string, unknown>>) => {
    interrupts.push(...payloads);
    const previous = trajectory[trajectory.length - 1];
    if (previous) {
      previous.outcome = "interrupted";
    }
  };

  const recordUpdate = (node: string, update: unknown) => {
    const timestamp = new Date().toISOString();
    const counts = input.modelCallCounts?.() ?? {};
    const totalForNode = counts[node] ?? 0;
    const alreadyAssigned = assigned[node] ?? 0;
    const modelCallCount = Math.max(0, totalForNode - alreadyAssigned);
    assigned[node] = alreadyAssigned + modelCallCount;

    const event: TrajectoryEvent = {
      sequence,
      node,
      startedAt: timestamp,
      completedAt: timestamp,
      outcome: "completed",
      stateKeysWritten: isRecord(update) ? Object.keys(update) : [],
      modelCallCount,
      toolCallCount: 0,
    };
    trajectory.push(event);
    deltaCapture.onNodeUpdate({ sequence, node, stateKeysWritten: event.stateKeysWritten });
    sequence += 1;
  };

  const consumeStream = async () => {
    const stream = await input.graph.stream(input.value, {
      ...input.config,
      streamMode: ["updates", "values"],
    });

    for await (const entry of stream) {
      if (!Array.isArray(entry) || entry.length !== 2) {
        continue;
      }

      const [mode, chunk] = entry as [string, unknown];

      if (mode === "values" && isRecord(chunk)) {
        state = chunk as TState;
        continue;
      }

      if (mode !== "updates" || !isRecord(chunk)) {
        continue;
      }

      for (const [node, update] of Object.entries(chunk)) {
        if (node === "__interrupt__") {
          recordInterrupt(interruptPayloads(update));
        } else {
          recordUpdate(node, update);
        }
      }
    }
  };

  try {
    await AsyncLocalStorageProviderSingleton.runWithConfig({}, consumeStream, true);
  } catch (error) {
    if (!isGraphInterrupt(error)) {
      throw error;
    }
    recordInterrupt(interruptPayloads((error as { interrupts?: unknown }).interrupts));
  }

  return { trajectory, stateDeltas: deltaCapture.deltas, interrupts, state };
}
