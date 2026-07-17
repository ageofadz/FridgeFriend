import type {
  FridgeZoneDetection,
  GroundedPlacementValue,
  RawDetection,
} from "../schemas/inventory";
import type { ScanStateValue } from "../state";

type PlacementCandidate = {
  kind: "zone";
  id: string;
  supportY: number;
  horizontalOverlapRatio: number;
  verticalOverlapRatio: number;
  verticalDistance: number;
  containsCenter: boolean;
  centerDistance: number;
  confidence: number;
};

export type ItemPlacementGroundingDependencies = Record<string, never>;

const SUPPORT_ZONE_TYPES = new Set([
  "shelf",
  "door_shelf",
  "drawer",
  "freezer",
  "pantry",
]);

function overlap(left: number, right: number, otherLeft: number, otherRight: number) {
  return Math.min(right, otherRight) - Math.max(left, otherLeft);
}

function horizontalOverlapRatio(
  detection: RawDetection,
  support: Pick<FridgeZoneDetection | RawDetection, "bbox">,
) {
  if (detection.bbox.width <= 0) return 0;

  return Math.max(0, overlap(
    detection.bbox.x,
    detection.bbox.x + detection.bbox.width,
    support.bbox.x,
    support.bbox.x + support.bbox.width,
  )) / detection.bbox.width;
}

function surfaceY(zone: FridgeZoneDetection) {
  return zone.surfaceY ?? zone.bbox.y + zone.bbox.height;
}

function verticalOverlapRatio(
  detection: RawDetection,
  support: Pick<FridgeZoneDetection, "bbox">,
) {
  if (detection.bbox.height <= 0) return 0;

  return Math.max(0, overlap(
    detection.bbox.y,
    detection.bbox.y + detection.bbox.height,
    support.bbox.y,
    support.bbox.y + support.bbox.height,
  )) / detection.bbox.height;
}

function boxContainsPoint(
  box: FridgeZoneDetection["bbox"],
  point: { x: number; y: number },
) {
  return (
    point.x >= box.x &&
    point.x <= box.x + box.width &&
    point.y >= box.y &&
    point.y <= box.y + box.height
  );
}

function zoneCandidates(
  detection: RawDetection,
  zones: FridgeZoneDetection[],
) {
  const itemBottom = detection.bbox.y + detection.bbox.height;
  const detectionCenter = {
    x: detection.bbox.x + detection.bbox.width / 2,
    y: detection.bbox.y + detection.bbox.height / 2,
  };

  return zones.flatMap((zone): PlacementCandidate[] => {
    if (
      zone.img !== detection.img ||
      !SUPPORT_ZONE_TYPES.has(zone.type)
    ) {
      return [];
    }

    const supportY = surfaceY(zone);
    const zoneCenter = {
      x: zone.bbox.x + zone.bbox.width / 2,
      y: zone.bbox.y + zone.bbox.height / 2,
    };

    return [{
      kind: "zone",
      id: zone.id,
      supportY,
      horizontalOverlapRatio: horizontalOverlapRatio(detection, zone),
      verticalOverlapRatio: verticalOverlapRatio(detection, zone),
      verticalDistance: Math.abs(itemBottom - supportY),
      containsCenter: boxContainsPoint(zone.bbox, detectionCenter),
      centerDistance: Math.hypot(
        detectionCenter.x - zoneCenter.x,
        detectionCenter.y - zoneCenter.y,
      ),
      confidence: zone.conf,
    }];
  });
}

function candidatesFor(
  detection: RawDetection,
  zones: FridgeZoneDetection[],
) {
  return zoneCandidates(detection, zones);
}

function review(detectionId: string, reason: string): GroundedPlacementValue {
  return { detectionId, status: "needs_review", reason, confidence: 0 };
}

function depthForDetection(detection: RawDetection) {
  const centerX = detection.bbox.x + detection.bbox.width / 2;
  const visibleWidth = Math.max(0.18, Math.min(0.9, detection.bbox.width * 1.4));
  const back = Math.max(0, Math.min(0.82, centerX - visibleWidth / 2));
  const front = Math.min(1, Math.max(back + 0.08, centerX + visibleWidth / 2));

  return {
    back,
    front,
  };
}

function confidenceForCandidate(candidate: PlacementCandidate) {
  const verticalScore = Math.max(0, 1 - candidate.verticalDistance / 0.08);
  const overlapScore = Math.min(1, candidate.horizontalOverlapRatio);
  const bboxScore = Math.max(
    candidate.verticalOverlapRatio,
    candidate.containsCenter ? 1 : 0,
  );

  return Math.max(
    0.35,
    Math.min(0.98, 0.35 * verticalScore + 0.3 * overlapScore + 0.25 * bboxScore + 0.1 * candidate.confidence),
  );
}

function rankCandidate(left: PlacementCandidate, right: PlacementCandidate) {
  const centerDifference = Number(right.containsCenter) - Number(left.containsCenter);

  if (centerDifference !== 0) {
    return centerDifference;
  }

  if (left.verticalOverlapRatio !== right.verticalOverlapRatio) {
    return right.verticalOverlapRatio - left.verticalOverlapRatio;
  }

  if (left.horizontalOverlapRatio !== right.horizontalOverlapRatio) {
    return right.horizontalOverlapRatio - left.horizontalOverlapRatio;
  }

  if (left.centerDistance !== right.centerDistance) {
    return left.centerDistance - right.centerDistance;
  }

  if (left.verticalDistance !== right.verticalDistance) {
    return left.verticalDistance - right.verticalDistance;
  }

  if (left.confidence !== right.confidence) {
    return right.confidence - left.confidence;
  }

  return left.id.localeCompare(right.id);
}

function placementForDetection(
  detection: RawDetection,
  candidates: PlacementCandidate[],
): GroundedPlacementValue {
  if (candidates.length === 0) {
    return review(detection.id, `No mapped storage zone is available for image ${detection.img}`);
  }

  const [candidate] = [...candidates].sort(rankCandidate);

  return {
    detectionId: detection.id,
    status: "placed",
    supportKind: candidate.kind,
    supportId: candidate.id,
    depth: depthForDetection(detection),
    confidence: confidenceForCandidate(candidate),
  };
}

function resolvePlacements(
  detections: RawDetection[],
  candidatesByDetectionId: Map<string, PlacementCandidate[]>,
) {
  const placementsByDetectionId = new Map<string, GroundedPlacementValue>();
  const orderedDetections = [...detections].sort((left, right) =>
    (right.bbox.y + right.bbox.height) - (left.bbox.y + left.bbox.height)
  );

  for (const detection of orderedDetections) {
    const candidates = candidatesByDetectionId.get(detection.id) ?? [];
    const placement = placementForDetection(
      detection,
      candidates,
    );

    placementsByDetectionId.set(detection.id, placement);
  }

  return detections.map((detection) => placementsByDetectionId.get(detection.id)!);
}

function validatePlacements(
  detections: RawDetection[],
  candidatesByDetectionId: Map<string, PlacementCandidate[]>,
  placements: GroundedPlacementValue[],
) {
  if (placements.length !== detections.length) {
    return `Placement grounding failed validation: expected ${detections.length} placements but received ${placements.length}`;
  }

  const byDetectionId = new Map(placements.map((placement) => [placement.detectionId, placement]));

  if (byDetectionId.size !== placements.length) {
    return "Placement grounding failed validation: duplicate detectionId";
  }

  for (const detection of detections) {
    const placement = byDetectionId.get(detection.id);

    if (!placement) {
      return `Placement grounding failed validation: missing placement for ${detection.id}`;
    }

    if (placement.status === "needs_review") {
      continue;
    }

    if (!candidatesByDetectionId.get(detection.id)?.some((candidate) =>
      candidate.kind === placement.supportKind && candidate.id === placement.supportId
    )) {
      return `Placement grounding failed validation: ${placement.detectionId} selected unsupported ${placement.supportKind} ${placement.supportId}`;
    }
  }

  return null;
}

function validPlacementGrounding(reason: string) {
  return {
    placementValidation: {
      valid: true,
      reason,
    },
  };
}

export async function groundItemPlacements(
  state: ScanStateValue,
  _deps: ItemPlacementGroundingDependencies,
) {
  const zones = state.zoneMaps.flatMap((zoneMap) => zoneMap.zones);
  const candidatesByDetectionId = new Map(state.rawDetections.map((detection) => [
    detection.id,
    candidatesFor(detection, zones),
  ]));
  const placements = resolvePlacements(state.rawDetections, candidatesByDetectionId);
  const validationError = validatePlacements(
    state.rawDetections,
    candidatesByDetectionId,
    placements,
  );

  if (validationError) {
    return {
      groundedPlacements: placements,
      ...validPlacementGrounding(validationError),
    };
  }

  return {
    groundedPlacements: placements,
    placementValidation: {
      valid: true,
      reason: "Item placement grounding completed",
    },
  };
}
