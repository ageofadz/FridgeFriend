import type { ScanStateValue } from "../state";

export function routeAfterImageValidation(
  state: ScanStateValue,
): "start_scan_analysis" | "scan_failed" {
  return state.imageValidation?.valid ? "start_scan_analysis" : "scan_failed";
}

export function routeAfterPlacementGrounding(
  state: ScanStateValue,
): "reconcile_inventory" | "scan_failed" {
  return state.placementValidation?.valid ? "reconcile_inventory" : "scan_failed";
}

export function routeAfterInventoryReconciliation(
  state: ScanStateValue,
): "finalize_scan" | "scan_failed" {
  return state.inventoryValidation?.valid ? "finalize_scan" : "scan_failed";
}
