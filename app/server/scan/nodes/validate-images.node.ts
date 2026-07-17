import { loadPromptBundle } from "../../prompts/registry.server";
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

export async function validateImageNode(state: ScanStateValue) {
  return validateImagesNode(state, {
    promptBundle: await loadPromptBundle(),
  });
}

export function createValidateImagesNode(deps: ImageValidationDependencies) {
  return (state: ScanStateValue) => validateImagesNode(state, deps);
}
