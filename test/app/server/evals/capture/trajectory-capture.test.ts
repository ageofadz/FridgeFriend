import { describe, expect, it } from "vitest";

import { captureGraphRun } from "../../../../../app/server/evals/capture/trajectory-capture";
import {
  DEFAULT_SAFETY_NODES,
  captureStateDeltas,
} from "../../../../../app/server/evals/capture/state-delta-capture";
import { createFixtureSideEffectLog } from "../../../../../app/server/evals/fixtures/fixture-workspace-adapter";

type Frame = [string, unknown];

function fakeGraph(frames: Frame[]) {
  return {
    stream: async (_value: unknown, config?: Record<string, unknown>) => {
      expect(config?.streamMode).toEqual(["updates", "values"]);
      return (async function* () {
        for (const frame of frames) {
          yield frame;
        }
      })();
    },
  };
}

describe("captureGraphRun", () => {
  it("builds an ordered trajectory with state keys and the final state", async () => {
    const result = await captureGraphRun({
      graph: fakeGraph([
        ["updates", { load_context: { userId: "u", externalInventory: [] } }],
        ["values", { answer: null }],
        ["updates", { determine_intent: { intent: "general_chat" } }],
        ["updates", { respond: { answer: "Hello." } }],
        ["values", { answer: "Hello." }],
      ]),
      value: {},
    });

    expect(result.trajectory.map((event) => [event.sequence, event.node])).toEqual([
      [0, "load_context"],
      [1, "determine_intent"],
      [2, "respond"],
    ]);
    expect(result.trajectory[0].stateKeysWritten).toEqual(["userId", "externalInventory"]);
    expect(result.trajectory.every((event) => event.outcome === "completed")).toBe(true);
    expect(result.trajectory.every((event) => typeof event.startedAt === "string")).toBe(true);
    expect(result.interrupts).toEqual([]);
    expect(result.state).toEqual({ answer: "Hello." });
  });

  it("marks the preceding node interrupted and returns interrupt payloads", async () => {
    const result = await captureGraphRun({
      graph: fakeGraph([
        ["updates", { validate_memory_candidates: { memoryValidations: [] } }],
        [
          "updates",
          {
            __interrupt__: [
              { value: { type: "inventory_mutation_review", operation: "consume", itemName: "milk" } },
            ],
          },
        ],
        ["values", { answer: null }],
      ]),
      value: {},
    });

    expect(result.trajectory).toHaveLength(1);
    expect(result.trajectory[0]).toMatchObject({
      node: "validate_memory_candidates",
      outcome: "interrupted",
    });
    expect(result.interrupts).toEqual([
      { type: "inventory_mutation_review", operation: "consume", itemName: "milk" },
    ]);
  });

  it("attributes replay model call counts per node without double counting", async () => {
    const counts: Record<string, number> = { determine_intent: 1 };
    const assigned: Record<string, number> = {};

    const first = await captureGraphRun({
      graph: fakeGraph([["updates", { determine_intent: { intent: "recipe" } }]]),
      value: {},
      modelCallCounts: () => ({ ...counts }),
      assignedModelCalls: assigned,
    });
    const second = await captureGraphRun({
      graph: fakeGraph([["updates", { determine_intent: { intent: "recipe" } }]]),
      value: {},
      modelCallCounts: () => ({ ...counts }),
      assignedModelCalls: assigned,
      sequenceStart: first.trajectory.length,
    });

    expect(first.trajectory[0].modelCallCount).toBe(1);
    expect(second.trajectory[0]).toMatchObject({ sequence: 1, modelCallCount: 0 });
  });

  it("captures state deltas with cloned counters for safety nodes", async () => {
    const log = createFixtureSideEffectLog();
    const result = await captureGraphRun({
      graph: {
        stream: async () =>
          (async function* () {
            yield ["updates", { load_context: { userId: "u" } }] as Frame;
            log.counters.memoryWrites = 1;
            yield ["updates", { apply_memory_writes: { memoryWriteResults: [{}] } }] as Frame;
            log.counters.memoryWrites = 2;
            yield ["values", { done: true }] as Frame;
          })(),
      },
      value: {},
      sideEffectLog: log,
    });

    expect(result.stateDeltas).toEqual([
      {
        sequence: 1,
        node: "apply_memory_writes",
        stateKeysWritten: ["memoryWriteResults"],
        counters: expect.objectContaining({ memoryWrites: 1 }),
      },
    ]);
  });
});

describe("captureStateDeltas", () => {
  it("only records the configured safety nodes", () => {
    const capture = captureStateDeltas();

    capture.onNodeUpdate({ sequence: 0, node: "load_context", stateKeysWritten: ["userId"] });
    capture.onNodeUpdate({ sequence: 1, node: "persist_inventory_enrichment", stateKeysWritten: ["context"] });

    expect(DEFAULT_SAFETY_NODES).toContain("persist_inventory_enrichment");
    expect(capture.deltas.map((delta) => delta.node)).toEqual(["persist_inventory_enrichment"]);
  });
});
