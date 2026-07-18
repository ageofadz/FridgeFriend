import {
  FridgeZoneMap,
  GroundedPlacement,
  Inventory,
  RawDetection,
} from "../../scan/schemas/inventory";
import { ValidationResult } from "../../scan/schemas/scan-result";
import type { EvalFeedback, EvalResult } from "../schemas/eval-result";
import type { ScanEvalCase } from "../schemas/scan-eval-case";

import { feedback, passFail, readScanOutput, recordsOf } from "./shared";

export const SCAN_TERMINAL_ROUTE_KEY = "scan_terminal_route";
export const IMAGE_VALIDATION_CORRECT_KEY = "image_validation_correct";
export const DETECTION_SCHEMA_VALID_KEY = "detection_schema_valid";
export const ZONE_SCHEMA_VALID_KEY = "zone_schema_valid";
export const PLACEMENT_SCHEMA_VALID_KEY = "placement_schema_valid";
export const INVENTORY_SCHEMA_VALID_KEY = "inventory_schema_valid";
export const ZONE_SUPPORT_VALID_KEY = "zone_support_valid";
export const PLACEMENT_CONSTRAINTS_VALID_KEY = "placement_constraints_valid";

// Detections coming through eval fixtures may spell the box `boundingBox` and
// the label `label`; production RawDetection uses `bbox` and `name`.
export function normalizeDetectionRecord(detection: Record<string, unknown>): Record<string, unknown> {
  const bbox = detection.bbox ?? detection.boundingBox;
  const name = detection.name ?? detection.label;
  const { boundingBox: _boundingBox, label: _label, ...rest } = detection;
  return { ...rest, ...(bbox !== undefined ? { bbox } : {}), ...(name !== undefined ? { name } : {}) };
}

function schemaFeedback(key: string, label: string, issues: string[], count: number): EvalFeedback {
  return passFail(
    key,
    issues.length === 0,
    issues.length === 0
      ? `All ${count} ${label} entries satisfy the production schema.`
      : `${label} schema violations: ${issues.slice(0, 3).join("; ")}.`,
  );
}

export function evaluateScanContract(input: {
  caseData: ScanEvalCase;
  result: EvalResult;
}): EvalFeedback[] {
  const expected = input.caseData.expected;
  const output = readScanOutput(input.result);

  const terminalFeedback = passFail(
    SCAN_TERMINAL_ROUTE_KEY,
    output.terminalRoute === expected.terminalRoute,
    `Expected terminal route ${expected.terminalRoute}; received ${output.terminalRoute || "none"}.`,
  );

  let imageValidationFeedback: EvalFeedback;
  if (expected.imageValid === undefined) {
    imageValidationFeedback = feedback(
      IMAGE_VALIDATION_CORRECT_KEY,
      1,
      "Not asserted: case declares no image-validity expectation.",
    );
  } else {
    const parsed = ValidationResult.safeParse(output.imageValidation);
    imageValidationFeedback = passFail(
      IMAGE_VALIDATION_CORRECT_KEY,
      parsed.success && parsed.data.valid === expected.imageValid,
      parsed.success
        ? `Expected image validity ${String(expected.imageValid)}; received ${String(parsed.data.valid)}${parsed.data.reason ? ` (${parsed.data.reason})` : ""}.`
        : "Image validation result missing or malformed.",
    );
  }

  const detectionRecords = recordsOf(output.rawDetections).map(normalizeDetectionRecord);
  const detectionIssues = detectionRecords.flatMap((detection, index) => {
    const parsed = RawDetection.safeParse(detection);
    return parsed.success ? [] : [`rawDetections[${index}]: ${parsed.error.issues[0]?.message ?? "invalid"}`];
  });
  const nonRecordDetections = output.rawDetections.length - detectionRecords.length;
  if (nonRecordDetections > 0) detectionIssues.push(`${nonRecordDetections} detections are not objects`);

  const zoneIssues = output.zoneMaps.flatMap((zoneMap, index) => {
    const parsed = FridgeZoneMap.safeParse(zoneMap);
    return parsed.success ? [] : [`zoneMaps[${index}]: ${parsed.error.issues[0]?.message ?? "invalid"}`];
  });

  const placementIssues = output.groundedPlacements.flatMap((placement, index) => {
    const parsed = GroundedPlacement.safeParse(placement);
    return parsed.success ? [] : [`groundedPlacements[${index}]: ${parsed.error.issues[0]?.message ?? "invalid"}`];
  });

  let inventoryFeedback: EvalFeedback;
  if (output.inventory === null || output.inventory === undefined) {
    inventoryFeedback = passFail(
      INVENTORY_SCHEMA_VALID_KEY,
      expected.terminalRoute === "scan_failed",
      expected.terminalRoute === "scan_failed"
        ? "No inventory produced, as expected for a failed scan."
        : "No inventory produced for a scan expected to finalize.",
    );
  } else {
    const parsed = Inventory.safeParse(output.inventory);
    inventoryFeedback = passFail(
      INVENTORY_SCHEMA_VALID_KEY,
      parsed.success,
      parsed.success
        ? `Inventory with ${parsed.data.items.length} items satisfies the production schema.`
        : `Inventory schema violation: ${parsed.error.issues[0]?.message ?? "invalid"}.`,
    );
  }

  const zoneIds = new Set(
    recordsOf(output.zoneMaps).flatMap((zoneMap) =>
      recordsOf(Array.isArray(zoneMap.zones) ? zoneMap.zones : [])
        .flatMap((zone) => typeof zone.id === "string" ? [zone.id] : [])
    ),
  );
  const detectionIds = new Set(
    detectionRecords.flatMap((detection) => typeof detection.id === "string" ? [detection.id] : []),
  );
  const placements = recordsOf(output.groundedPlacements);

  // "Placed" placements must reference a real support: a zone id from the zone
  // maps when supportKind is "zone", or another detection id when "item".
  const unsupported = placements.flatMap((placement) => {
    if (placement.status !== "placed" || typeof placement.supportId !== "string") return [];
    if (placement.supportKind === "zone" && !zoneIds.has(placement.supportId)) {
      return [`${String(placement.detectionId)} -> zone ${placement.supportId}`];
    }
    if (placement.supportKind === "item" && !detectionIds.has(placement.supportId)) {
      return [`${String(placement.detectionId)} -> item ${placement.supportId}`];
    }
    return [];
  });

  const placementDetectionIds = placements
    .map((placement) => placement.detectionId)
    .filter((value): value is string => typeof value === "string");
  const unknownDetectionRefs = placementDetectionIds.filter((id) => !detectionIds.has(id));
  const duplicateDetectionRefs = placementDetectionIds.filter(
    (id, index) => placementDetectionIds.indexOf(id) !== index,
  );

  return [
    terminalFeedback,
    imageValidationFeedback,
    schemaFeedback(DETECTION_SCHEMA_VALID_KEY, "rawDetections", detectionIssues, detectionRecords.length),
    schemaFeedback(ZONE_SCHEMA_VALID_KEY, "zoneMaps", zoneIssues, output.zoneMaps.length),
    schemaFeedback(PLACEMENT_SCHEMA_VALID_KEY, "groundedPlacements", placementIssues, output.groundedPlacements.length),
    inventoryFeedback,
    passFail(
      ZONE_SUPPORT_VALID_KEY,
      unsupported.length === 0,
      unsupported.length === 0
        ? `All ${placements.length} placements reference known supports.`
        : `Placements referencing unknown supports: ${unsupported.join(", ")}.`,
    ),
    passFail(
      PLACEMENT_CONSTRAINTS_VALID_KEY,
      unknownDetectionRefs.length === 0 && duplicateDetectionRefs.length === 0,
      `Unknown placement detection ids: ${unknownDetectionRefs.join(", ") || "none"}; duplicate placement detection ids: ${[...new Set(duplicateDetectionRefs)].join(", ") || "none"}.`,
    ),
  ];
}
