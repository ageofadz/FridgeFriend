import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import type { EvalPromptBundle } from "../../../../app/server/prompts/registry.server";
import { queryMetrics, scanMetrics } from "../../../../app/server/evals/metrics.server";
import { createQueryEvalGraph } from "../../../../app/server/evals/query-eval-graph.server";
import { cloneReplaySequences, createReplayModel, takeReplayValue } from "../../../../app/server/evals/replay-model.server";
import { createScanEvalGraph } from "../../../../app/server/evals/scan-eval-graph.server";
import { QueryEvalCaseSchema, ScanEvalCaseSchema } from "../../../../app/server/evals/schemas";

process.env.LANGSMITH_ENDPOINT = "https://smith.example.test";
process.env.LANGSMITH_API_KEY = "eval-test-key";
process.env.LANGSMITH_PROJECT = "fridgefriend-evals";
process.env.LANGSMITH_TRACING = "false";

const promptBundle = {
  queryMemoryExtraction: { name: "query-memory-extraction", ref: "test:query-memory-extraction", prompt: { invoke: async () => ({ toChatMessages: () => [] }) } },
  queryResponse: { name: "query-response", ref: "test:query-response", prompt: { invoke: async () => ({ toChatMessages: () => [] }) } },
  workspaceActionPlan: { name: "workspace-action-plan", ref: "test:workspace-action-plan", prompt: { invoke: async () => ({ toChatMessages: () => [] }) } },
} as unknown as EvalPromptBundle;

async function fixtureCase(name: "query" | "scan") {
  const text = await readFile(new URL(`../../../../examples/evals/${name}-graph-v1.jsonl`, import.meta.url), "utf8");
  return JSON.parse(text.trim()).inputs.case;
}

describe("evaluation schemas and replay model", () => {
  it("rejects malformed cases with the specific path", () => {
    const parsed = QueryEvalCaseSchema.safeParse({ caseId: "bad", mode: "replay", query: { fridgeId: "f" }, expected: {} });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.map((issue) => issue.path.join(".")).join(",")).toContain("query.imageId");
    }
  });

  it("consumes replay outputs in order and errors when exhausted", async () => {
    const sequences = cloneReplaySequences({ response: ["first", "second"] });
    const model = createReplayModel(sequences, "response");

    await expect(model.invoke([])).resolves.toMatchObject({ content: "first" });
    expect(takeReplayValue(sequences, "response")).toBe("second");
    expect(() => takeReplayValue(sequences, "response")).toThrow("Replay case is missing a model output for response");
  });
});

describe("evaluation metrics", () => {
  it("accepts a grounded workspace action and rejects unsupported targets", () => {
    const caseData = QueryEvalCaseSchema.parse({
      caseId: "workspace-targets",
      mode: "replay",
      query: { fridgeId: "f", imageId: "image-1", query: "Show the milk." },
      fixtures: {
        workspace: {
          itemIds: ["item-1"],
          zoneIds: ["zone-1"],
          recipeIds: ["recipe-1"],
          imageIds: ["image-1"],
          boundingBoxes: [{ imageId: "image-1", boundingBox: { x: 0, y: 0, width: 0.4, height: 0.4 } }],
        },
      },
      expected: {},
    });
    const grounded = queryMetrics({
      caseData,
      trajectory: [],
      output: { workspaceActions: [{ type: "show_evidence", itemId: "item-1", imageId: "image-1", boundingBox: { x: 0, y: 0, width: 0.4, height: 0.4 } }] },
    });
    const unsupported = queryMetrics({
      caseData,
      trajectory: [],
      output: { workspaceActions: [{ type: "focus_items", itemIds: ["unknown"], emphasis: "highlight", reason: null }] },
    });

    expect(grounded.find((entry) => entry.key === "workspace_action_supported_targets")?.score).toBe(1);
    expect(unsupported.find((entry) => entry.key === "workspace_action_supported_targets")?.score).toBe(0);
  });

  it("scores scan IoU and fails an unmatched annotation", () => {
    const caseData = ScanEvalCaseSchema.parse({
      caseId: "iou",
      mode: "replay",
      scan: { fridgeId: "f", imageId: "image", storageLocation: "fridge", imageDataUrl: "data:image/jpeg;base64,AA==" },
      expected: { validImage: true, minimumDetectionPrecision: 1, minimumDetectionRecall: 1 },
      annotations: { detections: [{ id: "milk", label: "milk", boundingBox: { x: 0, y: 0, width: 0.5, height: 0.5 } }] },
    });
    const metrics = scanMetrics({
      caseData,
      trajectory: [],
      output: { validImage: true, rawDetections: [{ id: "milk", label: "milk", bbox: { x: 0.6, y: 0.6, width: 0.2, height: 0.2 } }], groundedPlacements: [] },
    });

    expect(metrics.find((entry) => entry.key === "scan_detection_recall")?.score).toBe(0);
  });
});

describe("evaluation graphs", () => {
  it("runs the query replay fixture through a no-checkpointer local graph", async () => {
    const caseData = await fixtureCase("query");
    const result = await createQueryEvalGraph({ promptBundle }).invoke(caseData);

    expect(result.result).toMatchObject({
      caseId: "general-chat-replay",
      status: "completed",
      output: { answer: "Hello.", intent: "general_chat" },
    });
    expect((result.result?.metrics ?? []).every((entry) => entry.score === 1)).toBe(true);
  }, 15_000);

  it("runs malformed images through the injected resolver without persistence access", async () => {
    const caseData = await fixtureCase("scan");
    const result = await createScanEvalGraph({ promptBundle }).invoke(caseData);

    expect(result.result).toMatchObject({
      caseId: "malformed-image-replay",
      status: "completed",
      trajectory: ["validate_images", "scan_failed"],
    });
    expect((result.result?.metrics ?? []).every((entry) => entry.score === 1)).toBe(true);
  });

  it("returns invalid_case instead of throwing when runner input is invalid", async () => {
    const result = await createScanEvalGraph({ promptBundle }).invoke({ caseId: "bad" });

    expect(result.result?.status).toBe("invalid_case");
    expect(result.result?.error).toContain("scan: Invalid input: expected object");
    expect(result.result?.metrics).toEqual([{ key: "case_validation", score: 0, comment: "The evaluation case did not satisfy ScanEvalCaseSchema" }]);
  });
});
