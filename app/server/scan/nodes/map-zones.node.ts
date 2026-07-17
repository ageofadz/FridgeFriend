import { mapZones } from "../services/zone-map.server";
import type { ZoneMapDependencies } from "../services/zone-map.server";
import type { ScanStateValue } from "../state";

export function createMapZonesNode(deps: ZoneMapDependencies) {
  return (state: ScanStateValue) => mapZones(state, deps);
}
