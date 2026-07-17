import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

import {
  type Inventory,
  type InventoryItem,
  type RawDetection,
} from "../server/scan/schemas/inventory";
import type { WorkspaceFocus } from "../workspace/contracts";
import {
  dominantWeightedAverageColor,
  type VisualColorTarget,
} from "./item-wireframe-color";
import {
  buildInventoryPlacementLayout,
  buildImageGroundedPlacementLayout,
  imageXToWorld,
  imageYToWorld,
  SCENE_HEIGHT,
  SCENE_WIDTH,
  SHELF_THICKNESS,
  type InventoryZone,
  type ScenePlacement,
  zoneClearanceHeight,
  zoneSurfaceY,
  zoneWorldZBounds,
} from "./fridge-placement";

type FridgeInventoryCanvasProps = {
  finalizationId?: number;
  inventory: Inventory;
  imageDataUrls: Record<string, string>;
  isLoading?: boolean;
  loadingIndicator?: ReactNode;
  rawDetections?: RawDetection[];
  transitionRawDetections?: RawDetection[];
  workspaceFocus?: WorkspaceFocus;
  previewPlacements?: Array<{ itemId: string; zoneId: string }>;
  onSelectItem?(itemId: string): void;
  onSeedItem?(item: InventoryItem): void;
  onSelectZone?(zoneId: string): void;
  onClearSelection?(): void;
  onHoverItem?(itemId: string | null): void;
  onFinalizationComplete?(): void;
};

type SceneItem = {
  id: string;
  item: InventoryItem | null;
  pack: InventoryItem["pack"];
  imageId: string;
  boundingBox: InventoryItem["loc"]["observations"][number]["boundingBox"];
  x: number;
  y: number;
  z: number;
  width: number;
  height: number;
  depth: number;
  color: number;
};

type RenderedItemObjects = {
  mesh: THREE.Mesh;
  outline: THREE.Group;
};

const CAMERA_FRUSTUM_HEIGHT = 8.4;
const ZONE_WIREFRAME_COLOR = 0xd1d5db;
const ZONE_CLEARANCE_WIREFRAME_COLOR = 0xe5e7eb;
const FINALIZATION_MOVE_DURATION_MS = 520;

function createItemGeometry(sceneItem: SceneItem) {
  const { pack, width, height, depth } = sceneItem;

  if (pack === "bottle" || pack === "can") {
    const geometry = new THREE.CylinderGeometry(0.5, 0.5, height, 18, 1);
    geometry.scale(width, 1, depth);
    return geometry;
  }

  if (pack === "jar") {
    const geometry = new THREE.CylinderGeometry(0.5, 0.5, height, 16, 1);
    geometry.scale(width, 1, depth);
    return geometry;
  }

  if (pack === "loose") {
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

function renderableItemColorTargets(
  inventory: Inventory,
  rawDetections: RawDetection[],
): VisualColorTarget[] {
  const inventoryTargets = inventory.items.flatMap((item) => {
    const observation = item.loc.observations[0];

    if (!observation) {
      return [];
    }

    return [{
      itemId: item.id,
      imageId: observation.imageId,
      boundingBox: observation.boundingBox,
    }];
  });

  const rawTargets = rawDetections.map((detection) => ({
    itemId: detection.id,
    imageId: detection.img,
    boundingBox: detection.bbox,
  }));
  const targetsByItemId = new Map<string, VisualColorTarget>();

  for (const target of [...inventoryTargets, ...rawTargets]) {
    targetsByItemId.set(target.itemId, target);
  }

  return [...targetsByItemId.values()];
}

function finalSceneItem(
  placement: ScenePlacement,
  color: number,
): SceneItem {
  const observation = placement.item.loc.observations[0];

  if (!observation) {
    throw new Error(`Cannot render item ${placement.item.id} because it has no observation`);
  }

  return {
    id: placement.item.id,
    item: placement.item,
    pack: placement.item.pack,
    imageId: observation.imageId,
    boundingBox: observation.boundingBox,
    x: placement.x,
    y: placement.y,
    z: placement.z,
    width: placement.width,
    height: placement.height,
    depth: placement.depth,
    color,
  };
}

function applyWorkspaceFocus(
  renderedItems: Map<string, RenderedItemObjects>,
  workspaceFocus: WorkspaceFocus | undefined,
) {
  for (const [itemId, renderedItem] of renderedItems) {
    const focused = workspaceFocus?.itemIds.includes(itemId) ?? false;
    const shouldDim = workspaceFocus?.emphasis === "isolate" && !focused;
    const baseOpacity = shouldDim ? 0.2 : focused ? 1 : 0.96;
    const material = renderedItem.mesh.material as THREE.MeshBasicMaterial;

    renderedItem.mesh.userData.baseOpacity = baseOpacity;

    material.opacity = baseOpacity;
    material.transparent = baseOpacity < 1;

    renderedItem.outline.visible = focused;
  }
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
  finalizationId = 0,
  inventory,
  imageDataUrls,
  isLoading = false,
  loadingIndicator,
  rawDetections = [],
  transitionRawDetections = [],
  workspaceFocus,
  previewPlacements = [],
  onSelectItem,
  onSeedItem,
  onSelectZone,
  onClearSelection,
  onHoverItem,
  onFinalizationComplete,
}: FridgeInventoryCanvasProps) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const hoveredMeshRef = useRef<THREE.Mesh | null>(null);
  const cameraStateRef = useRef<{ position: THREE.Vector3; target: THREE.Vector3 } | null>(null);
  const renderedItemsRef = useRef<Map<string, RenderedItemObjects>>(new Map());
  const previousSceneItemsRef = useRef<Map<string, SceneItem>>(new Map());
  const playedFinalizationIdRef = useRef(0);
  const workspaceFocusRef = useRef(workspaceFocus);
  const callbacksRef = useRef({
    onSelectItem,
    onSeedItem,
    onSelectZone,
    onClearSelection,
    onHoverItem,
    onFinalizationComplete,
  });
  const lastItemClickRef = useRef<{
    key: string;
    time: number;
    x: number;
    y: number;
  } | null>(null);
  const [itemColors, setItemColors] = useState<Map<string, number> | null>(null);
  const [itemColorError, setItemColorError] = useState<Error | null>(null);
  callbacksRef.current = {
    onSelectItem,
    onSeedItem,
    onSelectZone,
    onClearSelection,
    onHoverItem,
    onFinalizationComplete,
  };
  workspaceFocusRef.current = workspaceFocus;
  const colorTargets = useMemo(
    () => renderableItemColorTargets(inventory, rawDetections),
    [inventory, rawDetections],
  );
  const colorTargetsKey = useMemo(() => colorTargets.map((target) => [
    target.itemId,
    target.imageId,
    target.boundingBox.x,
    target.boundingBox.y,
    target.boundingBox.width,
    target.boundingBox.height,
  ].join(":")).join("|"), [colorTargets]);
  const imageDataUrlsKey = useMemo(() => Object.keys(imageDataUrls).sort().join("|"), [imageDataUrls]);
  const sceneItems = useMemo(() => {
    if (!itemColors || !colorTargets.every((target) => itemColors.has(target.itemId))) {
      return [];
    }

    if (rawDetections.length > 0) return [];

    const directSupportZoneByItemId = new Map(
      previewPlacements.map((placement) => [placement.itemId, placement.zoneId]),
    );

    const placements = inventory.sceneVersion === "image-grounded-v2"
      ? buildImageGroundedPlacementLayout(inventory)
      : buildInventoryPlacementLayout(inventory, directSupportZoneByItemId);

    return placements.map((placement) => {
      const color = itemColors.get(placement.item.id);

      if (color === undefined) {
        throw new Error(`Cannot render item ${placement.item.id} because its wireframe color was not calculated`);
      }

      return finalSceneItem(placement, color);
    });
  }, [colorTargets, inventory, itemColors, previewPlacements, rawDetections]);
  const transitionOriginsByItemId = useMemo(() => {
    if (!itemColors || rawDetections.length > 0) {
      return new Map<string, SceneItem>();
    }

    return new Map<string, SceneItem>();
  }, [itemColors, rawDetections.length, transitionRawDetections]);
  const workspaceFocusKey = [
    workspaceFocus?.itemIds.join(",") ?? "",
    workspaceFocus?.emphasis ?? "",
  ].join(":");

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
    applyWorkspaceFocus(renderedItemsRef.current, workspaceFocusRef.current);
  }, [workspaceFocusKey]);

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
    const renderedItems = new Map<string, RenderedItemObjects>();
    const transitionTargets: Array<{
      object: THREE.Object3D;
      origin: THREE.Vector3;
      target: THREE.Vector3;
    }> = [];
    const visibleZones = rawDetections.length === 0 ? inventory.zones : [];
    const shouldTransition =
      rawDetections.length === 0 &&
      finalizationId > 0 &&
      playedFinalizationIdRef.current !== finalizationId;
    for (const zone of visibleZones) {
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
        const clearanceHeight = zoneClearanceHeight(zone, visibleZones);
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
      const position = { x: sceneItem.x, y: sceneItem.y, z: sceneItem.z };
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
      const material = createWireframeMaterial(sceneItem.color, 0.96);
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(position.x, position.y, position.z);
      mesh.userData = {
        targetType: sceneItem.item ? "item" : "raw_item",
        item: sceneItem.item,
        baseColor: sceneItem.color,
        baseOpacity: 0.96,
        renderedVolume: sceneItem.width * sceneItem.height * sceneItem.depth,
      };
      group.add(mesh);
      disposableObjects.push(mesh);

      if (sceneItem.item) {
        itemMeshes.push(mesh);
        const outline = createFocusedOutline(geometry, 0x111827);
        outline.position.copy(mesh.position);
        outline.visible = false;
        group.add(outline);
        disposableObjects.push(outline);
        renderedItems.set(sceneItem.id, { mesh, outline });

        const origin = shouldTransition
          ? transitionOriginsByItemId.get(sceneItem.id) ?? previousSceneItemsRef.current.get(sceneItem.id)
          : undefined;

        if (origin) {
          for (const object of [footprintFrame, mesh, outline]) {
            const target = object.position.clone();
            const originPosition = target.clone();
            originPosition.x = origin.x;
            originPosition.y += origin.y - sceneItem.y;
            originPosition.z = origin.z;
            object.position.copy(originPosition);
            transitionTargets.push({ object, origin: originPosition, target });
          }
        }
      }
    }

    renderedItemsRef.current = renderedItems;
    previousSceneItemsRef.current = new Map(sceneItems.map((sceneItem) => [sceneItem.id, sceneItem]));
    applyWorkspaceFocus(renderedItems, workspaceFocusRef.current);

    if (transitionTargets.length > 0) {
      playedFinalizationIdRef.current = finalizationId;
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
      const itemHit = selectSmallestItemHit(raycaster.intersectObjects(
        itemMeshes.filter((mesh) => mesh.visible),
        false,
      ));
      const [zoneHit] = raycaster.intersectObjects(zoneMeshes, false);
      const hit = itemHit ?? zoneHit;

      if (!hit?.object) {
        resetHoveredMesh();
        callbacksRef.current.onHoverItem?.(null);
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
        callbacksRef.current.onHoverItem?.(null);
      } else {
        const item = mesh.userData.item as InventoryItem;
        callbacksRef.current.onHoverItem?.(item.id);
      }
    }

    function handlePointerLeave() {
      resetHoveredMesh();
      callbacksRef.current.onHoverItem?.(null);
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
        callbacksRef.current.onClearSelection?.();
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
          callbacksRef.current.onSeedItem?.(item);
          return;
        }

        lastItemClickRef.current = {
          key: clickKey,
          time: now,
          x: event.clientX,
          y: event.clientY,
        };
        callbacksRef.current.onSelectItem?.(item.id);
      } else {
        lastItemClickRef.current = null;
        callbacksRef.current.onSelectZone?.((target.userData.zone as InventoryZone).id);
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
    let finalizationComplete = false;
    const finalizationStartedAt = transitionTargets.length > 0
      ? window.performance.now()
      : null;

    function render(timestamp: number) {
      animationFrame = window.requestAnimationFrame(render);

      if (finalizationStartedAt !== null) {
        const progress = Math.min(
          1,
          (timestamp - finalizationStartedAt) / FINALIZATION_MOVE_DURATION_MS,
        );
        const easedProgress = 1 - (1 - progress) ** 3;

        for (const transition of transitionTargets) {
          transition.object.position.lerpVectors(
            transition.origin,
            transition.target,
            easedProgress,
          );
        }

        if (progress === 1 && !finalizationComplete) {
          finalizationComplete = true;
          callbacksRef.current.onFinalizationComplete?.();
        }
      }

      controls.update();
      renderer.render(scene, camera);
    }

    render(window.performance.now());

    return () => {
      cameraStateRef.current = {
        position: camera.position.clone(),
        target: controls.target.clone(),
      };
      renderedItemsRef.current = new Map();
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
  }, [finalizationId, inventory, rawDetections.length, sceneItems, transitionOriginsByItemId]);

  return (
    <section
      aria-busy={isLoading}
      aria-label="Reconciled inventory"
      className="fridge-canvas-panel"
    >
      <div className="fridge-canvas" ref={mountRef} />
      {isLoading ? <div className="fridge-canvas-loading">{loadingIndicator}</div> : null}
    </section>
  );
}
