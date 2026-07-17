import { groundItemPlacements } from "../services/item-placement-grounding.server";
import type { ScanStateValue } from "../state";

export function createGroundItemPlacementsNode(
  deps = {},
) {
  return async (state: ScanStateValue) => groundItemPlacements(state, deps);
}
