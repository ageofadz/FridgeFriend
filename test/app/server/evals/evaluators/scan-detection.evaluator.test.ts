import { describe, expect, it } from "vitest";

import {
  BOX_RECALL_AT_50_KEY,
  DUPLICATE_PREDICTION_COUNT_KEY,
  MEAN_MATCHED_IOU_KEY,
  OBJECT_F1_KEY,
  OBJECT_PRECISION_KEY,
  OBJECT_RECALL_KEY,
  UNSUPPORTED_INVENTORY_ITEM_RATE_KEY,
  boxIou,
  evaluateScanDetection,
  labelsCompatible,
  matchDetections,
} from "../../../../../app/server/evals/evaluators/scan-detection.evaluator";

import { detection, evalResult, feedbackByKey, scanCase, scanOutput } from "./helpers";

const box = { x: 0.1, y: 0.1, width: 0.2, height: 0.2 };
const shiftedBox = { x: 0.15, y: 0.1, width: 0.2, height: 0.2 };
const farBox = { x: 0.7, y: 0.7, width: 0.2, height: 0.2 };

function goldDetection(id: string, label: string, boundingBox = box) {
  return { id, label, boundingBox, zoneId: null };
}

function scanResult(output: Record<string, unknown>) {
  return evalResult({ suite: "scan", caseId: "case-scan-1", output });
}

describe("boxIou", () => {
  it("computes exact IoU values", () => {
    expect(boxIou(box, box)).toBeCloseTo(1, 10);
    expect(boxIou(box, farBox)).toBe(0);
    // x-overlap 0.15..0.30 = 0.15 wide, full 0.2 height shared.
    const intersection = 0.15 * 0.2;
    const union = 0.04 + 0.04 - intersection;
    expect(boxIou(box, shiftedBox)).toBeCloseTo(intersection / union, 10);
  });
});

describe("labelsCompatible", () => {
  it("matches case-insensitively, trims, and tolerates plural variants", () => {
    expect(labelsCompatible(" Milk ", "milk")).toBe(true);
    expect(labelsCompatible("tomatoes", "tomato")).toBe(true);
    expect(labelsCompatible("apples", "apple")).toBe(true);
    expect(labelsCompatible("berries", "berry")).toBe(true);
    expect(labelsCompatible("boxes", "box")).toBe(true);
    expect(labelsCompatible("milk", "cheese")).toBe(false);
    expect(labelsCompatible("glass", "glas")).toBe(false);
  });
});

describe("matchDetections", () => {
  it("matches one-to-one by descending IoU", () => {
    const gold = [goldDetection("gold-a", "milk", box), goldDetection("gold-b", "milk", farBox)];
    const predictions = [
      { index: 0, label: "milk", box: farBox },
      { index: 1, label: "milk", box },
    ];
    const matches = matchDetections(gold, predictions);

    expect(matches).toHaveLength(2);
    expect(matches.find((match) => match.gold.id === "gold-a")?.prediction.index).toBe(1);
    expect(matches.find((match) => match.gold.id === "gold-b")?.prediction.index).toBe(0);
  });

  it("breaks IoU ties by gold id then prediction index", () => {
    // Two identical predictions tie on IoU against one gold: lower index wins.
    const matches = matchDetections(
      [goldDetection("gold-a", "milk")],
      [
        { index: 0, label: "milk", box },
        { index: 1, label: "milk", box },
      ],
    );
    expect(matches).toHaveLength(1);
    expect(matches[0].prediction.index).toBe(0);

    // Two golds tie against one prediction: lexicographically smaller gold id wins.
    const goldTie = matchDetections(
      [goldDetection("gold-b", "milk"), goldDetection("gold-a", "milk")],
      [{ index: 0, label: "milk", box }],
    );
    expect(goldTie).toHaveLength(1);
    expect(goldTie[0].gold.id).toBe("gold-a");
  });

  it("never matches incompatible labels even with perfect overlap", () => {
    expect(matchDetections(
      [goldDetection("gold-a", "cheese")],
      [{ index: 0, label: "milk", box }],
    )).toHaveLength(0);
  });
});

describe("evaluateScanDetection", () => {
  it("reports perfect metrics for an exact match", () => {
    const feedback = feedbackByKey(evaluateScanDetection({
      caseData: scanCase({
        expected: { terminalRoute: "finalize_scan", detections: [goldDetection("gold-a", "milk")] },
      }),
      result: scanResult(scanOutput({
        rawDetections: [detection({ id: "det-1", name: "milk", bbox: box })],
        inventory: { items: [{ name: "milk" }] },
      })),
    }));

    for (const key of [
      OBJECT_PRECISION_KEY,
      OBJECT_RECALL_KEY,
      OBJECT_F1_KEY,
      MEAN_MATCHED_IOU_KEY,
      BOX_RECALL_AT_50_KEY,
      DUPLICATE_PREDICTION_COUNT_KEY,
      UNSUPPORTED_INVENTORY_ITEM_RATE_KEY,
    ]) {
      expect(feedback.get(key)?.score, key).toBe(1);
    }
    expect(feedback.get(OBJECT_PRECISION_KEY)?.comment).toContain("satisfied");
  });

  it("scores the metric value itself and notes an unmet threshold", () => {
    const feedback = feedbackByKey(evaluateScanDetection({
      caseData: scanCase({
        expected: {
          terminalRoute: "finalize_scan",
          detections: [
            goldDetection("gold-a", "milk"),
            goldDetection("gold-b", "cheese", farBox),
          ],
          minimumDetectionRecall: 0.9,
        },
      }),
      result: scanResult(scanOutput({
        rawDetections: [detection({ id: "det-1", name: "milk", bbox: box })],
        inventory: null,
      })),
    }));

    expect(feedback.get(OBJECT_RECALL_KEY)?.score).toBeCloseTo(0.5, 10);
    expect(feedback.get(OBJECT_RECALL_KEY)?.comment).toContain("NOT satisfied");
    expect(feedback.get(OBJECT_PRECISION_KEY)?.score).toBe(1);
    expect(feedback.get(OBJECT_F1_KEY)?.score).toBeCloseTo(2 / 3, 10);
  });

  it("counts duplicate predictions overlapping an already-matched gold", () => {
    const feedback = feedbackByKey(evaluateScanDetection({
      caseData: scanCase({
        expected: { terminalRoute: "finalize_scan", detections: [goldDetection("gold-a", "milk")] },
      }),
      result: scanResult(scanOutput({
        rawDetections: [
          detection({ id: "det-1", name: "milk", bbox: box }),
          detection({ id: "det-2", name: "milk", bbox: shiftedBox }),
        ],
        inventory: null,
      })),
    }));

    expect(feedback.get(DUPLICATE_PREDICTION_COUNT_KEY)?.score).toBe(0);
    expect(feedback.get(DUPLICATE_PREDICTION_COUNT_KEY)?.comment).toContain("count: 1");
  });

  it("scores unsupported inventory items as 1 - rate", () => {
    const feedback = feedbackByKey(evaluateScanDetection({
      caseData: scanCase(),
      result: scanResult(scanOutput({
        rawDetections: [detection({ id: "det-1", name: "milk", bbox: box })],
        inventory: { items: [{ name: "milk" }, { name: "dragonfruit" }] },
      })),
    }));

    expect(feedback.get(UNSUPPORTED_INVENTORY_ITEM_RATE_KEY)?.score).toBeCloseTo(0.5, 10);
    expect(feedback.get(UNSUPPORTED_INVENTORY_ITEM_RATE_KEY)?.comment).toContain("dragonfruit");
  });

  it("passes detection metrics as not-asserted when the case has no gold detections", () => {
    const feedback = feedbackByKey(evaluateScanDetection({
      caseData: scanCase(),
      result: scanResult(scanOutput({ inventory: null })),
    }));

    expect(feedback.get(OBJECT_PRECISION_KEY)?.score).toBe(1);
    expect(feedback.get(OBJECT_PRECISION_KEY)?.comment).toContain("Not asserted");
    expect(feedback.get(MEAN_MATCHED_IOU_KEY)?.comment).toContain("Not asserted");
  });

  it("scores zero across matched metrics when nothing matches", () => {
    const feedback = feedbackByKey(evaluateScanDetection({
      caseData: scanCase({
        expected: { terminalRoute: "finalize_scan", detections: [goldDetection("gold-a", "cheese")] },
      }),
      result: scanResult(scanOutput({
        rawDetections: [detection({ id: "det-1", name: "milk", bbox: box })],
        inventory: null,
      })),
    }));

    expect(feedback.get(OBJECT_PRECISION_KEY)?.score).toBe(0);
    expect(feedback.get(OBJECT_RECALL_KEY)?.score).toBe(0);
    expect(feedback.get(OBJECT_F1_KEY)?.score).toBe(0);
    expect(feedback.get(MEAN_MATCHED_IOU_KEY)?.score).toBe(0);
    expect(feedback.get(BOX_RECALL_AT_50_KEY)?.score).toBe(0);
  });
});
