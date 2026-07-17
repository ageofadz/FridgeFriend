import type { ScanStateValue } from "../state";

export async function scanFailedNode(state: ScanStateValue) {
  if (state.imageValidation && !state.imageValidation.valid) {
    return {
      scanStatus: "failed",
      error: {
        stage: "validate_images",
        code: "image_validation_failed",
        message: state.imageValidation.reason ?? "Image validation failed",
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
      },
    };
  }

  if (state.placementValidation && !state.placementValidation.valid) {
    return {
      scanStatus: "failed",
      error: {
        stage: "ground_item_placements",
        code: "item_placement_grounding_failed",
        message: state.placementValidation.reason ?? "Item placement grounding failed",
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
      },
    };
  }

  if (state.inventoryValidation && !state.inventoryValidation.valid) {
    return {
      scanStatus: "failed",
      error: {
        stage: "reconcile_inventory",
        code: "inventory_reconciliation_failed",
        message:
          state.inventoryValidation.reason ?? "Inventory reconciliation failed",
      },
    };
  }

  return {
    scanStatus: "failed",
    error: {
      stage: "finalize_scan",
      code: "scan_failed",
      message: "Scan failed",
    },
  };
}
