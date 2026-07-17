import { validateMemoryCandidate } from "../../memory/repository.server";
import type { FridgeQueryStateValue } from "../state";

export async function validateMemoryCandidatesNode(state: FridgeQueryStateValue) {
  return {
    memoryValidations: state.memoryCandidates.map(validateMemoryCandidate),
  };
}
