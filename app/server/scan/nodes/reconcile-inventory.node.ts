import { reconcileInventory } from "../services/inventory-reconciliation.server";
import type { ScanStateValue } from "../state";

export async function reconcileInventoryNode(state: ScanStateValue) {
  try {
    const { inventory } = await reconcileInventory(state);

    return {
      inventory,
      inventoryValidation: {
        valid: true,
        reason: "Inventory reconciliation completed",
      },
    };
  } catch (error) {
    // Schema-valid but inconsistent detections (e.g. stacking cycles or
    // dangling stack references) are data failures, not crashes — surface
    // them as a validation result so routing sends the scan to scan_failed.
    return {
      inventory: null,
      inventoryValidation: {
        valid: false,
        reason: error instanceof Error ? error.message : String(error),
      },
    };
  }
}
