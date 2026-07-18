import { describe, expect, it } from "vitest";

import {
  QUERY_REPLAY_CALL_SITES,
  ReplayMismatchError,
  SCAN_REPLAY_CALL_SITES,
  canonicalSchemaName,
  groupReplaySteps,
} from "../../../../../app/server/evals/replay/replay-sequence";
import type { ReplayStep } from "../../../../../app/server/evals/schemas/query-eval-case";

function step(input: Partial<ReplayStep> & { callId: string }): ReplayStep {
  return {
    expectedNode: "determine_intent",
    expectedSchemaName: "IntentResponse",
    output: {},
    ...input,
  };
}

describe("replay call-site registry", () => {
  it("covers all 13 query sites and 3 scan sites", () => {
    expect(Object.keys(QUERY_REPLAY_CALL_SITES)).toHaveLength(13);
    expect(Object.keys(SCAN_REPLAY_CALL_SITES)).toHaveLength(3);
    expect(QUERY_REPLAY_CALL_SITES.response.nodes).toEqual(["respond"]);
    expect(SCAN_REPLAY_CALL_SITES.image_validation.schemaNames).toContain("ImageValidation");
  });

  it("canonicalizes production schema names onto the spec names", () => {
    expect(canonicalSchemaName("FridgeFriendMemoryExtraction")).toBe("MemoryCandidates");
    expect(canonicalSchemaName("FridgePantryCompletionAisleAssignment")).toBe("GroceryAisleAssignment");
    expect(canonicalSchemaName("IntentResponse")).toBe("IntentResponse");
  });
});

describe("groupReplaySteps", () => {
  it("groups steps by call site preserving order within a site", () => {
    const grouped = groupReplaySteps([
      step({ callId: "intent-1" }),
      step({
        callId: "tournament-1",
        expectedNode: "evaluate_recipe",
        expectedSchemaName: "RecipeTournamentEvaluation",
      }),
      step({
        callId: "tournament-2",
        expectedNode: "evaluate_recipe",
        expectedSchemaName: "FridgeRecipeTournamentEvaluation",
      }),
      step({ callId: "response-1", expectedNode: "respond", expectedSchemaName: "QueryResponse" }),
    ]);

    expect(grouped.get("intent")?.map((entry) => entry.callId)).toEqual(["intent-1"]);
    expect(grouped.get("recipe_tournament")?.map((entry) => entry.callId)).toEqual([
      "tournament-1",
      "tournament-2",
    ]);
    expect(grouped.get("response")?.map((entry) => entry.callId)).toEqual(["response-1"]);
  });

  it("throws a ReplayMismatchError for an unknown node", () => {
    expect(() => groupReplaySteps([step({ callId: "bad-1", expectedNode: "no_such_node" })]))
      .toThrowError(ReplayMismatchError);
  });

  it("throws a ReplayMismatchError naming the callId for an unknown schema", () => {
    try {
      groupReplaySteps([
        step({ callId: "bad-2", expectedNode: "respond", expectedSchemaName: "NotASchema" }),
      ]);
      expect.unreachable("expected a ReplayMismatchError");
    } catch (error) {
      expect(error).toBeInstanceOf(ReplayMismatchError);
      const mismatch = error as ReplayMismatchError;
      expect(mismatch.message).toContain("bad-2");
      expect(mismatch.details.callId).toBe("bad-2");
    }
  });
});
