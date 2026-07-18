import { AIMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";

import { createReplaySession } from "../../../../../app/server/evals/replay/replay-model";
import { ReplayMismatchError } from "../../../../../app/server/evals/replay/replay-sequence";
import type { ReplayStep } from "../../../../../app/server/evals/schemas/query-eval-case";

function intentStep(callId: string, intent: string): ReplayStep {
  return {
    callId,
    expectedNode: "determine_intent",
    expectedSchemaName: "IntentResponse",
    output: { intent },
  };
}

function responseStep(callId: string, output: unknown): ReplayStep {
  return {
    callId,
    expectedNode: "respond",
    expectedSchemaName: "QueryResponse",
    output,
  };
}

describe("createReplaySession", () => {
  it("consumes steps strictly in order per call site", () => {
    const session = createReplaySession([
      intentStep("intent-1", "inventory"),
      intentStep("intent-2", "recipe"),
    ]);

    expect(session.consume("intent")).toEqual({ intent: "inventory" });
    expect(session.consume("intent")).toEqual({ intent: "recipe" });
    expect(session.report()).toEqual({
      consumedCallIds: ["intent-1", "intent-2"],
      unusedCallIds: [],
      consumedExactly: true,
    });
  });

  it("fails on an unexpected model call naming the site", () => {
    const session = createReplaySession([]);

    expect(() => session.consume("response")).toThrowError(ReplayMismatchError);
    expect(() => session.consume("response")).toThrowError(/site "response"/);
  });

  it("fails on a schema mismatch naming the callId", () => {
    const session = createReplaySession([
      {
        callId: "enrichment-1",
        expectedNode: "run_focused_inventory_enrichment",
        expectedSchemaName: "FocusedInventoryEnrichment",
        output: {},
      },
    ]);

    expect(() => session.consume("enrichment", "InventoryClarificationValue"))
      .toThrowError(/enrichment-1/);
  });

  it("accepts aliased production schema names", () => {
    const session = createReplaySession([
      {
        callId: "memory-1",
        expectedNode: "extract_memory_candidates",
        expectedSchemaName: "MemoryCandidates",
        output: { candidates: [] },
      },
    ]);

    expect(session.consume("memory_extraction", "FridgeFriendMemoryExtraction"))
      .toEqual({ candidates: [] });
  });

  it("reports unused steps so runs cannot silently skip replay outputs", () => {
    const session = createReplaySession([
      intentStep("intent-1", "general_chat"),
      responseStep("response-1", "Hello."),
    ]);

    session.consume("intent");

    const report = session.report();
    expect(report.consumedExactly).toBe(false);
    expect(report.unusedCallIds).toEqual(["response-1"]);
  });

  it("returns an AIMessage from invoke and rejects non-string outputs", async () => {
    const session = createReplaySession([
      responseStep("response-1", "Hi there."),
      responseStep("response-2", { not: "a string" }),
    ]);
    const model = session.modelFor("response");

    const message = await (model as { invoke(input?: unknown): Promise<AIMessage> }).invoke();
    expect(message).toBeInstanceOf(AIMessage);
    expect(message.content).toBe("Hi there.");

    await expect(
      (model as { invoke(input?: unknown): Promise<AIMessage> }).invoke(),
    ).rejects.toThrowError(ReplayMismatchError);
  });

  it("checks schema names through withStructuredOutput config", async () => {
    const session = createReplaySession([
      {
        callId: "workspace-1",
        expectedNode: "plan_workspace_actions",
        expectedSchemaName: "WorkspaceActionPlan",
        output: { actions: [] },
      },
    ]);
    const model = session.modelFor("workspace_action") as unknown as {
      withStructuredOutput(schema: unknown, config?: { name?: string }): { invoke(): Promise<unknown> };
    };

    await expect(
      model.withStructuredOutput({}, { name: "FridgeWorkspaceActionPlan" }).invoke(),
    ).resolves.toEqual({ actions: [] });
  });

  it("tracks per-node model call counts", () => {
    const session = createReplaySession([
      intentStep("intent-1", "general_chat"),
      responseStep("response-1", "Hello."),
    ]);

    session.consume("intent");
    session.consume("response");

    expect(session.modelCallCounts()).toEqual({ determine_intent: 1, respond: 1 });
  });

  it("returns the intent router result shape", async () => {
    const session = createReplaySession([intentStep("intent-1", "general_chat")]);
    const router = session.intentRouter();

    await expect(router({ query: "hello" })).resolves.toEqual({
      accepted: { intent: "general_chat" },
      candidates: [],
    });
  });
});
