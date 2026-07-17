import {
  type ImageValidationDependencies,
  validateImageState,
} from "../services/image-validation.server";
import type { ScanStateValue } from "../state";

export async function validateImagesNode(
  state: ScanStateValue,
  deps: ImageValidationDependencies,
) {
  return validateImageState(state, deps);
}

export function createValidateImagesNode(deps: ImageValidationDependencies) {
  return (state: ScanStateValue) => validateImagesNode(state, deps);
}
