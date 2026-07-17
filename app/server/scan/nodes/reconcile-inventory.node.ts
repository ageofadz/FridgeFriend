import { reconcileInventory } from "../services/inventory-reconciliation.server";
import type { ScanStateValue } from "../state";

export async function reconcileInventoryNode(state: ScanStateValue) {
  return reconcileInventory(state);
}
