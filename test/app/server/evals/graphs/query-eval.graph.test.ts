import { beforeAll, describe, expect, it } from "vitest";

import { createQueryEvalGraph } from "../../../../../app/server/evals/graphs/query-eval.graph";
import type { QueryEvalOutput } from "../../../../../app/server/evals/graphs/query-eval.graph";
import type { EvalResult } from "../../../../../app/server/evals/schemas/eval-result";
import { trajectoryNodeNames } from "../../../../../app/server/evals/schemas/trajectory";

// Replay tests must run offline against the bundled prompt fallback.
beforeAll(() => {
  delete process.env.LANGSMITH_API_KEY;
  delete process.env.LANGSMITH_TRACING;
  delete process.env.LANGSMITH_ENDPOINT;
  delete process.env.LANGSMITH_PROJECT;
});

function baseCase(input: Record<string, unknown>): Record<string, unknown> {
  return {
    caseId: "test-case",
    revision: "v1",
    kind: "route_contract",
    split: "smoke",
    description: "Test case",
    tags: ["test"],
    input: { fridgeId: "eval-fridge", imageId: null, query: "Hello there." },
    fixtures: {},
    expected: {},
    ...input,
  };
}

// Adapted from the legacy examples/evals/query-graph-v1.jsonl general-chat
// replay case, rewritten against the new identified-step schema.
function generalChatCase() {
  return baseCase({
    caseId: "general-chat-replay",
    replay: [
      {
        callId: "intent-1",
        expectedNode: "determine_intent",
        expectedSchemaName: "IntentResponse",
        output: {
          intent: "general_chat",
          recipeContinuation: false,
          shoppingMode: "direct",
          enrichment: { itemNames: [], fields: [] },
        },
      },
      {
        callId: "memory-1",
        expectedNode: "extract_memory_candidates",
        expectedSchemaName: "FridgeFriendMemoryExtraction",
        output: { candidates: [] },
      },
      {
        callId: "response-1",
        expectedNode: "respond",
        expectedSchemaName: "QueryResponse",
        output: "Hello.",
      },
      {
        callId: "workspace-1",
        expectedNode: "plan_workspace_actions",
        expectedSchemaName: "WorkspaceActionPlan",
        output: { actions: [] },
      },
    ],
  });
}

function mutationReviewCase(input: { resume?: Record<string, unknown> } = {}) {
  return baseCase({
    caseId: "mutation-review-replay",
    input: { fridgeId: "eval-fridge", imageId: null, query: "I finished the milk." },
    fixtures: {
      memories: [
        {
          kind: "external_inventory",
          value: { id: "ext-milk", name: "milk", storageLocation: "fridge" },
        },
      ],
    },
    replay: [
      {
        callId: "intent-1",
        expectedNode: "determine_intent",
        expectedSchemaName: "IntentResponse",
        output: {
          intent: "general_chat",
          recipeContinuation: false,
          shoppingMode: "direct",
          enrichment: { itemNames: [], fields: [] },
        },
      },
      {
        callId: "memory-1",
        expectedNode: "extract_memory_candidates",
        expectedSchemaName: "MemoryCandidates",
        output: {
          candidates: [
            {
              kind: "inventory_item",
              scope: "fridge",
              action: "consume",
              name: "milk",
              storageLocation: "fridge",
              quantity: null,
              notes: null,
              explicit: true,
            },
          ],
        },
      },
      {
        callId: "response-1",
        expectedNode: "respond",
        expectedSchemaName: "QueryResponse",
        output: "Done.",
      },
    ],
    expected: { expectedInterrupt: true },
    ...(input.resume ? { resume: input.resume } : {}),
  });
}

async function runCase(caseData: Record<string, unknown>): Promise<EvalResult> {
  const graph = createQueryEvalGraph();
  const state = await graph.invoke({ case: caseData });

  expect(state.result).not.toBeNull();
  return state.result as EvalResult;
}

function outputOf(result: EvalResult): QueryEvalOutput {
  return result.output as unknown as QueryEvalOutput;
}

describe("query eval graph", () => {
  it("runs a general-chat replay case end to end", async () => {
    const result = await runCase(generalChatCase());
    const output = outputOf(result);

    expect(result.status).toBe("completed");
    expect(result.suite).toBe("query");
    expect(result.mode).toBe("replay");
    expect(result.threadId).toMatch(/^eval:query:general-chat-replay:/);
    expect(result.error).toBeNull();
    expect(result.replay).toMatchObject({ consumedExactly: true, unusedCallIds: [] });

    expect(output.answer).toBe("Hello.");
    expect(output.intent).toBe("general_chat");
    expect(output.shoppingMode).toBe("direct");
    expect(output.interrupted).toBe(false);
    expect(output.counters).toMatchObject({ memoryWrites: 0, inventoryWrites: 0 });

    const nodes = trajectoryNodeNames(result.trajectory);
    expect(nodes).toContain("load_context");
    expect(nodes).toContain("determine_intent");
    expect(nodes).toContain("respond");
    expect(nodes).toContain("plan_workspace_actions");
    expect(nodes).not.toContain("query_inventory");
    expect(result.promptRefs.length).toBeGreaterThan(0);
  }, 15000);

  it("interrupts for a mutation review and persists exactly once after approval", async () => {
    const result = await runCase(
      mutationReviewCase({
        resume: { answers: {}, skipped: [], inventoryMutationReview: { approved: true } },
      }),
    );
    const output = outputOf(result);

    expect(result.status).toBe("completed");
    expect(output.interrupts).toEqual([
      expect.objectContaining({
        type: "inventory_mutation_review",
        operation: "consume",
        itemName: "milk",
      }),
    ]);
    // No writes before the resume, exactly one after approval.
    expect(output.countersBeforeResume).toMatchObject({ memoryWrites: 0, inventoryWrites: 0 });
    expect(output.counters.memoryWrites).toBe(1);
    expect(output.memoryWriteVerification).toMatchObject({ status: "verified" });
    expect(output.answer).toBe("Done.");
    expect(result.replay?.consumedExactly).toBe(true);

    const interruptedEvent = result.trajectory.find((event) => event.outcome === "interrupted");
    expect(interruptedEvent).toBeDefined();
    expect(
      result.stateDeltas.some(
        (delta) => delta.node === "apply_memory_writes" && delta.counters.memoryWrites === 1,
      ),
    ).toBe(true);
  }, 15000);

  it("keeps writes at zero when the mutation review is rejected", async () => {
    const result = await runCase(
      mutationReviewCase({
        resume: { answers: {}, skipped: [], inventoryMutationReview: { approved: false } },
      }),
    );
    const output = outputOf(result);

    expect(result.status).toBe("completed");
    expect(output.countersBeforeResume).toMatchObject({ memoryWrites: 0 });
    expect(output.counters.memoryWrites).toBe(0);
    expect(output.writes).toEqual([]);
    expect(output.memoryWriteVerification).toMatchObject({ status: "failed" });
  }, 15000);

  it("reports interrupted when no resume is provided", async () => {
    const result = await runCase(mutationReviewCase());
    const output = outputOf(result);

    expect(result.status).toBe("interrupted");
    expect(output.terminalRoute).toBe("review_interrupt");
    expect(output.interrupted).toBe(true);
    expect(output.counters.memoryWrites).toBe(0);
  }, 15000);

  it("flags unused replay steps as a replay mismatch", async () => {
    const caseData = generalChatCase();
    (caseData.replay as unknown[]).push({
      callId: "tournament-1",
      expectedNode: "evaluate_recipe",
      expectedSchemaName: "RecipeTournamentEvaluation",
      output: {},
    });

    const result = await runCase(caseData);

    expect(result.status).toBe("replay_mismatch");
    expect(result.error).toMatchObject({ errorKind: "replay_mismatch" });
    expect(result.error?.message).toContain("tournament-1");
    expect(result.replay?.consumedExactly).toBe(false);
  }, 15000);

  it("returns invalid_case for a malformed case without touching the production graph", async () => {
    const result = await runCase({ caseId: "broken", description: "missing fields" });

    expect(result.status).toBe("invalid_case");
    expect(result.caseId).toBe("broken");
    expect(result.error).toMatchObject({ errorKind: "fixture", node: "validate_case" });
    expect(result.trajectory).toEqual([]);
  });

  it("returns invalid_case for replay steps that match no call site", async () => {
    const result = await runCase(
      baseCase({
        caseId: "bad-replay",
        replay: [
          {
            callId: "bad-1",
            expectedNode: "no_such_node",
            expectedSchemaName: "IntentResponse",
            output: {},
          },
        ],
      }),
    );

    expect(result.status).toBe("invalid_case");
    expect(result.error?.message).toContain("bad-1");
  });
});
