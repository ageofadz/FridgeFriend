import {
  VISION_MODEL,
  type FridgeZoneDetection,
  type Inventory,
  type InventoryItem,
  type RawDetection,
} from "../schemas/inventory";
import { categorizeInventoryForRecipes } from "../../recipes/inventory-generalization";
import type {
  LocationAdjudicationDecision,
  ReconciledLocation,
} from "../schemas/scan-result";
import type { ScanStateValue } from "../state";

function clampRatio(value: number) {
  return Math.min(1, Math.max(0, value));
}

function canonicalItemName(label: string) {
  return label.trim().toLowerCase();
}

function isUnidentifiedInventoryLabel(label: string) {
  const canonicalName = canonicalItemName(label);

  return (
    canonicalName === "unknown" ||
    canonicalName.startsWith("unknown ") ||
    canonicalName === "unidentified" ||
    canonicalName.startsWith("unidentified ") ||
    canonicalName.startsWith("unclear ") ||
    canonicalName.startsWith("obscured ")
  );
}

function zoneVerticalLabel(
  zone: FridgeZoneDetection,
  zones: FridgeZoneDetection[],
) {
  const centerY = zone.bbox.y + zone.bbox.height / 2;

  if (zone.type === "drawer" || zone.type === "freezer" || zone.type === "pantry") {
    if (centerY < 0.33) {
      return "top";
    }

    if (centerY > 0.67) {
      return "bottom";
    }

    return "middle";
  }

  const sameTypeZones = zones
    .filter((candidate) => candidate.type === zone.type)
    .sort((a, b) => a.bbox.y - b.bbox.y);
  const index = sameTypeZones.findIndex(
    (candidate) => candidate.id === zone.id,
  );

  if (sameTypeZones.length <= 1 || index === -1) {
    if (centerY < 0.33) {
      return "top";
    }

    if (centerY > 0.67) {
      return "bottom";
    }

    return "middle";
  }

  if (index === 0) {
    return "top";
  }

  if (index === sameTypeZones.length - 1) {
    return "bottom";
  }

  return "middle";
}

function zoneHorizontalLabel(zone: FridgeZoneDetection) {
  const centerX = zone.bbox.x + zone.bbox.width / 2;

  if (centerX < 0.38) {
    return "left";
  }

  if (centerX > 0.62) {
    return "right";
  }

  return "center";
}

function zoneTypeLabel(type: FridgeZoneDetection["type"]) {
  if (type === "door_shelf") {
    return "door shelf";
  }

  if (type === "freezer") {
    return "freezer";
  }

  if (type === "pantry") {
    return "pantry";
  }

  if (type === "drawer") {
    return "drawer";
  }

  if (type === "shelf") {
    return "shelf";
  }

  return "zone";
}

function humanReadableZoneLabel(
  zone: FridgeZoneDetection,
  zones: FridgeZoneDetection[],
) {
  const vertical = zoneVerticalLabel(zone, zones);
  const type = zoneTypeLabel(zone.type);

  if (zone.type === "drawer") {
    return `${vertical} ${zoneHorizontalLabel(zone)} ${type}`;
  }

  if (zone.type === "door_shelf") {
    return `${vertical} ${type}`;
  }

  return `${vertical} ${type}`;
}

function depthBackRatioForBoxInZone(
  itemBox: RawDetection["bbox"] | InventoryItem["loc"]["observations"][number]["boundingBox"],
  zoneBox: FridgeZoneDetection["bbox"],
) {
  return clampRatio((itemBox.y + itemBox.height - zoneBox.y) / zoneBox.height);
}

function itemZoneXInterval(
  itemBox: InventoryItem["loc"]["observations"][number]["boundingBox"],
  zoneBox: FridgeZoneDetection["bbox"],
) {
  const left = clampRatio((itemBox.x - zoneBox.x) / zoneBox.width);
  const right = clampRatio((itemBox.x + itemBox.width - zoneBox.x) / zoneBox.width);

  return right > left ? { left, right } : null;
}

function itemZoneDepthInterval(
  observation: InventoryItem["loc"]["observations"][number],
  zoneBox: FridgeZoneDetection["bbox"],
) {
  if (observation.depthBackRatio === null) {
    return null;
  }

  const depthSpan = clampRatio(observation.boundingBox.height / zoneBox.height);
  const back = observation.depthBackRatio;
  const front = clampRatio(back - depthSpan);

  return back > front ? { front, back } : null;
}

function estimateZoneOccupiedRatio(
  zone: FridgeZoneDetection,
  items: InventoryItem[],
) {
  const gridSize = 20;
  const matchedItems = items.filter((item) =>
    item.loc.status === "matched" && item.loc.zoneId === zone.id
  );
  const occupiedCells = new Set<string>();

  for (const item of matchedItems) {
    const observation = item.loc.observations.find((candidate) =>
      candidate.imageId === zone.img
    ) ?? item.loc.observations[0];

    if (!observation) {
      continue;
    }

    const xInterval = itemZoneXInterval(observation.boundingBox, zone.bbox);
    const depthInterval = itemZoneDepthInterval(observation, zone.bbox);

    if (!xInterval || !depthInterval) {
      continue;
    }

    for (let x = 0; x < gridSize; x += 1) {
      const xCenter = (x + 0.5) / gridSize;

      if (xCenter < xInterval.left || xCenter > xInterval.right) {
        continue;
      }

      for (let depth = 0; depth < gridSize; depth += 1) {
        const depthCenter = (depth + 0.5) / gridSize;

        if (depthCenter >= depthInterval.front && depthCenter <= depthInterval.back) {
          occupiedCells.add(`${x}:${depth}`);
        }
      }
    }
  }

  return occupiedCells.size > 0
    ? occupiedCells.size / (gridSize * gridSize)
    : null;
}

function createInventoryZones(
  zoneMaps: ScanStateValue["zoneMaps"],
  items: InventoryItem[],
) {
  return zoneMaps.flatMap((zoneMap) =>
    zoneMap.zones.map((zone) => ({
      id: zone.id,
      type: zone.type,
      label: humanReadableZoneLabel(zone, zoneMap.zones),
      order: zone.ord,
      boundingBox: zone.bbox,
      imageIds: [zone.img],
      sourceZoneDetectionIds: [zone.id],
      confidence: zone.conf,
      estimatedCapacityRatio: null,
      estimatedOccupiedRatio: estimateZoneOccupiedRatio(zone, items),
    })),
  );
}

function findDetectionLocation(
  detection: RawDetection,
  reconciledLocations: ReconciledLocation[],
) {
  return reconciledLocations.find(
    (location) => location.detectionId === detection.id,
  );
}

function findAdjudicationDecision(
  detection: RawDetection,
  adjudicationDecisions: LocationAdjudicationDecision[],
) {
  return adjudicationDecisions.find(
    (decision) => decision.detectionId === detection.id,
  );
}

function findZone(
  zoneDetectionId: string,
  zones: FridgeZoneDetection[],
) {
  return zones.find((zone) => zone.id === zoneDetectionId);
}

function createLocation(
  detection: RawDetection,
  reconciledLocations: ReconciledLocation[],
  adjudicationDecisions: LocationAdjudicationDecision[],
  zones: FridgeZoneDetection[],
): InventoryItem["loc"] {
  const observationForZone = (zone: FridgeZoneDetection | null) => ({
    imageId: detection.img,
    depthBackRatio: zone
      ? depthBackRatioForBoxInZone(detection.bbox, zone.bbox)
      : null,
    boundingBox: {
      x: detection.bbox.x,
      y: detection.bbox.y,
      width: detection.bbox.width,
      height: detection.bbox.height,
    },
  });
  const location = findDetectionLocation(detection, reconciledLocations);

  if (!location) {
    return {
      status: "unmatched",
      zoneId: null,
      zoneType: null,
      observations: [observationForZone(null)],
      confidence: null,
    };
  }

  if (location.status === "matched") {
    return {
      status: "matched",
      zoneId: location.zone.id,
      zoneType: location.zone.type,
      observations: [observationForZone(location.zone)],
      confidence: location.score,
    };
  }

  if (location.status === "ambiguous") {
    const decision = findAdjudicationDecision(detection, adjudicationDecisions);

    if (decision?.selectedZoneDetectionId) {
      const zone = findZone(decision.selectedZoneDetectionId, zones);

      if (zone) {
        return {
          status: "matched",
          zoneId: zone.id,
          zoneType: zone.type,
          observations: [observationForZone(zone)],
          confidence: decision.confidence,
        };
      }
    }

    return {
      status: "needs_review",
      zoneId: null,
      zoneType: null,
      observations: [observationForZone(null)],
      confidence: decision?.confidence ?? null,
    };
  }

  return {
    status: "unmatched",
    zoneId: null,
    zoneType: null,
    observations: [observationForZone(null)],
    confidence: null,
  };
}

function createInventoryItem(
  detection: RawDetection,
  reconciledLocations: ReconciledLocation[],
  adjudicationDecisions: LocationAdjudicationDecision[],
  zones: FridgeZoneDetection[],
): InventoryItem {
  const location = createLocation(
    detection,
    reconciledLocations,
    adjudicationDecisions,
    zones,
  );
  const isUnidentified = isUnidentifiedInventoryLabel(detection.name);
  const recipeCategory = categorizeInventoryForRecipes({
    label: detection.name,
    packaging: detection.pack,
  });

  return {
    id: detection.id,
    name: canonicalItemName(detection.name),
    label: detection.name,
    cat: recipeCategory.category,
    subcat: recipeCategory.recipeIngredient,
    qty: {
      amount: null,
      unit: "unknown",
      precision: "unknown",
      fillLevel: null,
    },
    pack: detection.pack,
    stack: detection.stack,
    loc: location,
    conf: detection.conf,
    src: [detection.id],
    attrs: {
      brand: null,
      variant: null,
      opened: null,
      expirationDate: null,
    },
    review:
      !isUnidentified &&
      location.status === "matched" &&
      location.confidence !== null
        ? "inferred"
        : "needs_review",
  };
}

function stackedDepthBackRatio(
  item: InventoryItem,
  observation: InventoryItem["loc"]["observations"][number],
  itemsById: Map<string, InventoryItem>,
  visiting: Set<string>,
): number | null {
  const supportItemId = item.stack?.on;

  if (!supportItemId) {
    return observation.depthBackRatio;
  }

  const visitKey = `${item.id}:${observation.imageId}`;

  if (visiting.has(visitKey)) {
    throw new Error(`Cannot align stacked depth for item ${item.id} because its stack references form a cycle`);
  }

  const supportItem = itemsById.get(supportItemId);

  if (!supportItem) {
    throw new Error(`Cannot align stacked depth for item ${item.id} because support item ${supportItemId} was not found`);
  }

  const supportObservation = supportItem.loc.observations.find(
    (candidate) => candidate.imageId === observation.imageId,
  );

  if (!supportObservation) {
    throw new Error(`Cannot align stacked depth for item ${item.id} because support item ${supportItemId} has no observation for image ${observation.imageId}`);
  }

  visiting.add(visitKey);

  try {
    return stackedDepthBackRatio(
      supportItem,
      supportObservation,
      itemsById,
      visiting,
    );
  } finally {
    visiting.delete(visitKey);
  }
}

function alignStackedDepthRatios(items: InventoryItem[]) {
  const itemsById = new Map(items.map((item) => [item.id, item]));

  return items.map((item) => {
    if (!item.stack?.on) {
      return item;
    }

    return {
      ...item,
      loc: {
        ...item.loc,
        observations: item.loc.observations.map((observation) => ({
          ...observation,
          depthBackRatio: stackedDepthBackRatio(
            item,
            observation,
            itemsById,
            new Set(),
          ),
        })),
      },
    };
  });
}

export async function reconcileInventory(state: ScanStateValue): Promise<{
  inventory: Inventory;
}> {
  const zones = state.zoneMaps.flatMap((zoneMap) => zoneMap.zones);
  const detectedItems = state.rawDetections.map((detection) =>
    createInventoryItem(
      detection,
      state.reconciledLocations,
      state.adjudicationDecisions,
      zones,
    ),
  );
  const items = alignStackedDepthRatios(detectedItems);

  return {
    inventory: {
      id: `inventory:${state.fridgeId}:${state.imageIds.join(",")}`,
      fridgeId: state.fridgeId,
      scanId: `scan:${state.imageIds.join(",")}`,
      source: "gemini-vision",
      createdAt: new Date().toISOString(),
      model: VISION_MODEL,
      items,
      zones: createInventoryZones(state.zoneMaps, items),
    },
  };
}
