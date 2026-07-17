import type { ScanStateValue } from "../state";

export function routeAfterImageValidation(
  state: ScanStateValue,
): "start_scan_analysis" | "scan_failed" {
  return state.imageValidation?.valid ? "start_scan_analysis" : "scan_failed";
}

export function routeAfterLocationReconciliation(
  state: ScanStateValue,
): "adjudicate_locations" | "reconcile_inventory" | "scan_failed" {
  if (!state.reconciliationValidation?.valid) {
    return "scan_failed";
  }

  return state.ambiguousLocationRequests.length > 0
    ? "adjudicate_locations"
    : "reconcile_inventory";
}

export function routeAfterLocationAdjudication(
  state: ScanStateValue,
): "reconcile_inventory" | "scan_failed" {
  return state.adjudicationValidation?.valid
    ? "reconcile_inventory"
    : "scan_failed";
}
