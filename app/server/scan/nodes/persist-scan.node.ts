import type { ScanStateValue } from "../state";

export async function persistScanNode(state: ScanStateValue) {
  if (!state.inventory) {
    throw new Error("Cannot persist a missing inventory");
  }

  return {
    inventory: state.inventory,
    scanStatus: "completed",
  };
}

export async function scanFailedNode(state: ScanStateValue) {
  if (state.imageValidation && !state.imageValidation.valid) {
    return {
      scanStatus: "failed",
      error: {
        stage: "validate_images",
        code: "image_validation_failed",
        message: state.imageValidation.reason ?? "Image validation failed",
        retryable: false,
      },
    };
  }

  if (state.detectionValidation && !state.detectionValidation.valid) {
    return {
      scanStatus: "failed",
      error: {
        stage: "detect_inventory",
        code: "detection_validation_failed",
        message:
          state.detectionValidation.reason ?? "Detection validation failed",
        retryable: false,
      },
    };
  }

  if (state.zoneMapValidation && !state.zoneMapValidation.valid) {
    return {
      scanStatus: "failed",
      error: {
        stage: "map_zones",
        code: "zone_map_validation_failed",
        message: state.zoneMapValidation.reason ?? "Zone map validation failed",
        retryable: false,
      },
    };
  }

  if (
    state.reconciliationValidation &&
    !state.reconciliationValidation.valid
  ) {
    return {
      scanStatus: "failed",
      error: {
        stage: "reconcile_locations",
        code: "location_reconciliation_failed",
        message:
          state.reconciliationValidation.reason ??
          "Location reconciliation failed",
        retryable: false,
      },
    };
  }

  if (state.adjudicationValidation && !state.adjudicationValidation.valid) {
    return {
      scanStatus: "failed",
      error: {
        stage: "adjudicate_locations",
        code: "location_adjudication_failed",
        message:
          state.adjudicationValidation.reason ?? "Location adjudication failed",
        retryable: false,
      },
    };
  }

  return {
    scanStatus: "failed",
    error: {
      stage: "persist_scan",
      code: "scan_failed",
      message: "Scan failed",
      retryable: false,
    },
  };
}
