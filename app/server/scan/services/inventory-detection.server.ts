import type { FridgeFriendChatModel } from "../../ai/chat-model.server";
import { HumanMessage } from "@langchain/core/messages";
import {
  CHAT_VISION_PROVIDER as CHAT_PROVIDER,
  CHAT_VISION_MODEL as VISION_MODEL,
} from "../../ai/chat-model.server";
import type { PromptBundle } from "../../prompts/registry.server";
import {
  RawDetection as RawDetectionSchema,
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
  detectionModel?: FridgeFriendChatModel;
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

function validateInventoryDetectionResult(
  result: InventoryDetectionModelResultValue,
  imageId: string,
) {
  const parsedRawDetections = RawDetectionSchema.array().safeParse(
    normalizeModelRawDetections(result.rawDetections),
  );

  if (!parsedRawDetections.success) {
    return {
      valid: false as const,
      reason: `Inventory detection output failed validation: ${formatModelValidationError(parsedRawDetections.error, "rawDetections")}`,
    };
  }

  const imageIdValidationReason = validateRawDetectionImageIds(
    parsedRawDetections.data,
    imageId,
  );

  if (imageIdValidationReason) {
    return {
      valid: false as const,
      reason: imageIdValidationReason,
    };
  }

  const stackingValidationReason = validateRawDetectionStacking(
    parsedRawDetections.data,
  );

  if (stackingValidationReason) {
    return {
      valid: false as const,
      reason: stackingValidationReason,
    };
  }

  return {
    valid: true as const,
    rawDetections: parsedRawDetections.data,
  };
}

async function runInventoryDetectionModel(
  input: {
    imageId: string;
    imageDataUrl: string;
  },
  deps: InventoryDetectionDependencies,
  correctionReason?: string,
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

  if (correctionReason) {
    messages.push(new HumanMessage(
      `Correct the inventory detections you just produced for this same image. ${correctionReason} Return a complete replacement rawDetections array. Every bbox must tightly cover the visible item in one normalized 0-to-1 coordinate system, with width and height greater than 0.`,
    ));
  }

  return structuredModel.invoke(messages, {
    tags: ["scan", "detect_inventory"],
    metadata: {
      langsmithPromptName: loadedPrompt.name,
      langsmithPromptRef: loadedPrompt.ref,
      provider: CHAT_PROVIDER,
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

  let result = await runInventoryDetectionModel(
    {
      imageId: state.imageIds[0],
      imageDataUrl: imageDataUrls[0],
    },
    deps,
  );
  let validation = validateInventoryDetectionResult(result, state.imageIds[0]);

  for (let attempt = 0; !validation.valid && attempt < 2; attempt += 1) {
    result = await runInventoryDetectionModel(
      {
        imageId: state.imageIds[0],
        imageDataUrl: imageDataUrls[0],
      },
      deps,
      validation.reason,
    );
    validation = validateInventoryDetectionResult(result, state.imageIds[0]);
  }

  if (!validation.valid) {
    return invalidInventoryDetectionWithModelOutput(
      validation.reason,
      result,
    );
  }

  return {
    rawDetections: validation.rawDetections,
    detectionModelRawOutput: result,
    detectionValidation: {
      valid: true,
      reason: "Inventory detection completed",
    },
  };
}
