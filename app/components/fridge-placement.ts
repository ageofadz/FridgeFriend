import type {
  Inventory,
  InventoryItem,
  NormalizedBoundingBox,
  ZoneType,
} from "../server/scan/schemas/inventory";

export type InventoryZone = Inventory["zones"][number];
export type InventoryObservation =
  InventoryItem["loc"]["observations"][number];

export type ScenePlacement = {
  item: InventoryItem;
  supportZone: InventoryZone;
  x: number;
  y: number;
  z: number;
  width: number;
  height: number;
  depth: number;
};

function imageGroundedSurfaceY(zone: InventoryZone) {
  if (zone.surfaceY === undefined) {
    throw new Error(`Cannot render image-grounded placement because zone ${zone.id} has no surfaceY`);
  }

  return imageYToWorld(zone.surfaceY) + (isThinShelfZone(zone) ? SHELF_THICKNESS / 2 : 0);
}

function imageGroundedSupportSurfaceY(zone: InventoryZone) {
  return zone.surfaceY === undefined
    ? supportSurfaceTopY(zone)
    : imageGroundedSurfaceY(zone);
}

function imageGroundedClearance(
  zone: InventoryZone,
  zones: InventoryZone[],
  observation: InventoryObservation,
) {
  if (zone.surfaceY === undefined) {
    throw new Error(`Cannot render image-grounded placement because zone ${zone.id} has no surfaceY`);
  }

  const supportY = zone.surfaceY;
  const observationLeft = observation.boundingBox.x;
  const observationRight = observation.boundingBox.x + observation.boundingBox.width;
  const ceilingY = zones
    .filter((candidate) => candidate.id !== zone.id && candidate.surfaceY !== undefined)
    .filter((candidate) => candidate.imageIds.includes(observation.imageId))
    .filter((candidate) => intervalOverlap(
      observationLeft,
      observationRight,
      candidate.boundingBox.x,
      candidate.boundingBox.x + candidate.boundingBox.width,
    ) > 0)
    .map((candidate) => candidate.surfaceY!)
    .filter((candidateSurfaceY) => candidateSurfaceY < supportY)
    .sort((left, right) => right - left)[0] ?? 0;
  const imageClearance = supportY - ceilingY;

  if (imageClearance <= 0) {
    return null;
  }

  return { imageClearance, worldClearance: imageClearance * SCENE_HEIGHT };
}

function reviewSupportZoneForItem(
  item: InventoryItem,
  zones: InventoryZone[],
  observation: InventoryObservation,
) {
  const localZones = zones.filter((zone) =>
    zone.imageIds.includes(observation.imageId)
  );
  const hintedZone = item.loc.zoneId
    ? localZones.find((zone) => zone.id === item.loc.zoneId && isStorageBaseZone(zone))
    : undefined;

  if (hintedZone) {
    return hintedZone;
  }

  return chooseBestSupportZone(
    observation.boundingBox,
    localZones.map((zone) => ({
      value: zone,
      id: zone.id,
      type: zone.type,
      boundingBox: zone.boundingBox,
      confidence: zone.confidence,
    })),
  )?.value ?? null;
}

function imageGroundedReviewPlacement(
  item: InventoryItem,
  zones: InventoryZone[],
): ScenePlacement | null {
  if (!item.scene || item.scene.status !== "needs_review") {
    return null;
  }

  const observation = item.loc.observations[0];

  if (!observation) {
    throw new Error(`Cannot render image-grounded review placement because item ${item.id} has no observation`);
  }

  const supportZone = reviewSupportZoneForItem(item, zones, observation);

  if (!supportZone) {
    return null;
  }

  const dimensions = itemDimensions(item, supportZone, zones);

  return {
    item,
    supportZone,
    x: bboxXOnZone(observation, supportZone, dimensions.width),
    y: imageGroundedSupportSurfaceY(supportZone) + dimensions.height / 2,
    z: bboxZOnZone(
      {
        ...observation,
        depthBackRatio: observation.depthBackRatio ??
          depthBackRatioForBoxInZone(observation.boundingBox, supportZone.boundingBox),
      },
      supportZone,
      dimensions.depth,
    ),
    ...dimensions,
  };
}

export function buildImageGroundedPlacementLayout(inventory: Inventory) {
  if (inventory.sceneVersion !== "image-grounded-v2") {
    throw new Error("Cannot use image-grounded placement layout for a legacy inventory");
  }

  const zonesById = new Map(inventory.zones.map((zone) => [zone.id, zone]));
  const itemsById = new Map(inventory.items.map((item) => [item.id, item]));
  const placementsById = new Map<string, ScenePlacement | null>();
  const resolving = new Set<string>();

  function place(item: InventoryItem): ScenePlacement | null {
    if (placementsById.has(item.id)) return placementsById.get(item.id) ?? null;
    if (resolving.has(item.id)) {
      throw new Error(`Cannot render image-grounded placement because support references form a cycle at ${item.id}`);
    }
    if (!item.scene || item.scene.status !== "placed") {
      placementsById.set(item.id, null);
      return null;
    }
    const observation = item.loc.observations[0];
    if (!observation) throw new Error(`Cannot render image-grounded placement because item ${item.id} has no observation`);

    resolving.add(item.id);
    try {
      const baseZone = item.scene.supportKind === "zone"
        ? zonesById.get(item.scene.supportId)
        : (() => {
          const support = itemsById.get(item.scene.supportId);
          if (!support) throw new Error(`Cannot render image-grounded placement because support item ${item.scene!.supportId} was not found`);
          const supportPlacement = place(support);
          if (!supportPlacement) {
            placementsById.set(item.id, null);
            return null;
          }
          return supportPlacement.supportZone;
        })();
      if (baseZone === null) return null;
      if (!baseZone) throw new Error(`Cannot render image-grounded placement because support zone ${item.scene.supportId} was not found`);
      const xBounds = zoneWorldXBounds(baseZone);
      const zoneWidth = xBounds.right - xBounds.left;
      const clearance = imageGroundedClearance(baseZone, inventory.zones, observation);
      if (!clearance) {
        placementsById.set(item.id, null);
        return null;
      }
      const { imageClearance, worldClearance } = clearance;
      const width = zoneWidth * (observation.boundingBox.width / baseZone.boundingBox.width);
      const height = Math.min(
        worldClearance,
        worldClearance * (observation.boundingBox.height / imageClearance),
      );
      const depth = SCENE_DEPTH * (item.scene.depth.front - item.scene.depth.back);
      const supportSurface = imageGroundedSurfaceY(baseZone);
      const placement: ScenePlacement = {
        item,
        supportZone: baseZone,
        x: imageXToWorld(observation.boundingBox.x + observation.boundingBox.width / 2),
        y: supportSurface + height / 2,
        z: -SCENE_DEPTH / 2 + SCENE_DEPTH * ((item.scene.depth.back + item.scene.depth.front) / 2),
        width,
        height,
        depth,
      };

      if (item.scene.supportKind === "item") {
        const support = place(itemsById.get(item.scene.supportId)!);
        if (!support) {
          placementsById.set(item.id, null);
          return null;
        }
        placement.y = support.y + support.height / 2 + height / 2;
        assertStackFootprintOverlap(placement, support);
      }

      placementsById.set(item.id, placement);
      return placement;
    } finally {
      resolving.delete(item.id);
    }
  }

  return inventory.items.flatMap((item) => {
    if (item.scene?.status === "placed") {
      const placement = place(item);
      return placement ? [placement] : [];
    }

    const reviewPlacement = imageGroundedReviewPlacement(item, inventory.zones);
    return reviewPlacement ? [reviewPlacement] : [];
  });
}

export type SupportZoneCandidate<T> = {
  value: T;
  id: string;
  type: ZoneType;
  boundingBox: NormalizedBoundingBox;
  confidence: number;
};

type CanonicalizeInventoryPlacementOptions = {
  repairUnmatched?: boolean;
};

export const SCENE_WIDTH = 5;
export const SCENE_HEIGHT = 7;
export const SCENE_DEPTH = 2.2;
export const SHELF_THICKNESS = 0.05;
type ItemDimensions = {
  width: number;
  height: number;
  depth: number;
};
const PACKAGE_DIMENSIONS: Record<InventoryItem["pack"], ItemDimensions> = {
  loose: { width: 0.34, height: 0.34, depth: 0.34 },
  bottle: { width: 0.34, height: 1.05, depth: 0.34 },
  jar: { width: 0.42, height: 0.56, depth: 0.42 },
  can: { width: 0.34, height: 0.52, depth: 0.34 },
  carton: { width: 0.5, height: 0.9, depth: 0.38 },
  bag: { width: 0.58, height: 0.52, depth: 0.32 },
  box: { width: 0.72, height: 0.44, depth: 0.48 },
  tray: { width: 0.86, height: 0.18, depth: 0.52 },
  container: { width: 0.54, height: 0.36, depth: 0.42 },
  unknown: { width: 0.42, height: 0.42, depth: 0.34 },
};
const EGG_CARTON_DIMENSIONS: ItemDimensions = {
  width: 0.92,
  height: 0.16,
  depth: 0.42,
};

export function imageXToWorld(x: number) {
  return (x - 0.5) * SCENE_WIDTH;
}

export function imageYToWorld(y: number) {
  return (0.5 - y) * SCENE_HEIGHT;
}

export function zoneSurfaceY(zone: Pick<InventoryZone, "boundingBox">) {
  return imageYToWorld(zone.boundingBox.y + zone.boundingBox.height);
}

function zoneCeilingY(zone: Pick<InventoryZone, "boundingBox">) {
  return imageYToWorld(zone.boundingBox.y);
}

function zoneSurfaceImageY(zone: Pick<InventoryZone, "boundingBox">) {
  return zone.boundingBox.y + zone.boundingBox.height;
}

export function isStorageBaseZone(
  zone: Pick<{ type: ZoneType }, "type">,
) {
  return (
    zone.type === "shelf" ||
    zone.type === "door_shelf" ||
    zone.type === "drawer" ||
    zone.type === "freezer" ||
    zone.type === "pantry"
  );
}

function isThinShelfZone(zone: Pick<InventoryZone, "type">) {
  return zone.type === "shelf" || zone.type === "door_shelf";
}

export function supportSurfaceTopY(zone: InventoryZone) {
  return zoneSurfaceY(zone) + (isThinShelfZone(zone) ? SHELF_THICKNESS / 2 : 0);
}

export function zoneClearanceHeight(zone: InventoryZone, zones: InventoryZone[]) {
  if (zone.type !== "shelf") {
    return zoneCeilingY(zone) - zoneSurfaceY(zone);
  }

  const surfaceImageY = zoneSurfaceImageY(zone);
  const nearestSurfaceAbove = zones
    .filter((candidate) => candidate.id !== zone.id)
    .filter((candidate) => candidate.type === "shelf")
    .filter((candidate) => candidate.imageIds.some(
      (imageId) => zone.imageIds.includes(imageId),
    ))
    .map(zoneSurfaceImageY)
    .filter((candidateSurfaceY) => candidateSurfaceY < surfaceImageY)
    .sort((a, b) => b - a)[0];
  const ceilingImageY = nearestSurfaceAbove ?? 0;

  return (surfaceImageY - ceilingImageY) * SCENE_HEIGHT;
}

function zoneWorldXBounds(zone: InventoryZone) {
  return {
    left: imageXToWorld(zone.boundingBox.x),
    right: imageXToWorld(zone.boundingBox.x + zone.boundingBox.width),
  };
}

export function zoneWorldZBounds(_zone: InventoryZone) {
  return {
    back: -SCENE_DEPTH / 2,
    front: SCENE_DEPTH / 2,
  };
}

function fitInsideBounds(value: number, size: number, minimum: number, maximum: number) {
  const insideMinimum = minimum + size / 2;
  const insideMaximum = maximum - size / 2;

  if (insideMinimum > insideMaximum) {
    return (minimum + maximum) / 2;
  }

  return Math.min(Math.max(value, insideMinimum), insideMaximum);
}

function clampUnit(value: number) {
  return Math.min(1, Math.max(0, value));
}

export function depthBackRatioForBoxInZone(
  itemBox: NormalizedBoundingBox,
  zoneBox: NormalizedBoundingBox,
) {
  return clampUnit(
    (itemBox.y + itemBox.height - zoneBox.y) / zoneBox.height,
  );
}

function bboxXOnZone(
  observation: InventoryObservation,
  zone: InventoryZone,
  width: number,
) {
  const bounds = zoneWorldXBounds(zone);
  const x = imageXToWorld(
    observation.boundingBox.x + observation.boundingBox.width / 2,
  );

  return fitInsideBounds(x, width, bounds.left, bounds.right);
}

function bboxZOnZone(
  observation: InventoryObservation,
  zone: InventoryZone,
  depth: number,
) {
  if (observation.depthBackRatio === null) {
    throw new Error(`Cannot place item observation for image ${observation.imageId} because depthBackRatio is null`);
  }

  const bounds = zoneWorldZBounds(zone);
  const z = bounds.back + (bounds.front - bounds.back) * observation.depthBackRatio;

  return fitInsideBounds(z, depth, bounds.back, bounds.front);
}

function isEggPackageLabel(label: string) {
  const canonical = label.toLowerCase();

  return (
    canonical.includes("egg carton") ||
    canonical.includes("carton of eggs") ||
    /\begg\b/.test(canonical) ||
    /\beggs\b/.test(canonical)
  );
}

export function renderedPackageDimensions(
  item: Pick<InventoryItem, "pack" | "label" | "name">,
) {
  if (isEggPackageLabel(`${item.label} ${item.name}`)) {
    return EGG_CARTON_DIMENSIONS;
  }

  return PACKAGE_DIMENSIONS[item.pack];
}

function fitPackageDimensionsToZone(
  dimensions: ItemDimensions,
  zoneWidth: number,
  zoneDepth: number,
  clearanceHeight: number,
) {
  if (zoneWidth <= 0 || zoneDepth <= 0 || clearanceHeight <= 0) {
    throw new Error(`Cannot fit item dimensions because zone capacity is invalid: width=${zoneWidth}, depth=${zoneDepth}, clearance=${clearanceHeight}`);
  }

  const scale = Math.min(
    1,
    zoneWidth / dimensions.width,
    zoneDepth / dimensions.depth,
    clearanceHeight / dimensions.height,
  );

  if (!Number.isFinite(scale) || scale <= 0) {
    throw new Error(`Cannot fit item dimensions because scale is invalid: ${scale}`);
  }

  return {
    width: dimensions.width * scale,
    height: dimensions.height * scale,
    depth: dimensions.depth * scale,
  };
}

function itemDimensions(
  item: InventoryItem,
  supportZone: InventoryZone,
  zones: InventoryZone[],
) {
  const xBounds = zoneWorldXBounds(supportZone);
  const zBounds = zoneWorldZBounds(supportZone);
  const zoneWidth = xBounds.right - xBounds.left;
  const zoneDepth = zBounds.front - zBounds.back;
  const clearanceHeight = zoneClearanceHeight(supportZone, zones) -
    (isThinShelfZone(supportZone) ? SHELF_THICKNESS : 0);

  return fitPackageDimensionsToZone(
    renderedPackageDimensions(item),
    zoneWidth,
    zoneDepth,
    clearanceHeight,
  );
}

function intervalOverlap(
  leftStart: number,
  leftEnd: number,
  rightStart: number,
  rightEnd: number,
) {
  return Math.min(leftEnd, rightEnd) - Math.max(leftStart, rightStart);
}

function overlapRatio(
  leftStart: number,
  leftEnd: number,
  rightStart: number,
  rightEnd: number,
) {
  const overlap = Math.max(0, intervalOverlap(
    leftStart,
    leftEnd,
    rightStart,
    rightEnd,
  ));
  const denominator = Math.min(leftEnd - leftStart, rightEnd - rightStart);

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

function assertStackFootprintOverlap(
  item: ScenePlacement,
  support: ScenePlacement,
) {
  const xOverlap = intervalOverlap(
    item.x - item.width / 2,
    item.x + item.width / 2,
    support.x - support.width / 2,
    support.x + support.width / 2,
  );
  const zOverlap = intervalOverlap(
    item.z - item.depth / 2,
    item.z + item.depth / 2,
    support.z - support.depth / 2,
    support.z + support.depth / 2,
  );

  if (xOverlap <= 0 || zOverlap <= 0) {
    throw new Error(`Cannot place stacked item ${item.item.id} because its footprint does not overlap support item ${support.item.id}`);
  }
}

function supportZoneForItem(
  item: InventoryItem,
  zonesById: Map<string, InventoryZone>,
  directSupportZoneByItemId: ReadonlyMap<string, string>,
) {
  const zoneId = directSupportZoneByItemId.get(item.id) ?? item.loc.zoneId;

  if (!zoneId) {
    throw new Error(`Cannot place item ${item.id} because it has no storage-base zone`);
  }

  const zone = zonesById.get(zoneId);

  if (!zone) {
    throw new Error(`Cannot place item ${item.id} because storage-base zone ${zoneId} was not found`);
  }

  if (!isStorageBaseZone(zone)) {
    throw new Error(`Cannot place item ${item.id} because zone ${zone.id} is not a storage base`);
  }

  return zone;
}

function createBasePlacement(
  item: InventoryItem,
  zonesById: Map<string, InventoryZone>,
  zones: InventoryZone[],
  directSupportZoneByItemId: ReadonlyMap<string, string>,
): ScenePlacement {
  const observation = item.loc.observations[0];

  if (!observation) {
    throw new Error(`Cannot place item ${item.id} because it has no location observation`);
  }

  const supportZone = supportZoneForItem(
    item,
    zonesById,
    directSupportZoneByItemId,
  );

  if (!supportZone.imageIds.includes(observation.imageId)) {
    throw new Error(`Cannot place item ${item.id} because zone ${supportZone.id} is not mapped for image ${observation.imageId}`);
  }

  const dimensions = itemDimensions(item, supportZone, zones);

  return {
    item,
    supportZone,
    x: bboxXOnZone(observation, supportZone, dimensions.width),
    y: supportSurfaceTopY(supportZone) + dimensions.height / 2,
    z: bboxZOnZone(observation, supportZone, dimensions.depth),
    ...dimensions,
  };
}

function observationCenterX(observation: InventoryObservation) {
  return observation.boundingBox.x + observation.boundingBox.width / 2;
}

function canonicalizeHorizontalOrder(placements: ScenePlacement[]) {
  const groups = new Map<string, ScenePlacement[]>();

  for (const placement of placements) {
    const observation = placement.item.loc.observations[0];

    if (!observation) {
      throw new Error(`Cannot place item ${placement.item.id} because it has no location observation`);
    }

    const key = `${observation.imageId}:${placement.supportZone.id}`;
    const group = groups.get(key);

    if (group) {
      group.push(placement);
    } else {
      groups.set(key, [placement]);
    }
  }

  for (const group of groups.values()) {
    if (group.length < 2) {
      continue;
    }

    const imageOrdered = [...group].sort((left, right) => {
      const leftObservation = left.item.loc.observations[0];
      const rightObservation = right.item.loc.observations[0];

      return observationCenterX(leftObservation) - observationCenterX(rightObservation) ||
        left.item.id.localeCompare(right.item.id);
    });
    const worldXs = group.map((placement) => placement.x).sort((left, right) => left - right);

    for (let index = 0; index < imageOrdered.length; index += 1) {
      imageOrdered[index].x = worldXs[index];
    }
  }
}

export function buildInventoryPlacementLayout(
  inventory: Inventory,
  directSupportZoneByItemId: ReadonlyMap<string, string> = new Map(),
) {
  const zonesById = new Map(inventory.zones.map((zone) => [zone.id, zone]));
  const itemsById = new Map(inventory.items.map((item) => [item.id, item]));
  const placementsById = new Map<string, ScenePlacement>();
  const resolving = new Set<string>();

  function place(item: InventoryItem): ScenePlacement {
    const existing = placementsById.get(item.id);

    if (existing) {
      return existing;
    }

    if (resolving.has(item.id)) {
      throw new Error(`Cannot place item ${item.id} because stack references form a cycle`);
    }

    resolving.add(item.id);

    try {
      const placement = createBasePlacement(
        item,
        zonesById,
        inventory.zones,
        directSupportZoneByItemId,
      );
      const stackedOnItemId = directSupportZoneByItemId.has(item.id)
        ? undefined
        : item.stack?.on;

      if (stackedOnItemId) {
        const supportItem = itemsById.get(stackedOnItemId);

        if (!supportItem) {
          throw new Error(`Cannot place stacked item ${item.id} because support item ${stackedOnItemId} was not found`);
        }

        const supportPlacement = place(supportItem);

        if (placement.supportZone.id !== supportPlacement.supportZone.id) {
          throw new Error(`Cannot place stacked item ${item.id} because it is assigned to zone ${placement.supportZone.id} while support item ${supportItem.id} is on ${supportPlacement.supportZone.id}`);
        }

        placement.z = supportPlacement.z;
        placement.y = supportPlacement.y + supportPlacement.height / 2 + placement.height / 2;
        assertStackFootprintOverlap(placement, supportPlacement);
      }

      placementsById.set(item.id, placement);
      return placement;
    } finally {
      resolving.delete(item.id);
    }
  }

  const placements = inventory.items
    .filter((item) => item.loc.status === "matched" && item.loc.zoneId)
    .map(place);

  canonicalizeHorizontalOrder(placements);

  return placements;
}

export function canonicalizeInventoryPlacement(
  inventory: Inventory,
  options: CanonicalizeInventoryPlacementOptions = {},
) {
  const zonesById = new Map(inventory.zones.map((zone) => [zone.id, zone]));
  const itemsById = new Map(inventory.items.map((item) => [item.id, item]));
  const resolvedItems = new Map<string, InventoryItem>();
  const resolving = new Set<string>();
  const repairUnmatched = options.repairUnmatched ?? true;

  function baseZoneForItem(item: InventoryItem, observation: InventoryObservation) {
    const currentZone = item.loc.zoneId
      ? zonesById.get(item.loc.zoneId)
      : undefined;

    if (
      currentZone &&
      isStorageBaseZone(currentZone) &&
      currentZone.imageIds.includes(observation.imageId) &&
      (
        item.loc.status === "matched" ||
        item.loc.assignment?.source === "user_confirmed"
      )
    ) {
      return currentZone;
    }

    if (!repairUnmatched) {
      return null;
    }

    const candidates = inventory.zones
      .filter((zone) => zone.imageIds.includes(observation.imageId))
      .map((zone) => ({
        value: zone,
        id: zone.id,
        type: zone.type,
        boundingBox: zone.boundingBox,
        confidence: zone.confidence,
      }));
    const best = chooseBestSupportZone(observation.boundingBox, candidates);

    return best?.value ?? null;
  }

  function resolve(item: InventoryItem): InventoryItem {
    const existing = resolvedItems.get(item.id);

    if (existing) {
      return existing;
    }

    if (resolving.has(item.id)) {
      throw new Error(`Cannot place item ${item.id} because stack references form a cycle`);
    }

    const observation = item.loc.observations[0];

    if (!observation) {
      throw new Error(`Cannot place item ${item.id} because it has no location observation`);
    }

    resolving.add(item.id);

    try {
      let resolved: InventoryItem;

      if (!repairUnmatched && item.loc.status !== "matched") {
        resolved = item;
        resolvedItems.set(item.id, resolved);
        return resolved;
      }

      if (item.stack?.on) {
        const support = itemsById.get(item.stack.on);

        if (!support) {
          throw new Error(`Cannot place stacked item ${item.id} because support item ${item.stack.on} was not found`);
        }

        const resolvedSupport = resolve(support);
        const supportObservation = resolvedSupport.loc.observations.find(
          (candidate) => candidate.imageId === observation.imageId,
        );

        if (
          resolvedSupport.loc.status !== "matched" ||
          !resolvedSupport.loc.zoneId ||
          !resolvedSupport.loc.zoneType
        ) {
          resolved = {
            ...item,
            loc: {
              ...item.loc,
              status: "unmatched",
              zoneId: null,
              zoneType: null,
              confidence: null,
              observations: item.loc.observations.map((candidate) => ({
                ...candidate,
                depthBackRatio: candidate.imageId === observation.imageId
                  ? null
                  : candidate.depthBackRatio,
              })),
            },
          };
          resolvedItems.set(item.id, resolved);
          return resolved;
        }

        if (!supportObservation || supportObservation.depthBackRatio === null) {
          throw new Error(`Cannot place stacked item ${item.id} because support item ${support.id} has no depth anchor for image ${observation.imageId}`);
        }

        resolved = {
          ...item,
          loc: {
            ...item.loc,
            status: "matched",
            zoneId: resolvedSupport.loc.zoneId,
            zoneType: resolvedSupport.loc.zoneType,
            confidence: resolvedSupport.loc.confidence,
            observations: item.loc.observations.map((candidate) => ({
              ...candidate,
              depthBackRatio: candidate.imageId === observation.imageId
                ? supportObservation.depthBackRatio
                : candidate.depthBackRatio,
            })),
          },
        };
      } else {
        const zone = baseZoneForItem(item, observation);

        if (!zone) {
          resolved = item;
          resolvedItems.set(item.id, resolved);
          return resolved;
        }

        const depthBackRatio = depthBackRatioForBoxInZone(
          observation.boundingBox,
          zone.boundingBox,
        );

        resolved = {
          ...item,
          loc: {
            ...item.loc,
            status: "matched",
            zoneId: zone.id,
            zoneType: zone.type,
            confidence: item.loc.confidence ?? zone.confidence,
            observations: item.loc.observations.map((candidate) => ({
              ...candidate,
              depthBackRatio: candidate.imageId === observation.imageId
                ? depthBackRatio
                : candidate.depthBackRatio,
            })),
          },
        };
      }

      resolvedItems.set(item.id, resolved);
      return resolved;
    } finally {
      resolving.delete(item.id);
    }
  }

  const resolvedInventory = {
    ...inventory,
    items: inventory.items.map(resolve),
  } satisfies Inventory;

  buildInventoryPlacementLayout(resolvedInventory);

  return resolvedInventory;
}

export function chooseBestSupportZone<T>(
  itemBox: NormalizedBoundingBox,
  candidates: SupportZoneCandidate<T>[],
) {
  const itemLeft = itemBox.x;
  const itemRight = itemBox.x + itemBox.width;
  const itemTop = itemBox.y;
  const itemBottom = itemBox.y + itemBox.height;
  const itemCenter = {
    x: itemBox.x + itemBox.width / 2,
    y: itemBox.y + itemBox.height / 2,
  };

  return candidates
    .filter((candidate) => isStorageBaseZone(candidate))
    .map((candidate) => {
      const box = candidate.boundingBox;

      return {
        candidate,
        containsCenter: boxContainsPoint(box, itemCenter),
        horizontalOverlapRatio: overlapRatio(
          itemLeft,
          itemRight,
          box.x,
          box.x + box.width,
        ),
        verticalOverlapRatio: overlapRatio(
          itemTop,
          itemBottom,
          box.y,
          box.y + box.height,
        ),
        surfaceDistance: Math.abs(itemBottom - (box.y + box.height)),
      };
    })
    .filter(({ horizontalOverlapRatio, verticalOverlapRatio }) =>
      horizontalOverlapRatio > 0 && verticalOverlapRatio > 0
    )
    .sort((left, right) => {
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

      if (left.surfaceDistance !== right.surfaceDistance) {
        return left.surfaceDistance - right.surfaceDistance;
      }

      if (left.candidate.confidence !== right.candidate.confidence) {
        return right.candidate.confidence - left.candidate.confidence;
      }

      return left.candidate.id.localeCompare(right.candidate.id);
    })[0]?.candidate ?? null;
}
