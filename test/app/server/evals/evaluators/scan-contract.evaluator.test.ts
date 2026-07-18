import { describe, expect, it } from "vitest";

import {
  DETECTION_SCHEMA_VALID_KEY,
  IMAGE_VALIDATION_CORRECT_KEY,
  INVENTORY_SCHEMA_VALID_KEY,
  PLACEMENT_CONSTRAINTS_VALID_KEY,
  PLACEMENT_SCHEMA_VALID_KEY,
  SCAN_TERMINAL_ROUTE_KEY,
  ZONE_SCHEMA_VALID_KEY,
  ZONE_SUPPORT_VALID_KEY,
  evaluateScanContract,
} from "../../../../../app/server/evals/evaluators/scan-contract.evaluator";

import {
  detection,
  evalResult,
  feedbackByKey,
  inventoryRecord,
  placedPlacement,
  scanCase,
  scanOutput,
  zoneMap,
} from "./helpers";

function scanResult(output: Record<string, unknown>) {
  return evalResult({ suite: "scan", caseId: "case-scan-1", output });
}

describe("evaluateScanContract", () => {
  it("passes every key for a fully valid finalized scan", () => {
    const feedback = feedbackByKey(evaluateScanContract({
      caseData: scanCase({ expected: { terminalRoute: "finalize_scan", imageValid: true } }),
      result: scanResult(scanOutput({ inventory: inventoryRecord(["milk"]) })),
    }));

    for (const key of [
      SCAN_TERMINAL_ROUTE_KEY,
      IMAGE_VALIDATION_CORRECT_KEY,
      DETECTION_SCHEMA_VALID_KEY,
      ZONE_SCHEMA_VALID_KEY,
      PLACEMENT_SCHEMA_VALID_KEY,
      INVENTORY_SCHEMA_VALID_KEY,
      ZONE_SUPPORT_VALID_KEY,
      PLACEMENT_CONSTRAINTS_VALID_KEY,
    ]) {
      expect(feedback.get(key)?.score, key).toBe(1);
    }
  });

  it("fails scan_terminal_route on a mismatch", () => {
    const feedback = feedbackByKey(evaluateScanContract({
      caseData: scanCase({ expected: { terminalRoute: "finalize_scan" } }),
      result: scanResult(scanOutput({ terminalRoute: "scan_failed", inventory: inventoryRecord([]) })),
    }));

    expect(feedback.get(SCAN_TERMINAL_ROUTE_KEY)?.score).toBe(0);
  });

  it("fails image_validation_correct when validity disagrees with the expectation", () => {
    const feedback = feedbackByKey(evaluateScanContract({
      caseData: scanCase({ expected: { terminalRoute: "scan_failed", imageValid: false } }),
      result: scanResult(scanOutput({
        terminalRoute: "scan_failed",
        imageValidation: { valid: true, reason: "fridge" },
      })),
    }));

    expect(feedback.get(IMAGE_VALIDATION_CORRECT_KEY)?.score).toBe(0);
    expect(feedback.get(INVENTORY_SCHEMA_VALID_KEY)?.score).toBe(1);
  });

  it("fails detection_schema_valid for malformed detections and normalizes boundingBox/label spellings", () => {
    const malformed = feedbackByKey(evaluateScanContract({
      caseData: scanCase(),
      result: scanResult(scanOutput({
        rawDetections: [detection({ bbox: { x: 0.9, y: 0.9, width: 0.5, height: 0.5 } })],
        inventory: inventoryRecord([]),
      })),
    }));
    expect(malformed.get(DETECTION_SCHEMA_VALID_KEY)?.score).toBe(0);

    const normalized = feedbackByKey(evaluateScanContract({
      caseData: scanCase(),
      result: scanResult(scanOutput({
        rawDetections: [(() => {
          const { bbox, name, ...rest } = detection();
          return { ...rest, label: name, boundingBox: bbox };
        })()],
        inventory: inventoryRecord([]),
      })),
    }));
    expect(normalized.get(DETECTION_SCHEMA_VALID_KEY)?.score).toBe(1);
  });

  it("fails zone_schema_valid for zones violating the production schema", () => {
    const feedback = feedbackByKey(evaluateScanContract({
      caseData: scanCase(),
      result: scanResult(scanOutput({
        zoneMaps: [zoneMap({ zones: [{ id: "zone-1" }] })],
        inventory: inventoryRecord([]),
      })),
    }));

    expect(feedback.get(ZONE_SCHEMA_VALID_KEY)?.score).toBe(0);
  });

  it("fails placement_schema_valid for malformed placements", () => {
    const feedback = feedbackByKey(evaluateScanContract({
      caseData: scanCase(),
      result: scanResult(scanOutput({
        groundedPlacements: [{ detectionId: "det-1", status: "placed" }],
        inventory: inventoryRecord([]),
      })),
    }));

    expect(feedback.get(PLACEMENT_SCHEMA_VALID_KEY)?.score).toBe(0);
  });

  it("fails inventory_schema_valid when a finalized scan has no or invalid inventory", () => {
    const missing = feedbackByKey(evaluateScanContract({
      caseData: scanCase({ expected: { terminalRoute: "finalize_scan" } }),
      result: scanResult(scanOutput({ inventory: null })),
    }));
    expect(missing.get(INVENTORY_SCHEMA_VALID_KEY)?.score).toBe(0);

    const invalid = feedbackByKey(evaluateScanContract({
      caseData: scanCase(),
      result: scanResult(scanOutput({ inventory: { id: "inventory-1", items: [] } })),
    }));
    expect(invalid.get(INVENTORY_SCHEMA_VALID_KEY)?.score).toBe(0);
  });

  it("fails zone_support_valid when a placement references an unknown zone", () => {
    const feedback = feedbackByKey(evaluateScanContract({
      caseData: scanCase(),
      result: scanResult(scanOutput({
        groundedPlacements: [placedPlacement({ supportId: "zone-unknown" })],
        inventory: inventoryRecord([]),
      })),
    }));

    expect(feedback.get(ZONE_SUPPORT_VALID_KEY)?.score).toBe(0);
    expect(feedback.get(ZONE_SUPPORT_VALID_KEY)?.comment).toContain("zone-unknown");
  });

  it("fails placement_constraints_valid for unknown or duplicated detection ids", () => {
    const feedback = feedbackByKey(evaluateScanContract({
      caseData: scanCase(),
      result: scanResult(scanOutput({
        groundedPlacements: [
          placedPlacement(),
          placedPlacement(),
          placedPlacement({ detectionId: "det-unknown" }),
        ],
        inventory: inventoryRecord([]),
      })),
    }));

    expect(feedback.get(PLACEMENT_CONSTRAINTS_VALID_KEY)?.score).toBe(0);
    expect(feedback.get(PLACEMENT_CONSTRAINTS_VALID_KEY)?.comment).toContain("det-unknown");
    expect(feedback.get(PLACEMENT_CONSTRAINTS_VALID_KEY)?.comment).toContain("det-1");
  });
});
