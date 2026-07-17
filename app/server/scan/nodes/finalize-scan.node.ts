import type { ScanStateValue } from "../state";

/**
 * Marks a successful scan as completed in graph state. This node does not
 * write to the database — the caller persists the inventory (see
 * `saveFridgeInventory` in the upload route); this node only records the
 * final inventory and status in the scan thread's checkpoint.
 */
export async function finalizeScanNode(state: ScanStateValue) {
  if (!state.inventory) {
    throw new Error("Cannot finalize a scan with a missing inventory");
  }

  return {
    inventory: state.inventory,
    scanStatus: "completed",
  };
}
