import type { FridgeFriendChatModel } from "../../ai/chat-model.server";
import {
  CHAT_IMAGE_VALIDATION_MODEL as IMAGE_VALIDATION_MODEL,
  CHAT_VISION_PROVIDER as CHAT_PROVIDER,
} from "../../ai/chat-model.server";
import type { PromptBundle } from "../../prompts/registry.server";
import {
  assertImagesAreLocallyLoadable,
  loadImageDataUrls,
} from "./image-data.server";
import { promptMessages } from "./prompt-messages.server";
import { createImageValidationModel } from "./vision-model.server";
import type { ScanStateValue } from "../state";
import {
  ImageValidationModelResult,
  type ImageValidationModelResult as ImageValidationModelResultValue,
} from "../schemas/scan-result";

export type ImageValidationDependencies = {
  promptBundle: Pick<PromptBundle, "imageValidation">;
  validationModel?: FridgeFriendChatModel;
  loadImageDataUrls?: (imageIds: string[]) => string[];
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
  const structuredModel = model.withStructuredOutput<ImageValidationModelResultValue>(
    ImageValidationModelResult,
    {
      name: "ImageValidation",
    },
  );
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
        provider: CHAT_PROVIDER,
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
    imageDataUrls = (deps.loadImageDataUrls ?? loadImageDataUrls)(state.imageIds);
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
