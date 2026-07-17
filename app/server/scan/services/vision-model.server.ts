import {
  CHAT_IMAGE_VALIDATION_MODEL as IMAGE_VALIDATION_MODEL,
  CHAT_VISION_PROVIDER as VISION_PROVIDER,
  CHAT_VISION_MODEL as VISION_MODEL,
  createChatModel,
} from "../../ai/chat-model.server";

export function createVisionModel(model = VISION_MODEL) {
  return createChatModel({
    model,
    provider: VISION_PROVIDER,
  });
}

export function createImageValidationModel() {
  return createVisionModel(IMAGE_VALIDATION_MODEL);
}
