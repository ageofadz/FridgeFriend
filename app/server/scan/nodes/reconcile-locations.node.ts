import { reconcileLocations } from "../services/location-reconciliation.server";
import type { ScanStateValue } from "../state";

export async function reconcileLocationsNode(state: ScanStateValue) {
  return reconcileLocations(state);
}
