import { ChatGoogleGenerativeAI } from "@langchain/google-genai";

import type { PromptBundle } from "../../prompts/registry.server";
import {
  assertImagesAreLocallyLoadable,
  loadImageDataUrls,
} from "./image-data.server";
import { promptMessages } from "./prompt-messages.server";
import { createImageValidationModel } from "./vision-model.server";
import type { ScanStateValue } from "../state";
import { IMAGE_VALIDATION_MODEL } from "../schemas/inventory";
import {
  ImageValidationModelResult,
  type ImageValidationModelResult as ImageValidationModelResultValue,
} from "../schemas/scan-result";

export type ImageValidationDependencies = {
  promptBundle: Pick<PromptBundle, "imageValidation">;
  validationModel?: ChatGoogleGenerativeAI;
};

function invalidImageValidation(reason: string) {
  return {
    imageValidation: {
      valid: false,
      reason,
    },
  };
}

async function runImageValidationModel(
  imageDataUrls: string[],
  storageLocation: ScanStateValue["storageLocation"],
  deps: ImageValidationDependencies,
): Promise<ImageValidationModelResultValue> {
  const model = deps.validationModel ?? createImageValidationModel();
  const structuredModel = model.withStructuredOutput(ImageValidationModelResult, {
    name: "ImageValidation",
  });
  const loadedPrompt = deps.promptBundle.imageValidation;
  const messages = await promptMessages(loadedPrompt, {
    image_data_url: imageDataUrls[0],
    storage_location: storageLocation,
  });

  return structuredModel.invoke(
    messages,
    {
      tags: ["scan", "validate_image"],
      metadata: {
        langsmithPromptName: loadedPrompt.name,
        langsmithPromptRef: loadedPrompt.ref,
        model: IMAGE_VALIDATION_MODEL,
      },
    },
  );
}

export async function validateImageState(
  state: ScanStateValue,
  deps: ImageValidationDependencies,
) {
  let imageDataUrls: string[];

  try {
    imageDataUrls = loadImageDataUrls(state.imageIds);
    assertImagesAreLocallyLoadable(imageDataUrls);
  } catch (error) {
    return invalidImageValidation(
      error instanceof Error ? error.message : String(error),
    );
  }

  const result = await runImageValidationModel(
    imageDataUrls,
    state.storageLocation,
    deps,
  );

  if (!result.isFridge) {
    return invalidImageValidation(result.reason);
  }

  return {
    imageValidation: {
      valid: true,
      reason: result.reason,
    },
  };
}
