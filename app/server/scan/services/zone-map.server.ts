import { ChatGoogleGenerativeAI } from "@langchain/google-genai";

import type { PromptBundle } from "../../prompts/registry.server";
import {
  FridgeZoneMap,
  VISION_MODEL,
  type FridgeZoneMap as FridgeZoneMapValue,
} from "../schemas/inventory";
import {
  ZoneMapResponseSchema,
  type ZoneMapModelResult as ZoneMapModelResultValue,
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

export type ZoneMapDependencies = {
  promptBundle: Pick<PromptBundle, "zoneMap">;
  zoneMapModel?: ChatGoogleGenerativeAI;
};

function invalidZoneMap(reason: string) {
  return {
    zoneMaps: [],
    zoneMapModelRawOutput: null,
    zoneMapValidation: {
      valid: false,
      reason,
    },
  };
}

function invalidZoneMapWithModelOutput(
  reason: string,
  zoneMapModelRawOutput: ZoneMapModelResultValue,
) {
  return {
    zoneMaps: [],
    zoneMapModelRawOutput,
    zoneMapValidation: {
      valid: false,
      reason,
    },
  };
}

function normalizeZoneMapModelResult(result: ZoneMapModelResultValue) {
  return {
    ...result,
    zones: result.zones.map((zone) => ({
      ...zone,
      bbox: normalizeModelBoundingBox(zone.bbox),
    })),
  };
}

async function runZoneMapModel(
  input: {
    imageId: string;
    imageDataUrl: string;
  },
  deps: ZoneMapDependencies,
): Promise<ZoneMapModelResultValue> {
  const model = deps.zoneMapModel ?? createVisionModel();
  const structuredModel = model.withStructuredOutput<ZoneMapModelResultValue>(
    ZoneMapResponseSchema,
    {
      name: "ZoneMap",
    },
  );
  const loadedPrompt = deps.promptBundle.zoneMap;
  const messages = await promptMessages(loadedPrompt, {
    image_id: input.imageId,
    image_data_url: input.imageDataUrl,
  });

  return structuredModel.invoke(messages, {
    tags: ["scan", "map_zones"],
    metadata: {
      langsmithPromptName: loadedPrompt.name,
      langsmithPromptRef: loadedPrompt.ref,
      model: VISION_MODEL,
    },
  });
}

export async function mapZones(
  state: ScanStateValue,
  deps: ZoneMapDependencies,
): Promise<{
  zoneMaps: FridgeZoneMapValue[];
  zoneMapModelRawOutput: ZoneMapModelResultValue | null;
  zoneMapValidation: {
    valid: boolean;
    reason: string;
  };
}> {
  let imageDataUrls: string[];

  try {
    imageDataUrls = loadImageDataUrls(state.imageIds);
    assertImagesAreLocallyLoadable(imageDataUrls);
  } catch (error) {
    return invalidZoneMap(error instanceof Error ? error.message : String(error));
  }

  const result = await runZoneMapModel(
    {
      imageId: state.imageIds[0],
      imageDataUrl: imageDataUrls[0],
    },
    deps,
  );
  const normalizedResult = normalizeZoneMapModelResult(result);
  const parsedZoneMap = FridgeZoneMap.safeParse(normalizedResult);

  if (!parsedZoneMap.success) {
    return invalidZoneMapWithModelOutput(
      `Zone map output failed validation: ${formatModelValidationError(parsedZoneMap.error, "zoneMap")}`,
      result,
    );
  }

  if (parsedZoneMap.data.imageId !== state.imageIds[0]) {
    return invalidZoneMapWithModelOutput(
      `Zone map output failed validation: zoneMap.imageId must equal ${state.imageIds[0]}`,
      result,
    );
  }

  const zoneWithMismatchedImage = parsedZoneMap.data.zones.find(
    (zone) => zone.img !== parsedZoneMap.data.imageId,
  );

  if (zoneWithMismatchedImage) {
    return invalidZoneMapWithModelOutput(
      `Zone map output failed validation: zone ${zoneWithMismatchedImage.id} img must equal ${parsedZoneMap.data.imageId}`,
      result,
    );
  }

  return {
    zoneMaps: [parsedZoneMap.data],
    zoneMapModelRawOutput: result,
    zoneMapValidation: {
      valid: true,
      reason: "Zone map completed",
    },
  };
}
