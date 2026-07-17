import { loadPromptBundle } from "../../prompts/registry.server";
import { detectInventory } from "../services/inventory-detection.server";
import type { InventoryDetectionDependencies } from "../services/inventory-detection.server";
import type { ScanStateValue } from "../state";

export async function detectInventoryNode(
  state: ScanStateValue,
  deps: InventoryDetectionDependencies,
) {
  return detectInventory(state, deps);
}

export async function detectInventoryStateNode(state: ScanStateValue) {
  return detectInventoryNode(state, {
    promptBundle: await loadPromptBundle(),
  });
}

export function createDetectInventoryNode(deps: InventoryDetectionDependencies) {
  return (state: ScanStateValue) => detectInventoryNode(state, deps);
}
