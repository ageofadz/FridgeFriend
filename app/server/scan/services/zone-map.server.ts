import type { FridgeFriendChatModel } from "../../ai/chat-model.server";
import { HumanMessage } from "@langchain/core/messages";
import {
  CHAT_VISION_PROVIDER as CHAT_PROVIDER,
  CHAT_VISION_MODEL as VISION_MODEL,
} from "../../ai/chat-model.server";
import type { PromptBundle } from "../../prompts/registry.server";
import {
  FridgeZoneMap,
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
  zoneMapModel?: FridgeFriendChatModel;
  loadImageDataUrls?: (imageIds: string[]) => string[];
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
      ...(zone.surfaceY === undefined
        ? {}
        : { surfaceY: zone.surfaceY > 1 ? zone.surfaceY / 1000 : zone.surfaceY }),
    })),
  };
}

function validateZoneMapResult(
  result: ZoneMapModelResultValue,
  imageId: string,
) {
  const normalizedResult = normalizeZoneMapModelResult(result);
  const parsedZoneMap = FridgeZoneMap.safeParse(normalizedResult);

  if (!parsedZoneMap.success) {
    return {
      valid: false as const,
      reason: `Zone map output failed validation: ${formatModelValidationError(parsedZoneMap.error, "zoneMap")}`,
    };
  }

  if (parsedZoneMap.data.imageId !== imageId) {
    return {
      valid: false as const,
      reason: `Zone map output failed validation: zoneMap.imageId must equal ${imageId}`,
    };
  }

  const zoneWithMismatchedImage = parsedZoneMap.data.zones.find(
    (zone) => zone.img !== parsedZoneMap.data.imageId,
  );

  if (zoneWithMismatchedImage) {
    return {
      valid: false as const,
      reason: `Zone map output failed validation: zone ${zoneWithMismatchedImage.id} img must equal ${parsedZoneMap.data.imageId}`,
    };
  }

  const zoneWithoutSurface = parsedZoneMap.data.zones.find(
    (zone) => zone.surfaceY === undefined ||
      zone.surfaceY < zone.bbox.y ||
      zone.surfaceY > zone.bbox.y + zone.bbox.height,
  );

  if (zoneWithoutSurface) {
    return {
      valid: false as const,
      reason: `Zone map output failed validation: zone ${zoneWithoutSurface.id} must provide surfaceY within its support bbox`,
    };
  }

  return {
    valid: true as const,
    zoneMap: parsedZoneMap.data,
  };
}

async function runZoneMapModel(
  input: {
    imageId: string;
    imageDataUrl: string;
  },
  deps: ZoneMapDependencies,
  correctionReason?: string,
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

  if (correctionReason) {
    messages.push(new HumanMessage(
      `Correct the zone map you just produced for this same image. ${correctionReason} Return a complete replacement map. Keep every bbox in one normalized 0-to-1 coordinate system, map support areas rather than shelf lines, and ensure every support area has usable horizontal width.`,
    ));
  }

  return structuredModel.invoke(messages, {
    tags: ["scan", "map_zones"],
    metadata: {
      langsmithPromptName: loadedPrompt.name,
      langsmithPromptRef: loadedPrompt.ref,
      provider: CHAT_PROVIDER,
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
    imageDataUrls = (deps.loadImageDataUrls ?? loadImageDataUrls)(state.imageIds);
    assertImagesAreLocallyLoadable(imageDataUrls);
  } catch (error) {
    return invalidZoneMap(error instanceof Error ? error.message : String(error));
  }

  let result = await runZoneMapModel(
    {
      imageId: state.imageIds[0],
      imageDataUrl: imageDataUrls[0],
    },
    deps,
  );
  let validation = validateZoneMapResult(result, state.imageIds[0]);

  for (let attempt = 0; !validation.valid && attempt < 2; attempt += 1) {
    result = await runZoneMapModel(
      {
        imageId: state.imageIds[0],
        imageDataUrl: imageDataUrls[0],
      },
      deps,
      validation.reason,
    );
    validation = validateZoneMapResult(result, state.imageIds[0]);
  }

  if (!validation.valid) {
    return invalidZoneMapWithModelOutput(
      validation.reason,
      result,
    );
  }

  return {
    zoneMaps: [validation.zoneMap],
    zoneMapModelRawOutput: result,
    zoneMapValidation: {
      valid: true,
      reason: "Zone map completed",
    },
  };
}
