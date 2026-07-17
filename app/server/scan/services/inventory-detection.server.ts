import { ChatGoogleGenerativeAI } from "@langchain/google-genai";

import type { PromptBundle } from "../../prompts/registry.server";
import {
  RawDetection as RawDetectionSchema,
  VISION_MODEL,
  type RawDetection,
} from "../schemas/inventory";
import {
  InventoryDetectionResponseSchema,
  type InventoryDetectionModelResult as InventoryDetectionModelResultValue,
} from "../schemas/scan-result";
import type { ScanStateValue } from "../state";
import {
  assertImagesAreLocallyLoadable,
  loadImageDataUrls,
} from "./image-data.server";
import {
  formatModelValidationError,
  normalizeModelBoundingBox,
} from "./model-output.server";
import { promptMessages } from "./prompt-messages.server";
import { createVisionModel } from "./vision-model.server";

export type InventoryDetectionDependencies = {
  promptBundle: Pick<PromptBundle, "inventoryDetection">;
  detectionModel?: ChatGoogleGenerativeAI;
};

function invalidInventoryDetection(reason: string) {
  return {
    rawDetections: [],
    detectionModelRawOutput: null,
    detectionValidation: {
      valid: false,
      reason,
    },
  };
}

function invalidInventoryDetectionWithModelOutput(
  reason: string,
  detectionModelRawOutput: InventoryDetectionModelResultValue,
) {
  return {
    rawDetections: [],
    detectionModelRawOutput,
    detectionValidation: {
      valid: false,
      reason,
    },
  };
}

function normalizeModelImageId(value: unknown) {
  if (typeof value !== "string") {
    return value;
  }

  return value.replace(/\.(?:jpe?g|png|webp)$/iu, "");
}

function normalizeModelRawDetections(
  rawDetections: InventoryDetectionModelResultValue["rawDetections"],
) {
  return rawDetections.map((detection) => ({
    ...detection,
    img: normalizeModelImageId(detection.img),
    bbox: normalizeModelBoundingBox(detection.bbox),
  }));
}

function validateRawDetectionImageIds(
  rawDetections: RawDetection[],
  imageId: string,
) {
  const mismatchedDetection = rawDetections.find((detection) =>
    detection.img !== imageId
  );

  return mismatchedDetection
    ? `Inventory detection output failed validation: detection ${mismatchedDetection.id} img must equal ${imageId}`
    : null;
}

function validateRawDetectionStacking(rawDetections: RawDetection[]) {
  const detectionsById = new Map<string, RawDetection>();

  for (const detection of rawDetections) {
    if (detectionsById.has(detection.id)) {
      return `Inventory detection output failed validation: duplicate detection id ${detection.id}`;
    }

    detectionsById.set(detection.id, detection);
  }

  for (const detection of rawDetections) {
    if (!detection.stack) {
      continue;
    }

    if (detection.stack.on === detection.id) {
      return `Inventory detection output failed validation: stack for ${detection.id} cannot reference itself`;
    }

    const supportingDetection = detectionsById.get(
      detection.stack.on,
    );

    if (!supportingDetection) {
      return `Inventory detection output failed validation: stack for ${detection.id} references unknown detection id ${detection.stack.on}`;
    }

    if (supportingDetection.img !== detection.img) {
      return `Inventory detection output failed validation: stack for ${detection.id} references a detection from a different image`;
    }
  }

  return null;
}

async function runInventoryDetectionModel(
  input: {
    imageId: string;
    imageDataUrl: string;
  },
  deps: InventoryDetectionDependencies,
): Promise<InventoryDetectionModelResultValue> {
  const model = deps.detectionModel ?? createVisionModel();
  const structuredModel = model.withStructuredOutput<InventoryDetectionModelResultValue>(
    InventoryDetectionResponseSchema,
    {
      name: "InventoryDetection",
    },
  );
  const loadedPrompt = deps.promptBundle.inventoryDetection;
  const messages = await promptMessages(loadedPrompt, {
    image_id: input.imageId,
    image_data_url: input.imageDataUrl,
  });

  return structuredModel.invoke(messages, {
    tags: ["scan", "detect_inventory"],
    metadata: {
      langsmithPromptName: loadedPrompt.name,
      langsmithPromptRef: loadedPrompt.ref,
      model: VISION_MODEL,
    },
  });
}

export async function detectInventory(
  state: ScanStateValue,
  deps: InventoryDetectionDependencies,
): Promise<{
  rawDetections: RawDetection[];
  detectionModelRawOutput: InventoryDetectionModelResultValue | null;
  detectionValidation: {
    valid: boolean;
    reason: string;
  };
}> {
  let imageDataUrls: string[];

  try {
    imageDataUrls = loadImageDataUrls(state.imageIds);
    assertImagesAreLocallyLoadable(imageDataUrls);
  } catch (error) {
    return invalidInventoryDetection(
      error instanceof Error ? error.message : String(error),
    );
  }

  const result = await runInventoryDetectionModel(
    {
      imageId: state.imageIds[0],
      imageDataUrl: imageDataUrls[0],
    },
    deps,
  );
  const parsedRawDetections = RawDetectionSchema.array().safeParse(
    normalizeModelRawDetections(result.rawDetections),
  );

  if (!parsedRawDetections.success) {
    return invalidInventoryDetectionWithModelOutput(
      `Inventory detection output failed validation: ${formatModelValidationError(parsedRawDetections.error, "rawDetections")}`,
      result,
    );
  }

  const imageIdValidationReason = validateRawDetectionImageIds(
    parsedRawDetections.data,
    state.imageIds[0],
  );

  if (imageIdValidationReason) {
    return invalidInventoryDetectionWithModelOutput(
      imageIdValidationReason,
      result,
    );
  }

  const stackingValidationReason = validateRawDetectionStacking(
    parsedRawDetections.data,
  );

  if (stackingValidationReason) {
    return invalidInventoryDetectionWithModelOutput(
      stackingValidationReason,
      result,
    );
  }

  return {
    rawDetections: parsedRawDetections.data,
    detectionModelRawOutput: result,
    detectionValidation: {
      valid: true,
      reason: "Inventory detection completed",
    },
  };
}
