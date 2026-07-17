import { ChatGoogleGenerativeAI } from "@langchain/google-genai";

import type { PromptBundle } from "../../prompts/registry.server";
import { VISION_MODEL } from "../schemas/inventory";
import {
  LocationAdjudicationModelResult,
  LocationAdjudicationResponseSchema,
  type LocationAdjudicationDecision,
  type LocationAdjudicationModelResult as LocationAdjudicationModelResultValue,
} from "../schemas/scan-result";
import type { ScanStateValue } from "../state";
import {
  assertImagesAreLocallyLoadable,
  loadImageDataUrls,
} from "./image-data.server";
import { formatModelValidationError } from "./model-output.server";
import { promptMessages } from "./prompt-messages.server";
import { createVisionModel } from "./vision-model.server";

export type LocationAdjudicationDependencies = {
  promptBundle: Pick<PromptBundle, "locationAdjudication">;
  adjudicationModel?: ChatGoogleGenerativeAI;
};

function invalidAdjudication(reason: string) {
  return {
    adjudicationDecisions: [],
    adjudicationValidation: {
      valid: false,
      reason,
    },
  };
}

async function runLocationAdjudicationModel(
  input: {
    imageId: string;
    imageDataUrl: string;
    adjudicationInputJson: string;
  },
  deps: LocationAdjudicationDependencies,
): Promise<LocationAdjudicationModelResultValue> {
  const model = deps.adjudicationModel ?? createVisionModel();
  const structuredModel =
    model.withStructuredOutput<LocationAdjudicationModelResultValue>(
      LocationAdjudicationResponseSchema,
      {
        name: "LocationAdjudication",
      },
    );
  const loadedPrompt = deps.promptBundle.locationAdjudication;
  const messages = await promptMessages(loadedPrompt, {
    image_id: input.imageId,
    image_data_url: input.imageDataUrl,
    adjudication_input_json: input.adjudicationInputJson,
  });

  return structuredModel.invoke(messages, {
    tags: ["scan", "adjudicate_locations"],
    metadata: {
      langsmithPromptName: loadedPrompt.name,
      langsmithPromptRef: loadedPrompt.ref,
      model: VISION_MODEL,
    },
  });
}

function validateAdjudicationDecisions(
  state: ScanStateValue,
  decisions: LocationAdjudicationDecision[],
) {
  const decisionsByDetectionId = new Map(
    decisions.map((decision) => [decision.detectionId, decision]),
  );

  for (const request of state.ambiguousLocationRequests) {
    const decision = decisionsByDetectionId.get(request.detectionId);

    if (!decision) {
      return `Location adjudication output failed validation: missing decision for ${request.detectionId}`;
    }

    if (
      decision.selectedZoneDetectionId !== null &&
      !request.candidateZones.some(
        (zone) => zone.zoneDetectionId === decision.selectedZoneDetectionId,
      )
    ) {
      return `Location adjudication output failed validation: selectedZoneDetectionId ${decision.selectedZoneDetectionId} is not a candidate for ${request.detectionId}`;
    }
  }

  for (const decision of decisions) {
    const request = state.ambiguousLocationRequests.find(
      (candidate) => candidate.detectionId === decision.detectionId,
    );

    if (!request) {
      return `Location adjudication output failed validation: unexpected decision for ${decision.detectionId}`;
    }
  }

  return null;
}

export async function adjudicateLocations(
  state: ScanStateValue,
  deps: LocationAdjudicationDependencies,
): Promise<{
  adjudicationDecisions: LocationAdjudicationDecision[];
  adjudicationValidation: {
    valid: boolean;
    reason: string;
  };
}> {
  if (state.ambiguousLocationRequests.length === 0) {
    return {
      adjudicationDecisions: [],
      adjudicationValidation: {
        valid: true,
        reason: "No ambiguous locations to adjudicate",
      },
    };
  }

  let imageDataUrls: string[];

  try {
    imageDataUrls = loadImageDataUrls(state.imageIds);
    assertImagesAreLocallyLoadable(imageDataUrls);
  } catch (error) {
    return invalidAdjudication(
      error instanceof Error ? error.message : String(error),
    );
  }

  const imageDataUrlById = new Map(
    state.imageIds.map((imageId, index) => [imageId, imageDataUrls[index]]),
  );
  const groupedRequests = new Map<
    string,
    typeof state.ambiguousLocationRequests
  >();

  for (const request of state.ambiguousLocationRequests) {
    groupedRequests.set(request.imageId, [
      ...(groupedRequests.get(request.imageId) ?? []),
      request,
    ]);
  }
  const decisions: LocationAdjudicationDecision[] = [];

  for (const [imageId, requests] of groupedRequests) {
    const imageDataUrl = imageDataUrlById.get(imageId);

    if (!imageDataUrl) {
      return invalidAdjudication(
        `Location adjudication failed: missing image data for ${imageId}`,
      );
    }

    const result = await runLocationAdjudicationModel(
      {
        imageId,
        imageDataUrl,
        adjudicationInputJson: JSON.stringify({ requests }),
      },
      deps,
    );
    const parsedResult = LocationAdjudicationModelResult.safeParse(result);

    if (!parsedResult.success) {
      return invalidAdjudication(
        `Location adjudication output failed validation: ${formatModelValidationError(parsedResult.error, "adjudication")}`,
      );
    }

    decisions.push(...parsedResult.data.decisions);
  }

  const validationError = validateAdjudicationDecisions(state, decisions);

  if (validationError) {
    return invalidAdjudication(validationError);
  }

  return {
    adjudicationDecisions: decisions,
    adjudicationValidation: {
      valid: true,
      reason: "Location adjudication completed",
    },
  };
}
