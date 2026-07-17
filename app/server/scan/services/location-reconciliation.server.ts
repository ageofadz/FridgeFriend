import {
  type FridgeZoneDetection,
  type NormalizedBoundingBox,
  type RawDetection,
  type ZoneType,
} from "../schemas/inventory";
import type {
  AmbiguousLocationRequest,
  ReconciledLocation,
  ZoneMatch,
} from "../schemas/scan-result";
import type { ScanStateValue } from "../state";

const STORAGE_SUPPORT_ZONE_TYPES = new Set<ZoneType>([
  "shelf",
  "door_shelf",
  "drawer",
  "freezer",
  "pantry",
]);

function isStorageSupportZone(zone: FridgeZoneDetection) {
  return STORAGE_SUPPORT_ZONE_TYPES.has(zone.type);
}

function intervalOverlap(
  leftStart: number,
  leftEnd: number,
  rightStart: number,
  rightEnd: number,
) {
  return Math.min(leftEnd, rightEnd) - Math.max(leftStart, rightStart);
}

function horizontalOverlapRatio(
  item: NormalizedBoundingBox,
  zone: NormalizedBoundingBox,
) {
  const overlap = Math.max(0, intervalOverlap(
    item.x,
    item.x + item.width,
    zone.x,
    zone.x + zone.width,
  ));
  const denominator = Math.min(item.width, zone.width);

  if (denominator <= 0) {
    return 0;
  }

  return Math.min(1, overlap / denominator);
}

function verticalOverlapRatio(
  item: NormalizedBoundingBox,
  zone: NormalizedBoundingBox,
) {
  const overlap = Math.max(0, intervalOverlap(
    item.y,
    item.y + item.height,
    zone.y,
    zone.y + zone.height,
  ));
  const denominator = Math.min(item.height, zone.height);

  if (denominator <= 0) {
    return 0;
  }

  return Math.min(1, overlap / denominator);
}

function boxContainsPoint(
  box: NormalizedBoundingBox,
  point: { x: number; y: number },
) {
  return (
    point.x >= box.x &&
    point.x <= box.x + box.width &&
    point.y >= box.y &&
    point.y <= box.y + box.height
  );
}

function itemBottomY(detection: RawDetection) {
  return detection.bbox.y + detection.bbox.height;
}

function zoneSurfaceY(zone: FridgeZoneDetection) {
  return zone.bbox.y + zone.bbox.height;
}

function matchZoneSurface(
  detection: RawDetection,
  zone: FridgeZoneDetection,
): ZoneMatch {
  const surfaceDistance = Math.abs(itemBottomY(detection) - zoneSurfaceY(zone));
  const overlapRatio = horizontalOverlapRatio(
    detection.bbox,
    zone.bbox,
  );

  return {
    detectionId: detection.id,
    zoneDetectionId: zone.id,
    score: Math.max(0, 1 - surfaceDistance),
    surfaceDistance,
    horizontalOverlapRatio: overlapRatio,
  };
}

export function resolveDetectionZone(
  detection: RawDetection,
  zones: FridgeZoneDetection[],
): ReconciledLocation {
  const supportZones = zones
    .filter((zone) => zone.img === detection.img)
    .filter(isStorageSupportZone);
  const detectionCenter = {
    x: detection.bbox.x + detection.bbox.width / 2,
    y: detection.bbox.y + detection.bbox.height / 2,
  };
  const matches = supportZones
    .map((zone) => ({
      zone,
      match: matchZoneSurface(detection, zone),
      verticalOverlapRatio: verticalOverlapRatio(detection.bbox, zone.bbox),
      containsCenter: boxContainsPoint(zone.bbox, detectionCenter),
    }))
    .filter(({ match, verticalOverlapRatio }) =>
      match.horizontalOverlapRatio > 0 && verticalOverlapRatio > 0
    )
    .sort((left, right) =>
      Number(right.containsCenter) - Number(left.containsCenter) ||
      right.verticalOverlapRatio - left.verticalOverlapRatio ||
      right.match.horizontalOverlapRatio - left.match.horizontalOverlapRatio ||
      left.match.surfaceDistance - right.match.surfaceDistance ||
      right.zone.conf - left.zone.conf ||
      left.zone.id.localeCompare(right.zone.id)
    );
  const best = matches[0];

  if (!best) {
    if (supportZones.length > 0) {
      return {
        status: "needs_review",
        detectionId: detection.id,
        reason: `No same-image storage support surface contains detection ${detection.id}`,
      };
    }

    return {
      status: "unmatched",
      detectionId: detection.id,
      reason: `No same-image storage support surfaces were available for image ${detection.img}`,
    };
  }

  return {
    status: "matched",
    detectionId: detection.id,
    zone: best.zone,
    score: best.match.score,
    match: best.match,
  };
}

function inheritedStackLocation(
  detection: RawDetection,
  supportLocation: ReconciledLocation,
): ReconciledLocation {
  if (supportLocation.status !== "matched") {
    return {
      status: "unmatched",
      detectionId: detection.id,
      reason: `Cannot place stacked detection ${detection.id} because support detection ${supportLocation.detectionId} was not matched`,
    };
  }

  return {
    status: "matched",
    detectionId: detection.id,
    zone: supportLocation.zone,
    score: supportLocation.score,
    match: {
      ...supportLocation.match,
      detectionId: detection.id,
    },
  };
}

function resolveDetectionLocations(
  detections: RawDetection[],
  zones: FridgeZoneDetection[],
) {
  const detectionsById = new Map(detections.map((detection) => [
    detection.id,
    detection,
  ]));
  const resolvedLocations = new Map<string, ReconciledLocation>();
  const resolving = new Set<string>();

  function resolve(detection: RawDetection): ReconciledLocation {
    const existing = resolvedLocations.get(detection.id);

    if (existing) {
      return existing;
    }

    if (resolving.has(detection.id)) {
      return {
        status: "unmatched",
        detectionId: detection.id,
        reason: `Cannot place detection ${detection.id} because stack references form a cycle`,
      };
    }

    resolving.add(detection.id);

    try {
      if (detection.stack?.on) {
        const supportDetection = detectionsById.get(detection.stack.on);

        if (!supportDetection) {
          return {
            status: "unmatched",
            detectionId: detection.id,
            reason: `Cannot place stacked detection ${detection.id} because support detection ${detection.stack.on} was not found`,
          };
        }

        if (supportDetection.img !== detection.img) {
          return {
            status: "unmatched",
            detectionId: detection.id,
            reason: `Cannot place stacked detection ${detection.id} because support detection ${supportDetection.id} is in image ${supportDetection.img}`,
          };
        }

        return inheritedStackLocation(detection, resolve(supportDetection));
      }

      return resolveDetectionZone(detection, zones);
    } finally {
      resolving.delete(detection.id);
    }
  }

  return detections.map((detection) => {
    const location = resolve(detection);
    resolvedLocations.set(detection.id, location);
    return location;
  });
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
  const reconciledLocations = resolveDetectionLocations(
    state.rawDetections,
    zones,
  );
  const ambiguousLocationRequests: AmbiguousLocationRequest[] = [];
  const unmatchedLocation = reconciledLocations.find(
    (location) => location.status === "unmatched",
  );

  if (unmatchedLocation) {
    return {
      reconciledLocations,
      ambiguousLocationRequests,
      reconciliationValidation: {
        valid: false,
        reason: unmatchedLocation.reason,
      },
    };
  }

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
