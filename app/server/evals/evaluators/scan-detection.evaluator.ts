import type { EvalFeedback, EvalResult } from "../schemas/eval-result";
import type { GoldDetection, ScanEvalCase } from "../schemas/scan-eval-case";

import { asRecord, feedback, readScanOutput, recordsOf } from "./shared";

export const OBJECT_PRECISION_KEY = "object_precision";
export const OBJECT_RECALL_KEY = "object_recall";
export const OBJECT_F1_KEY = "object_f1";
export const MEAN_MATCHED_IOU_KEY = "mean_matched_iou";
export const BOX_RECALL_AT_50_KEY = "box_recall_at_50";
export const DUPLICATE_PREDICTION_COUNT_KEY = "duplicate_prediction_count";
export const UNSUPPORTED_INVENTORY_ITEM_RATE_KEY = "unsupported_inventory_item_rate";

type Box = { x: number; y: number; width: number; height: number };

export function boxIou(left: Box, right: Box): number {
  const overlapWidth = Math.max(
    0,
    Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x),
  );
  const overlapHeight = Math.max(
    0,
    Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y),
  );
  const intersection = overlapWidth * overlapHeight;
  const union = left.width * left.height + right.width * right.height - intersection;
  return union === 0 ? 0 : intersection / union;
}

// Label compatibility: case-insensitive exact match after trimming, tolerant
// of English singular/plural variants ("tomato" ~ "tomatoes", "apple" ~
// "apples", "berry" ~ "berries"). Anything beyond that (synonyms, brand
// names) is the semantic judge's job, not this deterministic matcher's.
function normalizeLabel(label: string): string {
  const lowered = label.trim().toLowerCase();
  if (lowered.length > 3 && lowered.endsWith("ies")) return `${lowered.slice(0, -3)}y`;
  if (
    lowered.length > 3 &&
    ["ses", "xes", "zes", "oes", "ches", "shes"].some((suffix) => lowered.endsWith(suffix))
  ) {
    return lowered.slice(0, -2);
  }
  if (lowered.length > 1 && lowered.endsWith("s") && !lowered.endsWith("ss")) {
    return lowered.slice(0, -1);
  }
  return lowered;
}

export function labelsCompatible(left: string, right: string): boolean {
  return normalizeLabel(left) === normalizeLabel(right);
}

type Prediction = { index: number; label: string; box: Box };

function readBox(record: Record<string, unknown>): Box | null {
  const raw = asRecord(record.bbox) ?? asRecord(record.boundingBox);
  if (!raw) return null;
  const { x, y, width, height } = raw;
  return typeof x === "number" && typeof y === "number" &&
      typeof width === "number" && typeof height === "number"
    ? { x, y, width, height }
    : null;
}

function readPredictions(rawDetections: unknown[]): Prediction[] {
  return recordsOf(rawDetections).flatMap((record, index) => {
    const label = typeof record.name === "string"
      ? record.name
      : typeof record.label === "string"
      ? record.label
      : null;
    const box = readBox(record);
    return label && box ? [{ index, label, box }] : [];
  });
}

type Match = { gold: GoldDetection; prediction: Prediction; iou: number };

// One-to-one matching between gold detections and predictions: candidate
// pairs are label-compatible with IoU > 0, sorted by descending IoU with a
// deterministic tie-break by (gold id ascending, prediction index ascending),
// then consumed greedily. Greedy-by-descending-IoU approximates maximum-weight
// bipartite matching; it can be suboptimal in rare crossing-pair cases but is
// deterministic and dependency-free, which we prefer for eval reproducibility.
export function matchDetections(gold: GoldDetection[], predictions: Prediction[]): Match[] {
  const candidates: Match[] = [];
  for (const goldDetection of gold) {
    for (const prediction of predictions) {
      if (!labelsCompatible(goldDetection.label, prediction.label)) continue;
      const iou = boxIou(goldDetection.boundingBox, prediction.box);
      if (iou > 0) candidates.push({ gold: goldDetection, prediction, iou });
    }
  }

  candidates.sort((left, right) =>
    right.iou - left.iou ||
    left.gold.id.localeCompare(right.gold.id) ||
    left.prediction.index - right.prediction.index
  );

  const matchedGold = new Set<string>();
  const matchedPredictions = new Set<number>();
  const matches: Match[] = [];
  for (const candidate of candidates) {
    if (matchedGold.has(candidate.gold.id) || matchedPredictions.has(candidate.prediction.index)) {
      continue;
    }
    matchedGold.add(candidate.gold.id);
    matchedPredictions.add(candidate.prediction.index);
    matches.push(candidate);
  }

  return matches;
}

function metricFeedback(input: {
  key: string;
  value: number;
  detail: string;
  threshold?: { minimum: number; name: string };
}): EvalFeedback {
  const thresholdComment = input.threshold
    ? ` Threshold ${input.threshold.name}=${input.threshold.minimum.toFixed(2)} ${input.value >= input.threshold.minimum ? "satisfied" : "NOT satisfied"}.`
    : "";
  return feedback(input.key, input.value, `${input.detail}${thresholdComment}`);
}

function notAsserted(key: string): EvalFeedback {
  return feedback(key, 1, "Not asserted: case declares no gold detections.");
}

export function evaluateScanDetection(input: {
  caseData: ScanEvalCase;
  result: EvalResult;
}): EvalFeedback[] {
  const expected = input.caseData.expected;
  const output = readScanOutput(input.result);
  const predictions = readPredictions(output.rawDetections);

  // Unsupported inventory rate needs only predictions, not gold detections.
  const inventoryItems = recordsOf(
    Array.isArray(asRecord(output.inventory)?.items) ? (asRecord(output.inventory)!.items as unknown[]) : [],
  );
  const itemLabels = inventoryItems.flatMap((item) =>
    typeof item.name === "string" ? [item.name] : typeof item.label === "string" ? [item.label] : []
  );
  const unsupportedItems = itemLabels.filter((label) =>
    !predictions.some((prediction) => labelsCompatible(label, prediction.label))
  );
  const unsupportedRate = itemLabels.length === 0 ? 0 : unsupportedItems.length / itemLabels.length;
  const unsupportedFeedback = feedback(
    UNSUPPORTED_INVENTORY_ITEM_RATE_KEY,
    1 - unsupportedRate,
    `Unsupported inventory item rate ${unsupportedRate.toFixed(3)} (${unsupportedItems.length}/${itemLabels.length}); unsupported: ${unsupportedItems.join(", ") || "none"}.`,
  );

  if (!expected.detections) {
    return [
      notAsserted(OBJECT_PRECISION_KEY),
      notAsserted(OBJECT_RECALL_KEY),
      notAsserted(OBJECT_F1_KEY),
      notAsserted(MEAN_MATCHED_IOU_KEY),
      notAsserted(BOX_RECALL_AT_50_KEY),
      notAsserted(DUPLICATE_PREDICTION_COUNT_KEY),
      unsupportedFeedback,
    ];
  }

  const gold = expected.detections;
  const matches = matchDetections(gold, predictions);
  const truePositives = matches.length;
  const precision = predictions.length === 0
    ? (gold.length === 0 ? 1 : 0)
    : truePositives / predictions.length;
  const recall = gold.length === 0 ? 1 : truePositives / gold.length;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  const meanMatchedIou = matches.length === 0
    ? (gold.length === 0 ? 1 : 0)
    : matches.reduce((total, match) => total + match.iou, 0) / matches.length;
  const boxRecallAt50 = gold.length === 0
    ? 1
    : matches.filter((match) => match.iou >= 0.5).length / gold.length;

  // Duplicates: unmatched predictions that still overlap (IoU > 0) an
  // already-matched gold detection with a compatible label — i.e. extra
  // predictions for an object the matcher already accounted for.
  const matchedPredictionIndexes = new Set(matches.map((match) => match.prediction.index));
  const matchedGold = matches.map((match) => match.gold);
  const duplicates = predictions.filter((prediction) =>
    !matchedPredictionIndexes.has(prediction.index) &&
    matchedGold.some((goldDetection) =>
      labelsCompatible(goldDetection.label, prediction.label) &&
      boxIou(goldDetection.boundingBox, prediction.box) > 0
    )
  );

  return [
    metricFeedback({
      key: OBJECT_PRECISION_KEY,
      value: precision,
      detail: `Precision ${precision.toFixed(3)} (${truePositives}/${predictions.length} predictions matched).`,
      threshold: { minimum: expected.minimumDetectionPrecision, name: "minimumDetectionPrecision" },
    }),
    metricFeedback({
      key: OBJECT_RECALL_KEY,
      value: recall,
      detail: `Recall ${recall.toFixed(3)} (${truePositives}/${gold.length} gold detections matched).`,
      threshold: { minimum: expected.minimumDetectionRecall, name: "minimumDetectionRecall" },
    }),
    metricFeedback({
      key: OBJECT_F1_KEY,
      value: f1,
      detail: `F1 ${f1.toFixed(3)} from precision ${precision.toFixed(3)} and recall ${recall.toFixed(3)}.`,
    }),
    metricFeedback({
      key: MEAN_MATCHED_IOU_KEY,
      value: meanMatchedIou,
      detail: `Mean matched IoU ${meanMatchedIou.toFixed(3)} over ${matches.length} matches.`,
      threshold: { minimum: expected.minimumMatchedIou, name: "minimumMatchedIou" },
    }),
    metricFeedback({
      key: BOX_RECALL_AT_50_KEY,
      value: boxRecallAt50,
      detail: `Box recall at IoU 0.50: ${boxRecallAt50.toFixed(3)}.`,
    }),
    feedback(
      DUPLICATE_PREDICTION_COUNT_KEY,
      duplicates.length === 0 ? 1 : 0,
      `Duplicate prediction count: ${duplicates.length}${duplicates.length > 0 ? ` (prediction indexes ${duplicates.map((prediction) => prediction.index).join(", ")})` : ""}.`,
    ),
    unsupportedFeedback,
  ];
}
