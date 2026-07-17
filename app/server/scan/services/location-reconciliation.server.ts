import {
  type FridgeZoneDetection,
  type NormalizedBoundingBox,
  type RawDetection,
} from "../schemas/inventory";
import type {
  AmbiguousLocationRequest,
  ReconciledLocation,
  ZoneMatch,
} from "../schemas/scan-result";
import type { ScanStateValue } from "../state";

export const MIN_ZONE_MATCH_SCORE = 0.45;
export const MIN_ZONE_MATCH_MARGIN = 0.12;

export function area(box: NormalizedBoundingBox) {
  return box.width * box.height;
}

export function intersectionArea(
  a: NormalizedBoundingBox,
  b: NormalizedBoundingBox,
) {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);

  if (right <= left || bottom <= top) {
    return 0;
  }

  return (right - left) * (bottom - top);
}

export function itemContainmentRatio(
  item: NormalizedBoundingBox,
  zone: NormalizedBoundingBox,
) {
  const itemArea = area(item);

  if (itemArea === 0) {
    return 0;
  }

  return Math.min(1, intersectionArea(item, zone) / itemArea);
}

export function isItemCenterInsideZone(
  item: NormalizedBoundingBox,
  zone: NormalizedBoundingBox,
) {
  const centerX = item.x + item.width / 2;
  const centerY = item.y + item.height / 2;

  return (
    centerX >= zone.x &&
    centerX <= zone.x + zone.width &&
    centerY >= zone.y &&
    centerY <= zone.y + zone.height
  );
}

export function scoreZoneMatch(
  detection: RawDetection,
  zone: FridgeZoneDetection,
): ZoneMatch {
  const containmentRatio = itemContainmentRatio(
    detection.bbox,
    zone.bbox,
  );
  const centerContained = isItemCenterInsideZone(
    detection.bbox,
    zone.bbox,
  );
  let score = containmentRatio * 0.7;

  if (centerContained) {
    score += 0.25;
  }

  score += zone.conf * 0.05;

  return {
    detectionId: detection.id,
    zoneDetectionId: zone.id,
    score,
    containmentRatio,
    centerContained,
  };
}

export function resolveDetectionZone(
  detection: RawDetection,
  zones: FridgeZoneDetection[],
): ReconciledLocation {
  const candidateZones = zones.filter((zone) => zone.img === detection.img);
  const matches = candidateZones
    .map((zone) => scoreZoneMatch(detection, zone))
    .sort((a, b) => b.score - a.score);
  const best = matches[0];
  const second = matches[1];

  if (!best) {
    return {
      status: "unmatched",
      detectionId: detection.id,
      reason: "No same-image zone candidates were available",
    };
  }

  if (best.score < MIN_ZONE_MATCH_SCORE) {
    return {
      status: "ambiguous",
      detectionId: detection.id,
      candidates: matches.slice(0, 2),
      reason: "No zone candidate cleared the geometry score threshold",
    };
  }

  if (second && best.score - second.score < MIN_ZONE_MATCH_MARGIN) {
    return {
      status: "ambiguous",
      detectionId: detection.id,
      candidates: matches.slice(0, 2),
      reason: "The best zone candidate was too close to the next candidate",
    };
  }

  const zone = candidateZones.find(
    (candidate) => candidate.id === best.zoneDetectionId,
  );

  if (!zone) {
    return {
      status: "unmatched",
      detectionId: detection.id,
      reason: `Matched zone ${best.zoneDetectionId} was not present in zone map`,
    };
  }

  return {
    status: "matched",
    detectionId: detection.id,
    zone,
    score: best.score,
    match: best,
  };
}

function buildAmbiguousLocationRequest(
  detection: RawDetection,
  location: Extract<ReconciledLocation, { status: "ambiguous" }>,
  zones: FridgeZoneDetection[],
): AmbiguousLocationRequest | string {
  const candidateZones = [];

  for (const candidate of location.candidates) {
    const zone = zones.find(
      (zoneCandidate) =>
        zoneCandidate.id === candidate.zoneDetectionId,
    );

    if (!zone) {
      return `Ambiguous candidate ${candidate.zoneDetectionId} was not present in zone map`;
    }

    candidateZones.push({
      zoneDetectionId: zone.id,
      type: zone.type,
      boundingBox: zone.bbox,
    });
  }

  return {
    imageId: detection.img,
    detectionId: detection.id,
    detectionBox: detection.bbox,
    candidateZones,
    reason: location.reason,
  };
}

export async function reconcileLocations(state: ScanStateValue): Promise<{
  reconciledLocations: ReconciledLocation[];
  ambiguousLocationRequests: AmbiguousLocationRequest[];
  reconciliationValidation: {
    valid: boolean;
    reason: string;
  };
}> {
  if (!state.detectionValidation?.valid) {
    return {
      reconciledLocations: [],
      ambiguousLocationRequests: [],
      reconciliationValidation: {
        valid: false,
        reason:
          state.detectionValidation?.reason ?? "Inventory detection is invalid",
      },
    };
  }

  if (!state.zoneMapValidation?.valid) {
    return {
      reconciledLocations: [],
      ambiguousLocationRequests: [],
      reconciliationValidation: {
        valid: false,
        reason: state.zoneMapValidation?.reason ?? "Zone map is invalid",
      },
    };
  }

  const zones = state.zoneMaps.flatMap((zoneMap) => zoneMap.zones);
  const reconciledLocations = state.rawDetections.map((detection) =>
    resolveDetectionZone(detection, zones),
  );
  const ambiguousLocationRequests: AmbiguousLocationRequest[] = [];

  for (const location of reconciledLocations
    .filter(
      (
        location,
      ): location is Extract<ReconciledLocation, { status: "ambiguous" }> =>
        location.status === "ambiguous",
    )) {
    const detection = state.rawDetections.find(
      (candidate) => candidate.id === location.detectionId,
    );

    if (!detection) {
      return {
        reconciledLocations,
        ambiguousLocationRequests: [],
        reconciliationValidation: {
          valid: false,
          reason: `Ambiguous detection ${location.detectionId} was not present in raw detections`,
        },
      };
    }

    const request = buildAmbiguousLocationRequest(detection, location, zones);

    if (typeof request === "string") {
      return {
        reconciledLocations,
        ambiguousLocationRequests: [],
        reconciliationValidation: {
          valid: false,
          reason: request,
        },
      };
    }

    ambiguousLocationRequests.push(request);
  }

  return {
    reconciledLocations,
    ambiguousLocationRequests,
    reconciliationValidation: {
      valid: true,
      reason: "Location reconciliation completed",
    },
  };
}
