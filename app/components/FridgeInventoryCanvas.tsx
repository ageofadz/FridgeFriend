import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

import {
  type Inventory,
  type InventoryItem,
} from "../server/scan/schemas/inventory";
import type { WorkspaceFocus } from "../workspace/contracts";
import {
  dominantWeightedAverageColor,
  type VisualColorTarget,
} from "./item-wireframe-color";

type FridgeInventoryCanvasProps = {
  inventory: Inventory;
  imageDataUrls: Record<string, string>;
  workspaceFocus?: WorkspaceFocus;
  previewPlacements?: Array<{ itemId: string; zoneId: string }>;
  onSelectItem?(itemId: string): void;
  onSeedItem?(item: InventoryItem): void;
  onSelectZone?(zoneId: string): void;
  onClearSelection?(): void;
  onHoverItem?(itemId: string | null): void;
};

type SceneItem = {
  item: InventoryItem;
  supportZone: InventoryZone | null;
  x: number;
  y: number;
  z: number;
  width: number;
  height: number;
  depth: number;
  color: number;
};

type InventoryZone = Inventory["zones"][number];
type InventoryObservation =
  InventoryItem["loc"]["observations"][number];
const SCENE_WIDTH = 5;
const SCENE_HEIGHT = 7;
const SCENE_DEPTH = 2.2;
const SHELF_THICKNESS = 0.05;
const CAMERA_FRUSTUM_HEIGHT = 8.4;
const MIN_RENDERED_ITEM_HEIGHT = 0.12;
const FLAT_PACKAGE_MIN_HEIGHT_RATIO = 0.16;
const FLAT_PACKAGE_MAX_HEIGHT_RATIO = 0.42;
const EGG_CARTON_LONG_SIDE_RATIO = 2.4;
const EGG_CARTON_MIN_ZONE_WIDTH_RATIO = 0.22;
const ZONE_WIREFRAME_COLOR = 0xd1d5db;
const ZONE_CLEARANCE_WIREFRAME_COLOR = 0xe5e7eb;
const UPRIGHT_PACKAGE_MIN_HEIGHT_RATIO: Partial<
  Record<InventoryItem["pack"], number>
> = {
  bottle: 2.4,
  can: 1.15,
  jar: 0.95,
  carton: 1.35,
  bag: 0.65,
  container: 0.55,
  unknown: 0.55,
};

function imageXToWorld(x: number) {
  return (x - 0.5) * SCENE_WIDTH;
}

function imageYToWorld(y: number) {
  return (0.5 - y) * SCENE_HEIGHT;
}

function zoneSurfaceY(zone: InventoryZone) {
  return imageYToWorld(zone.boundingBox.y + zone.boundingBox.height);
}

function zoneCeilingY(zone: InventoryZone) {
  return imageYToWorld(zone.boundingBox.y);
}

function zoneSurfaceImageY(zone: InventoryZone) {
  return zone.boundingBox.y + zone.boundingBox.height;
}

function zoneClearanceHeight(zone: InventoryZone, zones: InventoryZone[]) {
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

function zoneWorldZBounds(zone: InventoryZone) {
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
    throw new Error(`Cannot render item observation for image ${observation.imageId} because depthBackRatio is null`);
  }

  const bounds = zoneWorldZBounds(zone);
  const z = bounds.back + (bounds.front - bounds.back) * observation.depthBackRatio;

  return fitInsideBounds(z, depth, bounds.back, bounds.front);
}

function isSupportZone(zone: InventoryZone) {
  return (
    zone.type === "shelf" ||
    zone.type === "door_shelf" ||
    zone.type === "drawer" ||
    zone.type === "freezer" ||
    zone.type === "pantry"
  );
}

function resolveSupportZone(
  item: InventoryItem,
  zonesById: Map<string, InventoryZone>,
) {
  const matchedZone = item.loc.zoneId
    ? zonesById.get(item.loc.zoneId)
    : null;

  if (!item.loc.zoneId) {
    return null;
  }

  if (!matchedZone) {
    throw new Error(`Cannot render item ${item.id} because matched zone ${item.loc.zoneId} was not found`);
  }

  if (!isSupportZone(matchedZone)) {
    throw new Error(`Cannot render item ${item.id} because matched zone ${item.loc.zoneId} has unsupported type ${matchedZone.type}`);
  }

  return matchedZone;
}

function isFlatPackage(item: InventoryItem, observation: InventoryObservation) {
  if (isEggPackage(item)) {
    return true;
  }

  const label = `${item.label} ${item.name}`.toLowerCase();
  const imageAspectRatio =
    observation.boundingBox.width / observation.boundingBox.height;

  return (
    item.pack === "tray" ||
    (item.pack === "box" && imageAspectRatio >= 1.35)
  );
}

function isEggPackage(item: InventoryItem) {
  const label = `${item.label} ${item.name}`.toLowerCase();

  return (
    label.includes("egg carton") ||
    label.includes("carton of eggs") ||
    /\begg\b/.test(label) ||
    /\beggs\b/.test(label)
  );
}

function fitItemFootprint(
  item: InventoryItem,
  observation: InventoryObservation,
  rawWidth: number,
  rawDepth: number,
  zoneWidth: number,
  zoneDepth: number,
) {
  const fittedWidth = Math.min(rawWidth, zoneWidth);
  const fittedDepth = Math.min(rawDepth, zoneDepth);

  if (!isEggPackage(item)) {
    return {
      width: fittedWidth,
      depth: fittedDepth,
    };
  }

  const shortSide = Math.max(Math.min(fittedWidth, fittedDepth), 0.12);
  const maxLongSide = Math.max(zoneWidth, zoneDepth);
  const longSide = Math.min(
    Math.max(
      Math.max(fittedWidth, fittedDepth),
      shortSide * EGG_CARTON_LONG_SIDE_RATIO,
      maxLongSide * EGG_CARTON_MIN_ZONE_WIDTH_RATIO,
    ),
    maxLongSide,
  );
  const imageAspectRatio = observation.boundingBox.width /
    Math.max(observation.boundingBox.height, Number.EPSILON);
  const prefersDepth = imageAspectRatio < 0.85;
  const widthFootprint = {
    width: Math.min(longSide, zoneWidth),
    depth: Math.min(shortSide, zoneDepth),
  };
  const depthFootprint = {
    width: Math.min(shortSide, zoneWidth),
    depth: Math.min(longSide, zoneDepth),
  };

  if (prefersDepth && longSide <= zoneDepth) {
    return depthFootprint;
  }

  if (!prefersDepth && longSide <= zoneWidth) {
    return widthFootprint;
  }

  if (longSide <= zoneDepth) {
    return depthFootprint;
  }

  return widthFootprint;
}

function fittedItemHeight(
  item: InventoryItem,
  observation: InventoryObservation,
  width: number,
  depth: number,
  rawHeight: number,
  clearanceHeight: number,
) {
  const footprintShortSide = Math.min(width, depth);
  const detectedVisualHeight = observation.boundingBox.height * SCENE_HEIGHT;
  const availableHeight = Math.max(clearanceHeight, MIN_RENDERED_ITEM_HEIGHT);

  if (isFlatPackage(item, observation)) {
    const minimumFlatHeight = Math.max(
      footprintShortSide * FLAT_PACKAGE_MIN_HEIGHT_RATIO,
      MIN_RENDERED_ITEM_HEIGHT,
    );
    const maximumFlatHeight = Math.max(
      footprintShortSide * FLAT_PACKAGE_MAX_HEIGHT_RATIO,
      minimumFlatHeight,
    );

    return Math.min(
      Math.max(rawHeight, minimumFlatHeight),
      maximumFlatHeight,
      availableHeight,
    );
  }

  const uprightHeightRatio =
    UPRIGHT_PACKAGE_MIN_HEIGHT_RATIO[item.pack] ?? 0;
  const minimumUprightHeight = Math.max(
    footprintShortSide * uprightHeightRatio,
    detectedVisualHeight,
    MIN_RENDERED_ITEM_HEIGHT,
  );

  return Math.min(Math.max(rawHeight, minimumUprightHeight), availableHeight);
}

function itemDimensions(
  item: InventoryItem,
  observation: InventoryObservation,
  supportZone: InventoryZone,
  zones: InventoryZone[],
) {
  const xBounds = zoneWorldXBounds(supportZone);
  const zBounds = zoneWorldZBounds(supportZone);
  const zoneWidth = xBounds.right - xBounds.left;
  const zoneDepth = zBounds.front - zBounds.back;
  const clearanceHeight = zoneClearanceHeight(supportZone, zones) -
    SHELF_THICKNESS;
  const rawWidth = observation.boundingBox.width * SCENE_WIDTH;
  const rawHeight = observation.boundingBox.height * SCENE_HEIGHT;
  const rawDepth = Math.min(
    zoneDepth,
    rawWidth / Math.max(zoneWidth, Number.EPSILON) * zoneDepth,
  );
  const { width: fittedWidth, depth: fittedDepth } = fitItemFootprint(
    item,
    observation,
    rawWidth,
    rawDepth,
    zoneWidth,
    zoneDepth,
  );
  const fittedHeight = fittedItemHeight(
    item,
    observation,
    fittedWidth,
    fittedDepth,
    rawHeight,
    clearanceHeight,
  );

  return {
    width: fittedWidth,
    height: fittedHeight,
    depth: fittedDepth,
  };
}

function createItemGeometry(sceneItem: SceneItem) {
  const { item, width, height, depth } = sceneItem;

  if (item.pack === "bottle" || item.pack === "can") {
    const geometry = new THREE.CylinderGeometry(0.5, 0.5, height, 18, 1);
    geometry.scale(width, 1, depth);
    return geometry;
  }

  if (item.pack === "jar") {
    const geometry = new THREE.CylinderGeometry(0.5, 0.5, height, 16, 1);
    geometry.scale(width, 1, depth);
    return geometry;
  }

  if (item.pack === "loose") {
    const geometry = new THREE.SphereGeometry(0.5, 14, 10);
    geometry.scale(width, height, depth);
    return geometry;
  }

  return new THREE.BoxGeometry(width, height, depth);
}

function createWireframeMaterial(color: number, opacity = 1) {
  return new THREE.MeshBasicMaterial({
    color,
    opacity,
    transparent: opacity < 1,
    wireframe: true,
  });
}

function createWireframeBox(
  width: number,
  height: number,
  depth: number,
  color: number,
  opacity = 1,
) {
  return new THREE.Mesh(
    new THREE.BoxGeometry(width, height, depth),
    createWireframeMaterial(color, opacity),
  );
}

function createFocusedOutline(
  geometry: THREE.BufferGeometry,
  color: number,
) {
  const outline = new THREE.Group();
  const offsets = [
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0.012, 0.012, 0.012),
    new THREE.Vector3(-0.012, -0.012, -0.012),
  ];

  for (const offset of offsets) {
    const edgeGeometry = new THREE.EdgesGeometry(geometry);
    const edgeFrame = new THREE.LineSegments(
      edgeGeometry,
      new THREE.LineBasicMaterial({
        color,
        transparent: false,
        opacity: 1,
      }),
    );
    edgeFrame.position.copy(offset);
    outline.add(edgeFrame);
  }

  return outline;
}

function disposeObject(object: THREE.Object3D) {
  for (const child of object.children) {
    disposeObject(child);
  }

  if (
    object instanceof THREE.Mesh ||
    object instanceof THREE.LineSegments
  ) {
    object.geometry.dispose();
    const materials = Array.isArray(object.material)
      ? object.material
      : [object.material];

    for (const material of materials) {
      material.dispose();
    }
  }
}

function createSceneItem(
  item: InventoryItem,
  zonesById: Map<string, InventoryZone>,
  zones: InventoryZone[],
  itemColors: Map<string, number>,
): SceneItem | null {
  const observation = item.loc.observations[0];

  if (!observation) {
    return null;
  }

  const supportZone = resolveSupportZone(
    item,
    zonesById,
  );

  if (!supportZone) {
    return null;
  }

  const dimensions = itemDimensions(
    item,
    observation,
    supportZone,
    zones,
  );
  const x = bboxXOnZone(observation, supportZone, dimensions.width);
  const z = bboxZOnZone(observation, supportZone, dimensions.depth);
  const y =
    zoneSurfaceY(supportZone) + SHELF_THICKNESS / 2 + dimensions.height / 2;
  const color = itemColors.get(item.id);

  if (color === undefined) {
    throw new Error(`Cannot render item ${item.id} because its wireframe color was not calculated`);
  }

  return {
    item,
    supportZone,
    x,
    y,
    z,
    ...dimensions,
    color,
  };
}

function applyStacking(sceneItems: SceneItem[]) {
  const sceneItemsById = new Map(
    sceneItems.map((sceneItem) => [sceneItem.item.id, sceneItem]),
  );
  for (let pass = 0; pass < sceneItems.length; pass += 1) {
    for (const sceneItem of sceneItems) {
      const stackedOnDetectionId = sceneItem.item.stack?.on;

      if (!stackedOnDetectionId) {
        continue;
      }

      const supportItem = sceneItemsById.get(stackedOnDetectionId);

      if (!supportItem) {
        throw new Error(`Cannot stack item ${sceneItem.item.id} because support item ${stackedOnDetectionId} was not rendered`);
      }

      sceneItem.z = supportItem.z;
      sceneItem.y =
        supportItem.y + supportItem.height / 2 + sceneItem.height / 2;
    }
  }
}

function buildSceneItems(inventory: Inventory, itemColors: Map<string, number>): SceneItem[] {
  const zonesById = new Map(inventory.zones.map((zone) => [zone.id, zone]));
  const sceneItems = inventory.items
    .map((item) => createSceneItem(item, zonesById, inventory.zones, itemColors))
    .filter((sceneItem): sceneItem is SceneItem => sceneItem !== null);

  applyStacking(sceneItems);

  return sceneItems;
}

function renderableItemColorTargets(inventory: Inventory): VisualColorTarget[] {
  const zonesById = new Map(inventory.zones.map((zone) => [zone.id, zone]));

  return inventory.items.flatMap((item) => {
    const observation = item.loc.observations[0];

    if (!observation) {
      return [];
    }

    const supportZone = resolveSupportZone(
      item,
      zonesById,
    );

    if (!supportZone) {
      return [];
    }

    return [{
      itemId: item.id,
      imageId: observation.imageId,
      boundingBox: observation.boundingBox,
    }];
  });
}

function loadSourceImage(dataUrl: string, imageId: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () =>
      reject(new Error(`Cannot derive item wireframe color because image ${imageId} failed to load`));
    image.src = dataUrl;
  });
}

function cropRect(image: HTMLImageElement, target: VisualColorTarget) {
  const sourceWidth = image.naturalWidth;
  const sourceHeight = image.naturalHeight;

  if (sourceWidth <= 0 || sourceHeight <= 0) {
    throw new Error(`Cannot derive item wireframe color because image ${target.imageId} has invalid dimensions ${sourceWidth}x${sourceHeight}`);
  }

  const cropLeft = Math.max(
    0,
    Math.min(sourceWidth - 1, Math.floor(target.boundingBox.x * sourceWidth)),
  );
  const cropTop = Math.max(
    0,
    Math.min(sourceHeight - 1, Math.floor(target.boundingBox.y * sourceHeight)),
  );
  const cropRight = Math.max(
    cropLeft + 1,
    Math.min(sourceWidth, Math.ceil((target.boundingBox.x + target.boundingBox.width) * sourceWidth)),
  );
  const cropBottom = Math.max(
    cropTop + 1,
    Math.min(sourceHeight, Math.ceil((target.boundingBox.y + target.boundingBox.height) * sourceHeight)),
  );

  return {
    left: cropLeft,
    top: cropTop,
    right: cropRight,
    bottom: cropBottom,
    width: cropRight - cropLeft,
    height: cropBottom - cropTop,
  };
}

function drawImageData(
  image: HTMLImageElement,
  target: VisualColorTarget,
  rect: ReturnType<typeof cropRect>,
) {
  const canvas = document.createElement("canvas");
  canvas.width = rect.width;
  canvas.height = rect.height;
  const context = canvas.getContext("2d", { willReadFrequently: true });

  if (!context) {
    throw new Error(`Cannot derive item wireframe color because a 2D canvas context could not be created for item ${target.itemId}`);
  }

  context.drawImage(
    image,
    rect.left,
    rect.top,
    rect.width,
    rect.height,
    0,
    0,
    rect.width,
    rect.height,
  );

  return context.getImageData(0, 0, rect.width, rect.height);
}

function cropImageData(
  image: HTMLImageElement,
  target: VisualColorTarget,
) {
  return drawImageData(image, target, cropRect(image, target));
}

function nearbyImageData(
  image: HTMLImageElement,
  target: VisualColorTarget,
) {
  const rect = cropRect(image, target);
  const sourceWidth = image.naturalWidth;
  const sourceHeight = image.naturalHeight;
  const margin = Math.max(8, Math.round(Math.max(rect.width, rect.height) * 0.22));
  const expanded = {
    left: Math.max(0, rect.left - margin),
    top: Math.max(0, rect.top - margin),
    right: Math.min(sourceWidth, rect.right + margin),
    bottom: Math.min(sourceHeight, rect.bottom + margin),
  };
  const expandedRect = {
    ...expanded,
    width: expanded.right - expanded.left,
    height: expanded.bottom - expanded.top,
  };
  const imageData = drawImageData(image, target, expandedRect);
  const itemLeft = rect.left - expandedRect.left;
  const itemTop = rect.top - expandedRect.top;
  const itemRight = rect.right - expandedRect.left;
  const itemBottom = rect.bottom - expandedRect.top;
  const pixelCount = expandedRect.width * expandedRect.height;
  const nearbyPixels = new Uint8ClampedArray(pixelCount * 4);
  let nearbyIndex = 0;

  for (let y = 0; y < expandedRect.height; y += 1) {
    for (let x = 0; x < expandedRect.width; x += 1) {
      if (x >= itemLeft && x < itemRight && y >= itemTop && y < itemBottom) {
        continue;
      }

      const sourceIndex = (y * expandedRect.width + x) * 4;
      nearbyPixels[nearbyIndex] = imageData.data[sourceIndex];
      nearbyPixels[nearbyIndex + 1] = imageData.data[sourceIndex + 1];
      nearbyPixels[nearbyIndex + 2] = imageData.data[sourceIndex + 2];
      nearbyPixels[nearbyIndex + 3] = imageData.data[sourceIndex + 3];
      nearbyIndex += 4;
    }
  }

  if (nearbyIndex === 0) {
    throw new Error(`Cannot derive item wireframe lighting because item ${target.itemId} has no nearby pixels around its bounding box`);
  }

  return {
    data: nearbyPixels.slice(0, nearbyIndex),
    width: nearbyIndex / 4,
    height: 1,
  };
}

async function calculateItemWireframeColors(
  targets: VisualColorTarget[],
  imageDataUrls: Record<string, string>,
) {
  const uniqueImageIds = [...new Set(targets.map((target) => target.imageId))];
  const imageEntries = await Promise.all(uniqueImageIds.map(async (imageId) => {
    const dataUrl = imageDataUrls[imageId];

    if (!dataUrl) {
      throw new Error(`Cannot derive item wireframe color because image data was not provided for image ${imageId}`);
    }

    return [imageId, await loadSourceImage(dataUrl, imageId)] as const;
  }));
  const imagesById = new Map(imageEntries);
  const colors = new Map<string, number>();

  for (const target of targets) {
    const image = imagesById.get(target.imageId);

    if (!image) {
      throw new Error(`Cannot derive item wireframe color because image ${target.imageId} was not loaded for item ${target.itemId}`);
    }

    colors.set(
      target.itemId,
      dominantWeightedAverageColor(
        cropImageData(image, target),
        nearbyImageData(image, target),
      ),
    );
  }

  return colors;
}

function formatPercent(value: number | null) {
  return value === null ? "Unknown" : `${Math.round(value * 100)}%`;
}

function formatLocation(item: InventoryItem, inventory: Inventory) {
  if (!item.loc.zoneId) {
    return item.loc.status;
  }

  const zone = inventory.zones.find(
    (candidate) => candidate.id === item.loc.zoneId,
  );

  return zone
    ? `${item.loc.status} · ${zone.label} (${zone.id})`
    : `${item.loc.status} · ${item.loc.zoneId}`;
}

function selectSmallestItemHit(
  itemHits: THREE.Intersection<THREE.Object3D>[],
) {
  return [...itemHits].sort((left, right) => {
    const leftVolume = left.object.userData.renderedVolume as number;
    const rightVolume = right.object.userData.renderedVolume as number;

    return leftVolume - rightVolume || left.distance - right.distance;
  })[0] ?? null;
}

export function FridgeInventoryCanvas({
  inventory,
  imageDataUrls,
  workspaceFocus,
  previewPlacements = [],
  onSelectItem,
  onSeedItem,
  onSelectZone,
  onClearSelection,
  onHoverItem,
}: FridgeInventoryCanvasProps) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const hoveredMeshRef = useRef<THREE.Mesh | null>(null);
  const cameraStateRef = useRef<{ position: THREE.Vector3; target: THREE.Vector3 } | null>(null);
  const lastItemClickRef = useRef<{
    key: string;
    time: number;
    x: number;
    y: number;
  } | null>(null);
  const [itemColors, setItemColors] = useState<Map<string, number> | null>(null);
  const [itemColorError, setItemColorError] = useState<Error | null>(null);
  const colorTargets = useMemo(() => renderableItemColorTargets(inventory), [inventory]);
  const colorTargetsKey = useMemo(() => colorTargets.map((target) => [
    target.itemId,
    target.imageId,
    target.boundingBox.x,
    target.boundingBox.y,
    target.boundingBox.width,
    target.boundingBox.height,
  ].join(":")).join("|"), [colorTargets]);
  const imageDataUrlsKey = useMemo(() => Object.keys(imageDataUrls).sort().join("|"), [imageDataUrls]);
  const sceneItems = useMemo(
    () => itemColors && colorTargets.every((target) => itemColors.has(target.itemId))
      ? buildSceneItems(inventory, itemColors)
      : [],
    [colorTargets, inventory, itemColors],
  );

  if (itemColorError) {
    throw itemColorError;
  }

  useEffect(() => {
    let cancelled = false;

    setItemColorError(null);

    if (colorTargets.length === 0) {
      setItemColors(new Map());
      return () => {
        cancelled = true;
      };
    }

    void calculateItemWireframeColors(colorTargets, imageDataUrls)
      .then((colors) => {
        if (!cancelled) {
          setItemColors(colors);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setItemColorError(error instanceof Error ? error : new Error(String(error)));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [colorTargetsKey, imageDataUrlsKey]);

  useEffect(() => {
    const mount = mountRef.current;

    if (!mount) {
      return;
    }

    const container = mount;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf4f6f2);

    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
    const cameraState = cameraStateRef.current;
    camera.position.copy(
      cameraState?.position ?? new THREE.Vector3(5.5, 3.8, 8.5),
    );

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: "high-performance",
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0xf4f6f2, 1);
    container.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.target.copy(cameraState?.target ?? new THREE.Vector3(0, 0, 0));
    controls.enablePan = false;
    controls.minZoom = 0.65;
    controls.maxZoom = 2.8;
    controls.update();

    const ambient = new THREE.AmbientLight(0xffffff, 1.8);
    scene.add(ambient);

    const keyLight = new THREE.DirectionalLight(0xffffff, 2.1);
    keyLight.position.set(4, 6, 8);
    scene.add(keyLight);

    const group = new THREE.Group();
    scene.add(group);

    const disposableObjects: THREE.Object3D[] = [];

    const zoneMeshes: THREE.Mesh[] = [];
    const itemMeshes: THREE.Mesh[] = [];
    const previewZoneByItemId = new Map(previewPlacements.map((placement) => [placement.itemId, placement.zoneId]));

    for (const zone of inventory.zones) {
      const box = zone.boundingBox;
      const zoneWidth = box.width * SCENE_WIDTH;
      const zoneHeight =
        zone.type === "drawer" || zone.type === "freezer" || zone.type === "pantry"
          ? box.height * SCENE_HEIGHT
          : SHELF_THICKNESS;
      const zoneX = imageXToWorld(box.x + box.width / 2);
      const zoneY =
        zone.type === "drawer" || zone.type === "freezer" || zone.type === "pantry"
          ? imageYToWorld(box.y + box.height / 2)
          : zoneSurfaceY(zone);
      const zoneZBounds = zoneWorldZBounds(zone);
      const zoneZ = (zoneZBounds.back + zoneZBounds.front) / 2;
      const zoneFrame = createWireframeBox(
        zoneWidth,
        zoneHeight,
        zoneZBounds.front - zoneZBounds.back,
        ZONE_WIREFRAME_COLOR,
        0.92,
      );
      zoneFrame.position.set(zoneX, zoneY, zoneZ);
      zoneFrame.userData = {
        targetType: "zone",
        zone,
        baseColor: ZONE_WIREFRAME_COLOR,
        baseOpacity: 0.92,
      };
      zoneMeshes.push(zoneFrame);
      group.add(zoneFrame);
      disposableObjects.push(zoneFrame);

      if (zone.type === "shelf" || zone.type === "door_shelf") {
        const clearanceHeight = zoneClearanceHeight(zone, inventory.zones);
        const clearanceFrame = createWireframeBox(
          zoneWidth,
          clearanceHeight,
          zoneZBounds.front - zoneZBounds.back,
          ZONE_CLEARANCE_WIREFRAME_COLOR,
          0.28,
        );
        clearanceFrame.position.set(
          zoneX,
          zoneSurfaceY(zone) + clearanceHeight / 2,
          zoneZ,
        );
        group.add(clearanceFrame);
        disposableObjects.push(clearanceFrame);
      }
    }

    for (const sceneItem of sceneItems) {
      const previewZone = inventory.zones.find((zone) => zone.id === previewZoneByItemId.get(sceneItem.item.id));
      const previewPosition = previewZone ? {
        x: imageXToWorld(previewZone.boundingBox.x + previewZone.boundingBox.width / 2),
        y: zoneSurfaceY(previewZone) + sceneItem.height / 2,
        z: 0,
      } : null;
      const position = previewPosition ?? { x: sceneItem.x, y: sceneItem.y, z: sceneItem.z };
      const footprintBoxGeometry = new THREE.BoxGeometry(
        sceneItem.width,
        0.012,
        sceneItem.depth,
      );
      const footprintGeometry = new THREE.EdgesGeometry(footprintBoxGeometry);
      footprintBoxGeometry.dispose();
      const footprintFrame = new THREE.LineSegments(
        footprintGeometry,
        new THREE.LineBasicMaterial({
          color: sceneItem.color,
          transparent: true,
          opacity: 0.42,
        }),
      );
      footprintFrame.position.set(position.x, position.y - sceneItem.height / 2 + 0.008, position.z);
      group.add(footprintFrame);
      disposableObjects.push(footprintFrame);

      const geometry = createItemGeometry(sceneItem);
      const focused = workspaceFocus?.itemIds.includes(sceneItem.item.id) ?? false;
      const shouldDim = workspaceFocus?.emphasis === "isolate" && !focused;
      const material = createWireframeMaterial(
        sceneItem.color,
        shouldDim ? 0.2 : focused ? 1 : 0.96,
      );
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(position.x, position.y, position.z);
      mesh.userData = {
        targetType: "item",
        item: sceneItem.item,
        baseColor: sceneItem.color,
        baseOpacity: shouldDim ? 0.2 : focused ? 1 : 0.96,
        renderedVolume: sceneItem.width * sceneItem.height * sceneItem.depth,
      };
      itemMeshes.push(mesh);
      group.add(mesh);
      disposableObjects.push(mesh);

      if (focused) {
        const outline = createFocusedOutline(geometry, 0x111827);
        outline.position.copy(mesh.position);
        group.add(outline);
        disposableObjects.push(outline);
      }
    }

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();

    function resetHoveredMesh() {
      if (hoveredMeshRef.current) {
        const mesh = hoveredMeshRef.current;
        const material = mesh.material as THREE.MeshBasicMaterial;
        material.color.setHex(mesh.userData.baseColor);
        material.opacity = mesh.userData.baseOpacity;
        material.transparent = material.opacity < 1;

        hoveredMeshRef.current = null;
      }
    }

    function handlePointerMove(event: PointerEvent) {
      const bounds = renderer.domElement.getBoundingClientRect();
      pointer.x = ((event.clientX - bounds.left) / bounds.width) * 2 - 1;
      pointer.y = -((event.clientY - bounds.top) / bounds.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const itemHit = selectSmallestItemHit(raycaster.intersectObjects(itemMeshes, false));
      const [zoneHit] = raycaster.intersectObjects(zoneMeshes, false);
      const hit = itemHit ?? zoneHit;

      if (!hit?.object) {
        resetHoveredMesh();
        onHoverItem?.(null);
        return;
      }

      const mesh = hit.object as THREE.Mesh;

      if (hoveredMeshRef.current !== mesh) {
        resetHoveredMesh();
        hoveredMeshRef.current = mesh;
        const material = mesh.material as THREE.MeshBasicMaterial;

        if (mesh.userData.targetType === "zone") {
          material.color.setHex(0x111827);
          material.opacity = 1;
          material.transparent = false;
        } else {
          material.color.setHex(0x111827);
        }
      }

      if (mesh.userData.targetType === "zone") {
        onHoverItem?.(null);
      } else {
        const item = mesh.userData.item as InventoryItem;
        onHoverItem?.(item.id);
      }
    }

    function handlePointerLeave() {
      resetHoveredMesh();
      onHoverItem?.(null);
    }

    function handleClick(event: MouseEvent) {
      const bounds = renderer.domElement.getBoundingClientRect();
      pointer.x = ((event.clientX - bounds.left) / bounds.width) * 2 - 1;
      pointer.y = -((event.clientY - bounds.top) / bounds.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const itemHit = selectSmallestItemHit(raycaster.intersectObjects(itemMeshes, false));
      const [zoneHit] = raycaster.intersectObjects(zoneMeshes, false);
      const target = itemHit?.object ?? zoneHit?.object;
      if (!target) {
        lastItemClickRef.current = null;
        onClearSelection?.();
        return;
      }
      if (target.userData.targetType === "item") {
        const item = target.userData.item as InventoryItem;
        const observation = item.loc.observations[0];
        const clickKey = observation
          ? [
            item.id,
            observation.imageId,
            observation.boundingBox.x,
            observation.boundingBox.y,
            observation.boundingBox.width,
            observation.boundingBox.height,
          ].join(":")
          : item.id;
        const now = window.performance.now();
        const previousClick = lastItemClickRef.current;
        const sameRenderedItem = previousClick?.key === clickKey;
        const closeInTime = previousClick ? now - previousClick.time <= 500 : false;
        const closeInSpace = previousClick
          ? Math.hypot(previousClick.x - event.clientX, previousClick.y - event.clientY) <= 10
          : false;

        if (event.detail >= 2 || (sameRenderedItem && closeInTime && closeInSpace)) {
          lastItemClickRef.current = null;
          onSeedItem?.(item);
          return;
        }

        lastItemClickRef.current = {
          key: clickKey,
          time: now,
          x: event.clientX,
          y: event.clientY,
        };
        onSelectItem?.(item.id);
      } else {
        lastItemClickRef.current = null;
        onSelectZone?.((target.userData.zone as InventoryZone).id);
      }
    }

    function resize() {
      const bounds = container.getBoundingClientRect();
      const width = Math.max(1, Math.floor(bounds.width));
      const height = Math.max(1, Math.floor(bounds.height));
      const aspect = width / height;
      const frustumWidth = CAMERA_FRUSTUM_HEIGHT * aspect;

      camera.left = -frustumWidth / 2;
      camera.right = frustumWidth / 2;
      camera.top = CAMERA_FRUSTUM_HEIGHT / 2;
      camera.bottom = -CAMERA_FRUSTUM_HEIGHT / 2;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height, false);
      renderer.render(scene, camera);
    }

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(container);
    renderer.domElement.addEventListener("pointermove", handlePointerMove);
    renderer.domElement.addEventListener("pointerleave", handlePointerLeave);
    renderer.domElement.addEventListener("click", handleClick);
    resize();

    let animationFrame = 0;

    function render() {
      animationFrame = window.requestAnimationFrame(render);
      controls.update();
      renderer.render(scene, camera);
    }

    render();

    return () => {
      cameraStateRef.current = {
        position: camera.position.clone(),
        target: controls.target.clone(),
      };
      window.cancelAnimationFrame(animationFrame);
      renderer.domElement.removeEventListener("pointermove", handlePointerMove);
      renderer.domElement.removeEventListener("pointerleave", handlePointerLeave);
      renderer.domElement.removeEventListener("click", handleClick);
      resizeObserver.disconnect();
      controls.dispose();
      container.removeChild(renderer.domElement);

      for (const object of disposableObjects) {
        disposeObject(object);
      }

      renderer.dispose();
    };
  }, [inventory, onClearSelection, onHoverItem, onSeedItem, onSelectItem, onSelectZone, previewPlacements, sceneItems, workspaceFocus]);

  return (
    <section className="fridge-canvas-panel" aria-label="Reconciled inventory">
      <div className="fridge-canvas" ref={mountRef} />
    </section>
  );
}
