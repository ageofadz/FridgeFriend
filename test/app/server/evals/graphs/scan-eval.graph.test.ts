import { encode as encodeJpeg } from "jpeg-js";
import { beforeAll, describe, expect, it } from "vitest";

import { createScanEvalGraph } from "../../../../../app/server/evals/graphs/scan-eval.graph";
import type { ScanEvalOutput } from "../../../../../app/server/evals/graphs/scan-eval.graph";
import type { EvalResult } from "../../../../../app/server/evals/schemas/eval-result";
import { trajectoryNodeNames } from "../../../../../app/server/evals/schemas/trajectory";

beforeAll(() => {
  delete process.env.LANGSMITH_API_KEY;
  delete process.env.LANGSMITH_TRACING;
  delete process.env.LANGSMITH_ENDPOINT;
  delete process.env.LANGSMITH_PROJECT;
});

function createJpegDataUrl() {
  const jpeg = encodeJpeg(
    {
      data: Buffer.from([
        255, 0, 0, 255,
        0, 255, 0, 255,
        0, 0, 255, 255,
        255, 255, 255, 255,
      ]),
      width: 2,
      height: 2,
    },
    100,
  );

  return `data:image/jpeg;base64,${Buffer.from(jpeg.data).toString("base64")}`;
}

function scanCase(input: Record<string, unknown>) {
  return {
    caseId: "scan-case",
    revision: "v1",
    kind: "route_contract",
    split: "smoke",
    description: "Scan test case",
    tags: ["test"],
    input: { fridgeId: "eval-fridge", imageId: "image-1", storageLocation: "fridge" },
    expected: { terminalRoute: "scan_failed" },
    ...input,
  };
}

async function runCase(caseData: Record<string, unknown>, mode?: "replay" | "live"): Promise<EvalResult> {
  const graph = createScanEvalGraph();
  const state = await graph.invoke({ case: caseData, ...(mode ? { mode } : {}) });

  expect(state.result).not.toBeNull();
  return state.result as EvalResult;
}

function outputOf(result: EvalResult): ScanEvalOutput {
  return result.output as unknown as ScanEvalOutput;
}

describe("scan eval graph", () => {
  it("routes an invalid fridge photo to scan_failed via the replayed validation model", async () => {
    const result = await runCase(
      scanCase({
        caseId: "invalid-image-replay",
        fixtures: { images: [{ imageId: "image-1", dataUrl: createJpegDataUrl() }] },
        replay: [
          {
            callId: "validation-1",
            expectedNode: "validate_images",
            expectedSchemaName: "ImageValidation",
            output: { isFridge: false, reason: "This photo shows a bathroom, not a fridge." },
          },
        ],
      }),
    );
    const output = outputOf(result);

    expect(result.status).toBe("completed");
    expect(result.suite).toBe("scan");
    expect(result.mode).toBe("replay");
    expect(result.threadId).toMatch(/^eval:scan:invalid-image-replay:/);
    expect(output.terminalRoute).toBe("scan_failed");
    expect(output.imageValidation).toMatchObject({ valid: false });
    expect(result.replay).toMatchObject({
      consumedCallIds: ["validation-1"],
      consumedExactly: true,
    });

    const nodes = trajectoryNodeNames(result.trajectory);
    expect(nodes).toContain("validate_images");
    expect(nodes).toContain("scan_failed");
    expect(nodes).not.toContain("detect_inventory");
  }, 15000);

  it("fails deterministically before any model call for an undecodable jpeg", async () => {
    // validate_images asserts local decodability before invoking the model,
    // so this replay case needs no image_validation step at all. The explicit
    // mode override keeps the run in replay mode despite the empty step list.
    const result = await runCase(
      scanCase({
        caseId: "undecodable-image-replay",
        fixtures: {
          images: [{ imageId: "image-1", dataUrl: "data:image/jpeg;base64,not-a-jpeg" }],
        },
        replay: [],
      }),
      "replay",
    );
    const output = outputOf(result);

    expect(result.status).toBe("completed");
    expect(result.mode).toBe("replay");
    expect(output.terminalRoute).toBe("scan_failed");
    expect(output.imageValidation).toMatchObject({ valid: false });
    expect(result.replay).toMatchObject({ consumedCallIds: [], consumedExactly: true });
  }, 15000);

  it("returns invalid_case for a case without image fixtures", async () => {
    const result = await runCase(scanCase({ caseId: "no-images", fixtures: { images: [] } }));

    expect(result.status).toBe("invalid_case");
    expect(result.error).toMatchObject({ errorKind: "fixture", node: "validate_case" });
  });

  it("returns invalid_case when the input image has no fixture", async () => {
    const result = await runCase(
      scanCase({
        caseId: "missing-image",
        fixtures: { images: [{ imageId: "other-image", dataUrl: createJpegDataUrl() }] },
      }),
    );

    expect(result.status).toBe("invalid_case");
    expect(result.error?.message).toContain("image-1");
  });
});
