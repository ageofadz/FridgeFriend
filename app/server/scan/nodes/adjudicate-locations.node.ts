import { loadPromptBundle } from "../../prompts/registry.server";
import { adjudicateLocations } from "../services/location-adjudication.server";
import type { LocationAdjudicationDependencies } from "../services/location-adjudication.server";
import type { ScanStateValue } from "../state";

export async function adjudicateLocationsNode(
  state: ScanStateValue,
  deps: LocationAdjudicationDependencies,
) {
  return adjudicateLocations(state, deps);
}

export async function adjudicateLocationsStateNode(state: ScanStateValue) {
  return adjudicateLocationsNode(state, {
    promptBundle: await loadPromptBundle(),
  });
}

export function createAdjudicateLocationsNode(
  deps: LocationAdjudicationDependencies,
) {
  return (state: ScanStateValue) => adjudicateLocationsNode(state, deps);
}
