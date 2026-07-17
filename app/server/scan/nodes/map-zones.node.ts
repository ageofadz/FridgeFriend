import { loadPromptBundle } from "../../prompts/registry.server";
import { mapZones } from "../services/zone-map.server";
import type { ZoneMapDependencies } from "../services/zone-map.server";
import type { ScanStateValue } from "../state";

export async function mapZonesNode(
  state: ScanStateValue,
  deps: ZoneMapDependencies,
) {
  return mapZones(state, deps);
}

export async function mapZonesStateNode(state: ScanStateValue) {
  return mapZonesNode(state, {
    promptBundle: await loadPromptBundle(),
  });
}

export function createMapZonesNode(deps: ZoneMapDependencies) {
  return (state: ScanStateValue) => mapZonesNode(state, deps);
}
