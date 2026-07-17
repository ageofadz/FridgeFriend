import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from "react";

import type { FridgeImage, StorageImageLocation } from "../server/images.server";
import type { ExternalInventoryMemory } from "../server/memory/schemas";
import type {
  Inventory,
  InventoryItem,
  NormalizedBoundingBox,
} from "../server/scan/schemas/inventory";
import {
  emptyWorkspaceFocus,
  focusFromWorkspaceAction,
  inventorySeedCropId,
  type AgentActivityEvent,
  type ConversationContextSeededItem,
  type WorkspaceAction,
  type WorkspaceFocus,
} from "../workspace/contracts";
import { FridgeInventoryCanvas } from "./FridgeInventoryCanvas";
import { FridgeQueryChat } from "./FridgeQueryChat";

type AgentWorkspaceProps = {
  fridgeId: string;
  imageId: string | null;
  locationImages: Partial<Record<StorageImageLocation, FridgeImage>>;
  inventory: Inventory;
  externalInventory: ExternalInventoryMemory[];
  uploadStatusByLocation: Record<StorageImageLocation, {
    isUploading: boolean;
    error: string | null;
    scanProgressNodes: readonly string[];
  }>;
  onDeleteImage(imageId: string): void;
  onInventoryUpdated(inventory: Inventory): void;
  onUploadImage(event: ChangeEvent<HTMLInputElement>, storageLocation: StorageImageLocation): void;
};

type DraftRequest = { id: string; text: string };
type WorkspaceLocation = StorageImageLocation | "all_inventory";
type AllInventoryStorageFilter = "all" | StorageImageLocation;
type PhotoMetrics = {
  left: number;
  top: number;
  width: number;
  height: number;
};
type DrawState = {
  start: { x: number; y: number };
  current: { x: number; y: number };
};
type SeedBoundingBoxResponse = {
  status: "known_item" | "created_item";
  cropId: string;
  item: InventoryItem;
  inventory: Inventory;
  draftText: string;
};
const STORAGE_IMAGE_LOCATIONS = ["fridge", "freezer", "pantry"] as const;

const CATEGORY_LABELS: Record<InventoryItem["cat"], string> = {
  produce: "Produce",
  dairy: "Dairy",
  meat: "Meat",
  seafood: "Seafood",
  eggs: "Eggs",
  prepared_food: "Prepared Food",
  beverage: "Beverage",
  condiment: "Condiment",
  leftovers: "Leftovers",
  other: "Other",
};

function activeItem(items: InventoryItem[], itemIds: string[]) {
  return items.find((item) => itemIds.includes(item.id)) ?? null;
}

function itemPrompt(item: InventoryItem, action: "quantity" | "recipe" | "correct" | "consume") {
  if (action === "quantity") return `How much of ${item.label} is left?`;
  if (action === "recipe") return `What can I make with ${item.label}?`;
  if (action === "correct") return `Correct ${item.label}: `;
  return `Mark ${item.label} as consumed.`;
}

function formatQuantity(item: InventoryItem) {
  const quantity = item.qty;
  if (quantity.fillLevel !== null) return `${Math.round(quantity.fillLevel * 100)}% full`;
  if (quantity.amount !== null) return `${quantity.amount} ${quantity.unit}`;
  return "Quantity unknown";
}

function formatExternalQuantity(item: ExternalInventoryMemory) {
  if (!item.quantity) return "Quantity unknown";
  if (item.quantity.amount === null) return item.quantity.unit;
  return `${item.quantity.amount} ${item.quantity.unit}`;
}

function clampUnit(value: number) {
  return Math.min(Math.max(value, 0), 1);
}

function normalizedDrawBox(drawState: DrawState): NormalizedBoundingBox | null {
  const left = Math.min(drawState.start.x, drawState.current.x);
  const top = Math.min(drawState.start.y, drawState.current.y);
  const right = Math.max(drawState.start.x, drawState.current.x);
  const bottom = Math.max(drawState.start.y, drawState.current.y);
  const width = right - left;
  const height = bottom - top;

  if (width < 0.01 || height < 0.01) {
    return null;
  }

  return {
    x: left,
    y: top,
    width,
    height,
  };
}

function inventoryObservationBox(
  item: InventoryItem | null,
  imageId: string | null,
) {
  if (!item || !imageId) {
    return null;
  }

  return item.loc.observations.find((observation) =>
    observation.imageId === imageId
  )?.boundingBox ?? null;
}

function boxContainsPoint(
  box: NormalizedBoundingBox,
  point: { x: number; y: number },
) {
  return point.x >= box.x &&
    point.x <= box.x + box.width &&
    point.y >= box.y &&
    point.y <= box.y + box.height;
}

function inventoryItemAtPoint(
  items: InventoryItem[],
  imageId: string,
  point: { x: number; y: number },
) {
  return items
    .flatMap((item) =>
      item.loc.observations
        .filter((observation) =>
          observation.imageId === imageId &&
          boxContainsPoint(observation.boundingBox, point)
        )
        .map((observation) => ({
          item,
          area: observation.boundingBox.width * observation.boundingBox.height,
        }))
    )
    .sort((left, right) => left.area - right.area)[0]?.item ?? null;
}

function capitalizeItemName(name: string) {
  return name.replace(/\b\p{L}/gu, (letter) => letter.toUpperCase());
}

function normalizeRecipeIngredient(value: string) {
  return value
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function singularizeTerm(value: string) {
  if (value.endsWith("ies") && value.length > 3) {
    return `${value.slice(0, -3)}y`;
  }

  if (value.endsWith("s") && !value.endsWith("ss") && value.length > 2) {
    return value.slice(0, -1);
  }

  return value;
}

function stripPackageWords(value: string) {
  return normalizeRecipeIngredient(value)
    .split(" ")
    .filter((word) => !new Set([
      "bag",
      "bottle",
      "box",
      "can",
      "carton",
      "container",
      "cup",
      "jar",
      "pack",
      "package",
      "packet",
      "tray",
      "tub",
    ]).has(word))
    .map(singularizeTerm)
    .join(" ")
    .trim();
}

function ingredientVariants(value: string) {
  const normalized = stripPackageWords(value);
  return [...new Set([
    normalized,
    singularizeTerm(normalized),
  ].filter(Boolean))];
}

function wholeIngredientMatch(left: string, right: string) {
  if (!left || !right) return false;
  if (left === right) return true;
  return left.startsWith(`${right} `) ||
    left.endsWith(` ${right}`) ||
    right.startsWith(`${left} `) ||
    right.endsWith(` ${left}`);
}

function recipeIngredientItemMatchRank(ingredient: string, item: InventoryItem) {
  const ingredientValues = ingredientVariants(ingredient);
  const subcategoryValues = item.subcat ? ingredientVariants(item.subcat) : [];

  if (subcategoryValues.length > 0) {
    if (
      ingredientValues.some((ingredientValue) =>
        subcategoryValues.some((subcategoryValue) => ingredientValue === subcategoryValue)
      )
    ) {
      return 2;
    }

    if (
      ingredientValues.some((ingredientValue) =>
        subcategoryValues.some((subcategoryValue) =>
          wholeIngredientMatch(ingredientValue, subcategoryValue)
        )
      )
    ) {
      return 1;
    }

    return 0;
  }

  const itemValues = [
    ...ingredientVariants(item.name),
    ...ingredientVariants(item.label),
  ];

  if (
    ingredientValues.some((ingredientValue) =>
      itemValues.some((itemValue) => ingredientValue === itemValue)
    )
  ) {
    return 2;
  }

  return ingredientValues.some((ingredientValue) =>
    itemValues.some((itemValue) => wholeIngredientMatch(ingredientValue, itemValue))
  ) ? 1 : 0;
}

export function AgentWorkspace({
  fridgeId,
  imageId,
  locationImages,
  inventory,
  externalInventory,
  uploadStatusByLocation,
  onDeleteImage,
  onInventoryUpdated,
  onUploadImage,
}: AgentWorkspaceProps) {
  const [mobilePane, setMobilePane] = useState<"chat" | "inventory">("chat");
  const [location, setLocation] = useState<WorkspaceLocation>("fridge");
  const [focus, setFocus] = useState<WorkspaceFocus>(emptyWorkspaceFocus);
  const [selection, setSelection] = useState<{ itemIds: string[]; source: "agent" | "user" }>({ itemIds: [], source: "agent" });
  const [activities, setActivities] = useState<AgentActivityEvent[]>([]);
  const [placements, setPlacements] = useState<Array<{ itemId: string; zoneId: string }>>([]);
  const [draftRequest, setDraftRequest] = useState<DraftRequest | null>(null);
  const [seededItems, setSeededItems] = useState<ConversationContextSeededItem[]>([]);
  const [allInventoryCategory, setAllInventoryCategory] = useState<"all" | InventoryItem["cat"]>("all");
  const [allInventoryStorage, setAllInventoryStorage] = useState<AllInventoryStorageFilter>("all");
  const [allInventoryZone, setAllInventoryZone] = useState("all");
  const [hoveredItemId, setHoveredItemId] = useState<string | null>(null);
  const [hoveredRecipeItemIds, setHoveredRecipeItemIds] = useState<string[] | null>(null);
  const [isDrawMode, setIsDrawMode] = useState(false);
  const [drawState, setDrawState] = useState<DrawState | null>(null);
  const [bboxToolError, setBboxToolError] = useState<string | null>(null);
  const [bboxToolStatus, setBboxToolStatus] = useState<"ready" | "saving">("ready");
  const [seededLabels, setSeededLabels] = useState<Record<string, string>>({});
  const photoRef = useRef<HTMLDivElement | null>(null);
  const photoImageRef = useRef<HTMLImageElement | null>(null);
  const [photoMetrics, setPhotoMetrics] = useState<PhotoMetrics | null>(null);

  const visibleExternal = useMemo(() => externalInventory.filter((item) => {
    if (location === "all_inventory") return true;
    return item.storageLocation === location;
  }), [externalInventory, location]);
  const currentImage = location === "all_inventory" ? null : locationImages[location] ?? null;
  const imageDataUrls = useMemo(() => Object.fromEntries(
    Object.values(locationImages).map((image) => [image.id, image.dataUrl]),
  ), [locationImages]);
  const zoneById = useMemo(() => new Map(inventory.zones.map((zone) => [zone.id, zone])), [inventory.zones]);
  const zoneOptions = useMemo(() => {
    const zones = inventory.zones.filter((zone) => inventory.items.some((item) => item.loc.zoneId === zone.id));
    return zones.sort((left, right) => left.label.localeCompare(right.label));
  }, [inventory.items, inventory.zones]);
  const hasUnassignedItems = inventory.items.some((item) => item.loc.zoneId === null);
  const filteredInventoryItems = useMemo(() => inventory.items.filter((item) => {
    if (allInventoryCategory !== "all" && item.cat !== allInventoryCategory) return false;
    if (allInventoryStorage !== "all" && locationForObservedItem(item) !== allInventoryStorage) return false;
    if (allInventoryZone === "unassigned" && item.loc.zoneId !== null) return false;
    if (allInventoryZone !== "all" && allInventoryZone !== "unassigned" && item.loc.zoneId !== allInventoryZone) return false;
    return true;
  }), [allInventoryCategory, allInventoryStorage, allInventoryZone, inventory.items, locationImages]);
  const filteredExternalInventory = useMemo(() => visibleExternal.filter((item) => {
    if (allInventoryCategory !== "all" || allInventoryZone !== "all") return false;
    if (allInventoryStorage === "all") return true;
    return item.storageLocation === allInventoryStorage;
  }), [allInventoryCategory, allInventoryStorage, allInventoryZone, visibleExternal]);

  const updatePhotoMetrics = useCallback(() => {
    const photo = photoRef.current;
    const image = photoImageRef.current;

    if (!photo || !image || image.naturalWidth <= 0 || image.naturalHeight <= 0) {
      setPhotoMetrics(null);
      return;
    }

    const rect = photo.getBoundingClientRect();
    const containerRatio = rect.width / Math.max(rect.height, 1);
    const imageRatio = image.naturalWidth / image.naturalHeight;
    const width = containerRatio > imageRatio
      ? rect.height * imageRatio
      : rect.width;
    const height = containerRatio > imageRatio
      ? rect.height
      : rect.width / imageRatio;

    setPhotoMetrics({
      left: (rect.width - width) / 2,
      top: (rect.height - height) / 2,
      width,
      height,
    });
  }, []);

  useEffect(() => {
    updatePhotoMetrics();

    const photo = photoRef.current;

    if (!photo) {
      return;
    }

    const observer = new ResizeObserver(updatePhotoMetrics);
    observer.observe(photo);

    return () => observer.disconnect();
  }, [currentImage?.id, updatePhotoMetrics]);

  const selectItem = useCallback((itemId: string) => {
    setSelection({ itemIds: [itemId], source: "user" });
    setFocus({ mode: "item", itemIds: [itemId], zoneIds: [], recipeId: null, emphasis: "highlight", reason: null });
  }, []);

  const clearSelection = useCallback(() => {
    setSelection({ itemIds: [], source: "user" });
    setFocus(emptyWorkspaceFocus());
  }, []);

  const selectZone = useCallback((zoneId: string) => {
    setSelection({ itemIds: [], source: "user" });
    setFocus({ mode: "zone", itemIds: [], zoneIds: [zoneId], recipeId: null, emphasis: "highlight", reason: null });
  }, []);

  const hoverItem = useCallback((itemId: string | null) => {
    setHoveredItemId(itemId);
  }, []);

  const hoverRecipeIngredients = useCallback((ingredients: string[] | null) => {
    if (!ingredients) {
      setHoveredRecipeItemIds(null);
      return;
    }

    const itemIds = ingredients.flatMap((ingredient) => {
      const rankedItems = inventory.items
        .map((item) => ({
          item,
          rank: recipeIngredientItemMatchRank(ingredient, item),
        }))
        .filter((candidate) => candidate.rank > 0);
      const bestRank = Math.max(0, ...rankedItems.map((candidate) => candidate.rank));

      return rankedItems
        .filter((candidate) => candidate.rank === bestRank)
        .map((candidate) => candidate.item.id);
    });

    setHoveredRecipeItemIds([...new Set(itemIds)]);
  }, [inventory.items]);

  function photoPointFromPointer(event: React.PointerEvent<HTMLDivElement>) {
    const photo = photoRef.current;

    if (!photo || !photoMetrics) {
      return null;
    }

    const rect = photo.getBoundingClientRect();
    const x = (event.clientX - rect.left - photoMetrics.left) /
      Math.max(photoMetrics.width, 1);
    const y = (event.clientY - rect.top - photoMetrics.top) /
      Math.max(photoMetrics.height, 1);

    return {
      x: clampUnit(x),
      y: clampUnit(y),
    };
  }

  function boxStyle(box: NormalizedBoundingBox) {
    if (!photoMetrics) {
      return undefined;
    }

    return {
      left: `${photoMetrics.left + box.x * photoMetrics.width}px`,
      top: `${photoMetrics.top + box.y * photoMetrics.height}px`,
      width: `${box.width * photoMetrics.width}px`,
      height: `${box.height * photoMetrics.height}px`,
    };
  }

  async function seedBoundingBox(boundingBox: NormalizedBoundingBox) {
    if (!currentImage) {
      throw new Error(`Cannot seed bounding box because there is no ${location} image selected`);
    }

    setBboxToolStatus("saving");
    setBboxToolError(null);

    try {
      const response = await fetch("/api/seed-bbox", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          imageId: currentImage.id,
          boundingBox,
        }),
      });
      const payload = await response.json() as SeedBoundingBoxResponse | { error?: string };

      if (!response.ok) {
        throw new Error("error" in payload && payload.error ? payload.error : `Seed bounding box request failed with HTTP ${response.status}`);
      }

      if (
        !("cropId" in payload) ||
        !("item" in payload) ||
        !("inventory" in payload) ||
        !("draftText" in payload)
      ) {
        throw new Error("Seed bounding box response is missing required inventory context");
      }

      const seed = {
        itemId: payload.item.id,
        imageId: currentImage.id,
        cropId: payload.cropId,
        userSeeded: true,
      } satisfies ConversationContextSeededItem;

      onInventoryUpdated(payload.inventory);
      setSeededLabels((current) => ({
        ...current,
        [payload.cropId]: payload.item.label,
      }));
      setSeededItems((current) =>
        current.some((candidate) => candidate.cropId === seed.cropId)
          ? current
          : [...current, seed]
      );
      setSelection({ itemIds: [payload.item.id], source: "user" });
      setFocus({ mode: "item", itemIds: [payload.item.id], zoneIds: [], recipeId: null, emphasis: "highlight", reason: null });
      setDraftRequest({ id: crypto.randomUUID(), text: payload.draftText });
    } catch (error) {
      setBboxToolError(error instanceof Error ? error.message : String(error));
    } finally {
      setBboxToolStatus("ready");
    }
  }

  function handlePhotoPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (!currentImage || bboxToolStatus === "saving") {
      return;
    }

    const point = photoPointFromPointer(event);

    if (!point) {
      return;
    }

    if (!isDrawMode) {
      const item = inventoryItemAtPoint(shownInventory.items, currentImage.id, point);

      if (item) {
        selectItem(item.id);
      } else {
        clearSelection();
      }

      return;
    }

    event.currentTarget.setPointerCapture(event.pointerId);
    setBboxToolError(null);
    setDrawState({ start: point, current: point });
  }

  function handlePhotoPointerMove(event: React.PointerEvent<HTMLDivElement>) {
    if (!isDrawMode) {
      if (!currentImage) {
        setHoveredItemId(null);
        return;
      }

      const point = photoPointFromPointer(event);
      const item = point
        ? inventoryItemAtPoint(shownInventory.items, currentImage.id, point)
        : null;

      setHoveredItemId(item?.id ?? null);
      return;
    }

    if (!drawState) {
      return;
    }

    const point = photoPointFromPointer(event);

    if (!point) {
      return;
    }

    setDrawState((current) =>
      current ? { ...current, current: point } : current
    );
  }

  function handlePhotoPointerUp(event: React.PointerEvent<HTMLDivElement>) {
    if (!drawState || !isDrawMode) {
      return;
    }

    const nextBox = normalizedDrawBox(drawState);
    setDrawState(null);

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    if (!nextBox) {
      setBboxToolError("Drawn bounding box is too small to seed into chat context");
      return;
    }

    void seedBoundingBox(nextBox);
  }

  function handlePhotoPointerLeave() {
    if (!isDrawMode) {
      setHoveredItemId(null);
    }
  }

  function itemObservedInLocation(item: InventoryItem, candidate: StorageImageLocation) {
    const image = locationImages[candidate];

    if (!image) {
      return false;
    }

    return item.loc.observations.some((observation) => observation.imageId === image.id);
  }

  function zoneObservedInLocation(zone: Inventory["zones"][number], candidate: StorageImageLocation) {
    const image = locationImages[candidate];

    if (!image) {
      return false;
    }

    return zone.imageIds.includes(image.id);
  }

  const seedInventoryItem = useCallback((item: InventoryItem) => {
    if (!currentImage) {
      throw new Error(`Cannot seed chat context because there is no ${location} image selected`);
    }

    const observation = item.loc.observations.find((candidate) =>
      candidate.imageId === currentImage.id
    );

    if (!observation) {
      throw new Error(`Cannot seed chat context because item ${item.id} has no observation for image ${currentImage.id}`);
    }

    const sourceItem = inventory.items.find((candidate) =>
      candidate.id === item.id &&
      candidate.loc.observations.some((candidateObservation) =>
        candidateObservation.imageId === observation.imageId &&
        candidateObservation.boundingBox.x === observation.boundingBox.x &&
        candidateObservation.boundingBox.y === observation.boundingBox.y &&
        candidateObservation.boundingBox.width === observation.boundingBox.width &&
        candidateObservation.boundingBox.height === observation.boundingBox.height
      )
    );

    if (!sourceItem) {
      throw new Error(`Cannot seed chat context because item ${item.id} could not be matched back to source inventory for image ${currentImage.id}`);
    }

    const observationIndex = sourceItem.loc.observations.findIndex((candidateObservation) =>
      candidateObservation.imageId === observation.imageId &&
      candidateObservation.boundingBox.x === observation.boundingBox.x &&
      candidateObservation.boundingBox.y === observation.boundingBox.y &&
      candidateObservation.boundingBox.width === observation.boundingBox.width &&
      candidateObservation.boundingBox.height === observation.boundingBox.height
    );

    if (observationIndex < 0) {
      throw new Error(`Cannot seed chat context because source observation for item ${item.id} was not found for image ${currentImage.id}`);
    }

    const seed = {
      itemId: sourceItem.id,
      imageId: observation.imageId,
      cropId: inventorySeedCropId({
        imageId: observation.imageId,
        itemId: sourceItem.id,
        observationIndex,
      }),
      userSeeded: true,
    } satisfies ConversationContextSeededItem;

    setSeededItems((current) =>
      current.some((candidate) => candidate.cropId === seed.cropId)
        ? current
        : [...current, seed]
    );
  }, [currentImage, inventory.items, location]);

  function applyAction(action: WorkspaceAction) {
    if (action.type === "show_evidence") {
      return;
    }
    if (action.type === "preview_reorganization") {
      setPlacements(action.placements);
    }
    if (action.type === "reset_view") {
      setFocus(emptyWorkspaceFocus());
      setPlacements([]);
      setSelection({ itemIds: [], source: "agent" });
      return;
    }
    const nextFocus = focusFromWorkspaceAction(action);
    setFocus(nextFocus);
    if (nextFocus.itemIds.length > 0) {
      setSelection({ itemIds: nextFocus.itemIds, source: "agent" });
    }
  }

  function onQueryStarted() {
    setActivities([]);
    setPlacements([]);
    setSelection({ itemIds: [], source: "agent" });
    setHoveredRecipeItemIds(null);
    setFocus(emptyWorkspaceFocus());
  }

  function seedItemAction(action: "quantity" | "recipe" | "correct" | "consume") {
    if (!selectedItem) return;
    seedInventoryItem(selectedItem);
    setDraftRequest({ id: crypto.randomUUID(), text: itemPrompt(selectedItem, action) });
  }

  const conversationContext = {
    selectedItemIds: selection.itemIds,
    selectedZoneIds: focus.zoneIds,
    selectedRecipeId: focus.recipeId,
    seededItems,
  };
  const seededItemLabels = {
    ...Object.fromEntries(
      inventory.items.flatMap((item) =>
        item.loc.observations.map((observation, observationIndex) => [
          inventorySeedCropId({
            imageId: observation.imageId,
            itemId: item.id,
            observationIndex,
          }),
          item.label,
        ] as const)
      ),
    ),
    ...seededLabels,
  };

  const shownInventory = useMemo(() => {
    if (location === "all_inventory") {
      return inventory;
    }

    return {
      ...inventory,
      items: inventory.items.flatMap((item) => {
        const image = locationImages[location];

        if (!image) {
          return [];
        }

        const observations = item.loc.observations.filter((observation) =>
          observation.imageId === image.id
        );

        if (observations.length === 0) {
          return [];
        }

        return [{
          ...item,
          loc: {
            ...item.loc,
            observations,
          },
        }];
      }),
      zones: inventory.zones.filter((zone) => zoneObservedInLocation(zone, location)),
    };
  }, [inventory, location, locationImages]);
  const selectedItem = activeItem(shownInventory.items, selection.itemIds.length > 0 ? selection.itemIds : focus.itemIds);
  const hoveredItem = hoveredItemId
    ? shownInventory.items.find((item) => item.id === hoveredItemId) ?? null
    : null;
  const selectedPhotoBox = inventoryObservationBox(selectedItem, currentImage?.id ?? null);
  const hoveredPhotoBox = inventoryObservationBox(hoveredItem, currentImage?.id ?? null);
  const drawingPhotoBox = drawState ? normalizedDrawBox(drawState) : null;
  const activeHoverItemIds = hoveredItemId ? [hoveredItemId] : [];
  const focusedItemIds = [...new Set([...focus.itemIds, ...activeHoverItemIds])];
  const workspaceFocus = hoveredRecipeItemIds && hoveredRecipeItemIds.length > 0
    ? {
      mode: "recipe" as const,
      itemIds: hoveredRecipeItemIds,
      zoneIds: [],
      recipeId: null,
      emphasis: "candidate" as const,
      reason: null,
    }
    : focusedItemIds.length > 0
      ? {
        mode: "item" as const,
        itemIds: focusedItemIds,
        zoneIds: focus.zoneIds,
        recipeId: focus.recipeId,
        emphasis: "highlight" as const,
        reason: focus.reason,
      }
    : focus;

  function locationForObservedItem(item: InventoryItem): WorkspaceLocation {
    for (const candidate of STORAGE_IMAGE_LOCATIONS) {
      if (itemObservedInLocation(item, candidate)) {
        return candidate;
      }
    }

    throw new Error(`Cannot determine storage location for inventory item ${item.id} because none of its observations match the loaded location images`);
  }

  function locationLabel(candidate: StorageImageLocation) {
    return candidate[0].toUpperCase() + candidate.slice(1);
  }

  function allInventoryLocationLabel(item: InventoryItem) {
    return locationLabel(locationForObservedItem(item) as StorageImageLocation);
  }

  return (
    <section className="agent-workspace" aria-label="FridgeFriend agent workspace">
      <nav className="mobile-workspace-tabs" aria-label="Mobile workspace">
        <button className={mobilePane === "chat" ? "workspace-tab workspace-tab--active" : "workspace-tab"} onClick={() => setMobilePane("chat")} type="button">Chat</button>
        <button className={mobilePane === "inventory" ? "workspace-tab workspace-tab--active" : "workspace-tab"} onClick={() => setMobilePane("inventory")} type="button">Inventory</button>
      </nav>
      <div className={`agent-workspace-chat agent-workspace-pane--${mobilePane}`}>
        <FridgeQueryChat
          conversationContext={conversationContext}
          draftRequest={draftRequest}
          fridgeId={fridgeId}
          imageId={imageId}
          onAgentEvent={(event) => setActivities((current) => [...current.slice(-3), event])}
          onClearSeededItems={() => setSeededItems([])}
          onQueryStarted={onQueryStarted}
          onRecipeIngredientHover={hoverRecipeIngredients}
          onRemoveSeededItem={(cropId) => setSeededItems((current) => current.filter((item) => item.cropId !== cropId))}
          onWorkspaceAction={applyAction}
          seededItemLabels={seededItemLabels}
          seededItems={seededItems}
        />
      </div>
      <section className={`agent-workspace-visual agent-workspace-pane--${mobilePane}`} aria-label="Visual workspace">
        <header className="visual-workspace-toolbar">
          <div className="workspace-switcher" aria-label="Inventory location">
            {(["fridge", "freezer", "pantry", "all_inventory"] as const).map((candidate) => (
              <button className={location === candidate ? "workspace-tab workspace-tab--active" : "workspace-tab"} key={candidate} onClick={() => setLocation(candidate)} type="button">
                {candidate === "all_inventory" ? "All Inventory" : candidate[0].toUpperCase() + candidate.slice(1)}
              </button>
            ))}
          </div>
          <div className="workspace-toolbar-actions">
            {currentImage ? (
              <button aria-label={`Delete ${location} image`} className="workspace-delete" onClick={() => onDeleteImage(currentImage.id)} type="button">
                <svg aria-hidden="true" fill="none" height="18" viewBox="0 0 24 24" width="18">
                  <path d="M3 6h18" stroke="currentColor" strokeLinecap="round" strokeWidth="2" />
                  <path d="M8 6V4h8v2" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
                  <path d="M6 6l1 15h10l1-15" stroke="currentColor" strokeLinejoin="round" strokeWidth="2" />
                  <path d="M10 10v7M14 10v7" stroke="currentColor" strokeLinecap="round" strokeWidth="2" />
                </svg>
              </button>
            ) : null}
          </div>
        </header>
        {location !== "all_inventory" ? (
          <>
            <p className="workspace-breadcrumb">{locationLabel(location)} overview{focus.zoneIds.length > 0 ? ` › ${focus.zoneIds.join(", ")}` : ""}{selectedItem ? ` › ${selectedItem.label}` : ""}</p>
            <div className="workspace-viewport workspace-viewport--compare">
              <FridgeInventoryCanvas
                imageDataUrls={imageDataUrls}
                inventory={shownInventory}
                onClearSelection={clearSelection}
                onHoverItem={hoverItem}
                onSeedItem={seedInventoryItem}
                onSelectItem={selectItem}
                onSelectZone={selectZone}
                previewPlacements={placements}
                workspaceFocus={workspaceFocus}
              />
              <div
                className={isDrawMode ? "workspace-photo workspace-photo--drawing" : "workspace-photo"}
                onPointerDown={handlePhotoPointerDown}
                onPointerLeave={handlePhotoPointerLeave}
                onPointerMove={handlePhotoPointerMove}
                onPointerUp={handlePhotoPointerUp}
                ref={photoRef}
              >
                {currentImage ? (
                  <>
                    <div
                      className="workspace-photo-tools"
                      onPointerDown={(event) => event.stopPropagation()}
                      onPointerMove={(event) => event.stopPropagation()}
                      onPointerUp={(event) => event.stopPropagation()}
                      role="tablist"
                      aria-label="Image tools"
                    >
                      <button
                        aria-label="Select item"
                        aria-selected={!isDrawMode}
                        className={!isDrawMode ? "workspace-photo-tool workspace-photo-tool--active" : "workspace-photo-tool"}
                        disabled={bboxToolStatus === "saving"}
                        onClick={() => {
                          setIsDrawMode(false);
                          setDrawState(null);
                          setBboxToolError(null);
                        }}
                        role="tab"
                        type="button"
                      >
                        <svg aria-hidden="true" fill="none" height="16" viewBox="0 0 24 24" width="16">
                          <path d="M6 3l11 11-5 1.2 3.4 4.8-2.3 1.5-3.2-4.7-3.9 3.3V3z" fill="currentColor" />
                        </svg>
                      </button>
                      <button
                        aria-label="Draw bounding box"
                        aria-selected={isDrawMode}
                        className={isDrawMode ? "workspace-photo-tool workspace-photo-tool--active" : "workspace-photo-tool"}
                        disabled={bboxToolStatus === "saving"}
                        onClick={() => {
                          setIsDrawMode(true);
                          setHoveredItemId(null);
                          setDrawState(null);
                          setBboxToolError(null);
                        }}
                        role="tab"
                        type="button"
                      >
                        <svg aria-hidden="true" fill="none" height="16" viewBox="0 0 24 24" width="16">
                          <path d="M12 5v14M5 12h14" stroke="currentColor" strokeLinecap="round" strokeWidth="2.4" />
                        </svg>
                      </button>
                    </div>
                    <img
                      alt={currentImage.originalName ?? `${locationLabel(location)} image`}
                      onLoad={updatePhotoMetrics}
                      ref={photoImageRef}
                      src={currentImage.dataUrl}
                    />
                    {selectedPhotoBox && photoMetrics ? (
                      <span
                        aria-hidden="true"
                        className="workspace-photo-box workspace-photo-box--selected"
                        style={boxStyle(selectedPhotoBox)}
                      />
                    ) : null}
                    {hoveredPhotoBox && photoMetrics ? (
                      <span
                        aria-hidden="true"
                        className="workspace-photo-box workspace-photo-box--hover"
                        style={boxStyle(hoveredPhotoBox)}
                      />
                    ) : null}
                    {drawingPhotoBox && photoMetrics ? (
                      <span
                        aria-hidden="true"
                        className="workspace-photo-box workspace-photo-box--drawing"
                        style={boxStyle(drawingPhotoBox)}
                      />
                    ) : null}
                    {bboxToolStatus === "saving" ? (
                      <span className="workspace-photo-status" role="status">Inspecting selection...</span>
                    ) : null}
                    {bboxToolError ? (
                      <span className="workspace-photo-error" role="alert">{bboxToolError}</span>
                    ) : null}
                  </>
                ) : (
                  <label className="workspace-upload-target" htmlFor={`${location}-image`}>
                    <span>{`Upload ${location} image`}</span>
                    <input
                      id={`${location}-image`}
                      type="file"
                      accept="image/*"
                      capture="environment"
                      disabled={uploadStatusByLocation[location].isUploading}
                      onChange={(event) => onUploadImage(event, location)}
                    />
                    <span
                      aria-hidden={uploadStatusByLocation[location].isUploading ? undefined : true}
                      className={
                        uploadStatusByLocation[location].isUploading
                          ? "workspace-upload-progress"
                          : "workspace-upload-progress workspace-upload-progress--hidden"
                      }
                      role={uploadStatusByLocation[location].isUploading ? "status" : undefined}
                    >
                      {uploadStatusByLocation[location].scanProgressNodes.map((node) => (
                        <span key={node}>{node}</span>
                      ))}
                    </span>
                    {uploadStatusByLocation[location].error ? <span className="workspace-upload-error">{uploadStatusByLocation[location].error}</span> : null}
                  </label>
                )}
              </div>
              {activities.length > 0 ? (
                <div className="workspace-activity" aria-live="polite">
                  {activities.map((event, index) => <p key={`${event.type}-${index}`}>{event.type === "enrichment_started" ? `Inspecting ${event.itemId}` : event.type === "enrichment_completed" ? `Updated ${event.itemId}` : event.type === "enrichment_failed" ? event.error : event.question}</p>)}
                </div>
              ) : null}
            </div>
            <aside className="workspace-inspector" aria-live="polite">
              {selectedItem ? (
                <>
                  <div className="workspace-inspector-heading"><h2>{selectedItem.label}</h2></div>
                  <p>{formatQuantity(selectedItem)}</p>
                  <p>Observed in {selectedItem.loc.zoneId ?? "an unassigned location"} · {Math.round(selectedItem.conf * 100)}% confidence</p>
                  <div className="workspace-item-actions">
                    <button onClick={() => seedItemAction("quantity")} type="button">How much is left?</button>
                    <button onClick={() => seedItemAction("recipe")} type="button">What can I make with this?</button>
                    <button onClick={() => seedItemAction("correct")} type="button">Get more detail about this item</button>
                    <button onClick={() => seedItemAction("consume")} type="button">I already used this</button>
                  </div>
                </>
              ) : hoveredItem ? (
                <div className="workspace-inspector-heading"><h2>{capitalizeItemName(hoveredItem.name)}</h2></div>
              ) : <p>Select an item to inspect. Double-click to add it to the chat.</p>}
            </aside>
          </>
        ) : (
          <div className="reported-inventory-panel">
            <div className="reported-inventory-filters" aria-label="All inventory filters">
              <label className="inventory-filter-field">
                <span>Category</span>
                <select value={allInventoryCategory} onChange={(event) => setAllInventoryCategory(event.currentTarget.value as "all" | InventoryItem["cat"])}>
                  <option value="all">All categories</option>
                  {Object.entries(CATEGORY_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
              </label>
              <label className="inventory-filter-field">
                <span>Location</span>
                <select value={allInventoryStorage} onChange={(event) => setAllInventoryStorage(event.currentTarget.value as AllInventoryStorageFilter)}>
                  <option value="all">Fridge, pantry, freezer</option>
                  <option value="fridge">Fridge</option>
                  <option value="pantry">Pantry</option>
                  <option value="freezer">Freezer</option>
                </select>
              </label>
              <label className="inventory-filter-field">
                <span>Zone</span>
                <select value={allInventoryZone} onChange={(event) => setAllInventoryZone(event.currentTarget.value)}>
                  <option value="all">All zones</option>
                  {zoneOptions.map((zone) => <option key={zone.id} value={zone.id}>{zone.label}</option>)}
                  {hasUnassignedItems ? <option value="unassigned">Unassigned</option> : null}
                </select>
              </label>
              <p className="reported-inventory-count">{filteredInventoryItems.length + filteredExternalInventory.length} items</p>
            </div>
            <div className="reported-inventory-list">
              {filteredInventoryItems.map((item) => {
                const zone = item.loc.zoneId ? zoneById.get(item.loc.zoneId) : null;
                return (
                  <button className="reported-inventory-item reported-inventory-item--observed" key={item.id} onClick={() => { selectItem(item.id); setLocation(locationForObservedItem(item)); }} type="button">
                    <span className="reported-inventory-main">
                      <span className="reported-inventory-name">{item.label}</span>
                      <span className="reported-inventory-meta">{CATEGORY_LABELS[item.cat]} · {allInventoryLocationLabel(item)} · {zone?.label ?? "Unassigned zone"}</span>
                    </span>
                    <span className="reported-inventory-quantity">{formatQuantity(item)}</span>
                  </button>
                );
              })}
              {filteredExternalInventory.map((item) => (
                <button className="reported-inventory-item" key={item.id} onClick={() => setDraftRequest({ id: crypto.randomUUID(), text: `Tell me about ${item.name} in my ${item.storageLocation}.` })} type="button">
                  <span className="reported-inventory-main">
                    <span className="reported-inventory-name">{item.name}</span>
                    <span className="reported-inventory-meta">User reported · {item.storageLocation}</span>
                  </span>
                  <span className="reported-inventory-quantity">{formatExternalQuantity(item)}</span>
                </button>
              ))}
              {filteredInventoryItems.length === 0 && filteredExternalInventory.length === 0 ? <p className="reported-inventory-empty">No inventory items match these filters.</p> : null}
            </div>
          </div>
        )}
      </section>
    </section>
  );
}
