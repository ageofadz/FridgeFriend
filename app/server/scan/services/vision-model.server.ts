import { ChatGoogleGenerativeAI } from "@langchain/google-genai";

import { requiredEnv } from "../../env.server";
import { IMAGE_VALIDATION_MODEL, VISION_MODEL } from "../schemas/inventory";

export function createVisionModel(model = VISION_MODEL) {
  return new ChatGoogleGenerativeAI({
    model,
    temperature: 0,
    maxRetries: 0,
    apiKey: requiredEnv("GOOGLE_API_KEY"),
  });
}

export function createImageValidationModel() {
  return createVisionModel(IMAGE_VALIDATION_MODEL);
}
