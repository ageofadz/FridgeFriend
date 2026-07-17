import { detectInventory } from "../services/inventory-detection.server";
import type { InventoryDetectionDependencies } from "../services/inventory-detection.server";
import type { ScanStateValue } from "../state";

export function createDetectInventoryNode(deps: InventoryDetectionDependencies) {
  return (state: ScanStateValue) => detectInventory(state, deps);
}
