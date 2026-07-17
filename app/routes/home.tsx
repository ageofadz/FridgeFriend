import { useEffect, useState } from "react";
import {
  redirect,
  useActionData,
  useLoaderData,
  useNavigate,
  useNavigation,
  useSubmit,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";

import {
  createFridgeImage,
  deleteFridgeImage,
  getFridgeImage,
  listFridgeImages,
  parseStorageImageLocation,
  type FridgeImage,
  type StorageImageLocation,
} from "../server/images.server";
import {
  getFridgeInventoryForImage,
  saveFridgeInventory,
} from "../server/inventories.server";
import {
  persistScanForFridgeImageInBackground,
  runScanForStorageImage,
} from "../server/scan/index.server";
import type { Inventory, RawDetection } from "../server/scan/schemas/inventory";
import { AgentWorkspace } from "../components/AgentWorkspace";
import { listStructuredMemoryContext } from "../server/memory/repository.server";

type UploadActionData =
  | {
    type: "invalid-storage-image";
    reason: string;
  }
  | {
    type: "scan-complete";
    imageId: string;
    rawDetections: RawDetection[];
    detectionModelRawOutput: unknown;
    detectionValidation: {
      valid: boolean;
      reason?: string;
    } | null;
    inventory: Inventory;
  }
  | undefined;

const SCAN_PROGRESS_STAGES = [
  ["validate_images"],
  ["start_scan_analysis"],
  ["detect_inventory", "map_zones"],
  ["reconcile_locations"],
  ["adjudicate_locations"],
  ["reconcile_inventory"],
] as const;
const SCAN_PROGRESS_STAGE_MS = 3000;
const STORAGE_IMAGE_LOCATIONS = ["fridge", "freezer", "pantry"] as const;

type LocationImages = Partial<Record<StorageImageLocation, FridgeImage>>;

function emptyInventory(): Inventory {
  const createdAt = new Date().toISOString();

  return {
    id: "empty-inventory",
    fridgeId: "default-fridge",
    scanId: "empty-scan",
    source: "mocked-vision",
    model: "none",
    createdAt,
    items: [],
    zones: [],
  };
}

function imageStorageLocation(image: FridgeImage) {
  return parseStorageImageLocation(image.storageLocation);
}

function buildLocationImages(
  images: FridgeImage[],
  selectedImage: FridgeImage | null,
): LocationImages {
  if (!selectedImage) {
    return {};
  }

  return Object.fromEntries(
    STORAGE_IMAGE_LOCATIONS.map((location) => [
      location,
      location === "fridge"
        ? selectedImage
        : images.find(
          (image) =>
            imageStorageLocation(image) === location &&
            image.baseImageId === selectedImage.id,
        ) ?? null,
    ]).filter((entry): entry is [StorageImageLocation, FridgeImage] => entry[1] !== null),
  );
}

function storageLocationLabel(storageLocation: StorageImageLocation) {
  return storageLocation[0].toUpperCase() + storageLocation.slice(1);
}

function coerceInventoryStorageLocation(
  inventory: Inventory,
  storageLocation: StorageImageLocation,
) {
  if (storageLocation === "fridge") {
    return inventory;
  }

  const label = storageLocationLabel(storageLocation);

  return {
    ...inventory,
    zones: inventory.zones.map((zone, index) => ({
      ...zone,
      type: storageLocation,
      label: zone.label.toLowerCase().includes(storageLocation)
        ? zone.label
        : `${label} ${zone.label || `zone ${index + 1}`}`,
    })),
    items: inventory.items.map((item) => ({
      ...item,
      loc: {
        ...item.loc,
        zoneType: storageLocation,
      },
    })),
  } satisfies Inventory;
}

function inventoryWithoutStorageLocation(
  inventory: Inventory,
  storageLocation: StorageImageLocation,
) {
  if (storageLocation === "fridge") {
    return inventory;
  }

  const keptZoneIds = new Set(
    inventory.zones
      .filter((zone) => zone.type !== storageLocation)
      .map((zone) => zone.id),
  );

  return {
    ...inventory,
    items: inventory.items.filter((item) => item.loc.zoneType !== storageLocation),
    zones: inventory.zones.filter((zone) => keptZoneIds.has(zone.id)),
  } satisfies Inventory;
}

function mergeStorageInventory(
  baseInventory: Inventory,
  extensionInventory: Inventory,
  storageLocation: StorageImageLocation,
) {
  const baseWithoutLocation = inventoryWithoutStorageLocation(
    baseInventory,
    storageLocation,
  );

  return {
    ...baseWithoutLocation,
    scanId: `${baseInventory.scanId}:${storageLocation}:${extensionInventory.scanId}`,
    items: [
      ...baseWithoutLocation.items,
      ...extensionInventory.items,
    ],
    zones: [
      ...baseWithoutLocation.zones,
      ...extensionInventory.zones,
    ],
  } satisfies Inventory;
}

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const requestedImageId = url.searchParams.get("imageId");
  const images = listFridgeImages();
  const requestedImage =
    requestedImageId !== null ? getFridgeImage(requestedImageId) : null;
  const selectedImage =
    requestedImage && imageStorageLocation(requestedImage) === "fridge"
      ? requestedImage
      : (images.find((image) => imageStorageLocation(image) === "fridge") ?? null);
  const locationImages = buildLocationImages(images, selectedImage);
  const selectedInventory = selectedImage
    ? getFridgeInventoryForImage(selectedImage.id)
    : null;
  const externalInventory = listStructuredMemoryContext({
    userId: "default-user",
    fridgeId: "default-fridge",
  }).externalInventory;

  return {
    images,
    selectedImage,
    locationImages,
    selectedInventory,
    externalInventory,
  };
}

export async function action({ request }: ActionFunctionArgs) {
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "delete-image") {
    const imageId = formData.get("imageId");

    if (typeof imageId !== "string" || imageId.length === 0) {
      throw new Error("Missing image id");
    }

    const image = getFridgeImage(imageId);

    if (!image) {
      throw new Error(`Image ${imageId} was not found`);
    }

    const imageLocation = imageStorageLocation(image);

    if (imageLocation !== "fridge") {
      const baseImageId = image.baseImageId;

      deleteFridgeImage(imageId);

      if (baseImageId) {
        const baseInventory = getFridgeInventoryForImage(baseImageId);

        if (baseInventory) {
          saveFridgeInventory({
            imageId: baseImageId,
            inventory: inventoryWithoutStorageLocation(
              baseInventory,
              imageLocation,
            ),
          });
        }

        return redirect(`/?imageId=${encodeURIComponent(baseImageId)}`);
      }

      return redirect("/");
    }

    const url = new URL(request.url);
    const selectedImageId = url.searchParams.get("imageId");
    const imagesBeforeDelete = listFridgeImages();
    const childImages = imagesBeforeDelete.filter(
      (candidate) => candidate.baseImageId === imageId,
    );
    const remainingImages = imagesBeforeDelete.filter(
      (candidate) =>
        candidate.id !== imageId &&
        candidate.baseImageId !== imageId &&
        imageStorageLocation(candidate) === "fridge",
    );

    for (const childImage of childImages) {
      deleteFridgeImage(childImage.id);
    }

    deleteFridgeImage(imageId);

    if (selectedImageId !== imageId && selectedImageId !== null) {
      return redirect(`/?imageId=${encodeURIComponent(selectedImageId)}`);
    }

    const nextImage = remainingImages[0];
    return redirect(
      nextImage ? `/?imageId=${encodeURIComponent(nextImage.id)}` : "/",
    );
  }

  const dataUrl = formData.get("dataUrl");
  const originalName = formData.get("originalName");
  const storageLocation = parseStorageImageLocation(formData.get("storageLocation"));
  const baseImageId = formData.get("baseImageId");

  if (typeof dataUrl !== "string" || dataUrl.length === 0) {
    throw new Error("Missing image data");
  }

  if (storageLocation !== "fridge") {
    if (typeof baseImageId !== "string" || baseImageId.length === 0) {
      throw new Error(`Cannot extend ${storageLocation} inventory without a selected fridge image`);
    }

    const baseImage = getFridgeImage(baseImageId);

    if (!baseImage || imageStorageLocation(baseImage) !== "fridge") {
      throw new Error(`Cannot extend ${storageLocation} inventory because selected fridge image ${baseImageId} was not found`);
    }
  }

  const image = createFridgeImage({
    dataUrl,
    originalName: typeof originalName === "string" ? originalName : null,
    storageLocation,
    baseImageId: storageLocation === "fridge" ? null : baseImageId as string,
  });

  const scanResult = await runScanForStorageImage({
    fridgeId: "default-fridge",
    imageId: image.id,
    storageLocation,
  });

  if (scanResult.imageValidation?.valid === false) {
    deleteFridgeImage(image.id);
    return {
      type: "invalid-storage-image",
      reason:
        scanResult.imageValidation.reason ??
        scanResult.error?.message ??
        "Image validation failed",
    } satisfies UploadActionData;
  }

  if (!scanResult.inventory) {
    throw new Error(
      scanResult.error?.message ?? "Scan completed without reconciled inventory",
    );
  }

  const scannedInventory = coerceInventoryStorageLocation(
    scanResult.inventory,
    storageLocation,
  );
  const inventory = storageLocation === "fridge"
    ? saveFridgeInventory({
      imageId: image.id,
      inventory: scannedInventory,
    })
    : saveFridgeInventory({
      imageId: baseImageId as string,
      inventory: mergeStorageInventory(
        (() => {
          const baseInventory = getFridgeInventoryForImage(baseImageId as string);

          if (!baseInventory) {
            throw new Error(`Cannot extend ${storageLocation} inventory because inventory for selected fridge image ${baseImageId as string} was not found`);
          }

          return baseInventory;
        })(),
        scannedInventory,
        storageLocation,
      ),
    });

  if (storageLocation === "fridge") {
    persistScanForFridgeImageInBackground({
      fridgeId: "default-fridge",
      imageId: image.id,
      storageLocation,
      scanState: {
        ...scanResult,
        inventory,
      },
    });
  }

  return {
    type: "scan-complete",
    imageId: storageLocation === "fridge" ? image.id : baseImageId as string,
    rawDetections: scanResult.rawDetections,
    detectionModelRawOutput: scanResult.detectionModelRawOutput,
    detectionValidation: scanResult.detectionValidation,
    inventory,
  } satisfies UploadActionData;
}

async function encodeFileAsJpegDataUrl(file: File) {
  const imageUrl = URL.createObjectURL(file);

  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () =>
        reject(new Error(`Error loading image: ${file.name}`));
      element.src = imageUrl;
    });

    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;

    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("Error creating canvas");
    }

    context.drawImage(image, 0, 0);

    return canvas.toDataURL("image/jpeg", 0.8);
  } finally {
    URL.revokeObjectURL(imageUrl);
  }
}

export default function Home() {
  const { selectedImage, selectedInventory, externalInventory, locationImages } = useLoaderData<{
    images: FridgeImage[];
    selectedImage: FridgeImage | null;
    locationImages: LocationImages;
    selectedInventory: Inventory | null;
    externalInventory: Awaited<ReturnType<typeof listStructuredMemoryContext>>["externalInventory"];
  }>();
  const actionData = useActionData<UploadActionData>();
  const navigate = useNavigate();
  const submit = useSubmit();
  const navigation = useNavigation();
  const [reconciledInventory, setReconciledInventory] =
    useState<Inventory | null>(selectedInventory);
  const [uploadErrors, setUploadErrors] = useState<
    Partial<Record<StorageImageLocation, string>>
  >({});
  const [isValidationModalDismissed, setIsValidationModalDismissed] =
    useState(false);
  const [scanProgressStageIndex, setScanProgressStageIndex] = useState(0);
  const isUploading =
    navigation.state !== "idle" && navigation.formData?.has("dataUrl") === true;
  const uploadingStorageLocation = isUploading
    ? STORAGE_IMAGE_LOCATIONS.find(
      (location) => navigation.formData?.get("storageLocation") === location,
    ) ?? null
    : null;
  const scanProgressNodes =
    SCAN_PROGRESS_STAGES[
      Math.min(scanProgressStageIndex, SCAN_PROGRESS_STAGES.length - 1)
    ];
  const uploadStatusFor = (location: StorageImageLocation) => ({
    isUploading: uploadingStorageLocation === location,
    error: uploadErrors[location] ?? null,
    scanProgressNodes: uploadingStorageLocation === location
      ? scanProgressNodes
      : [],
  });
  const uploadStatusByLocation: Record<StorageImageLocation, {
    isUploading: boolean;
    error: string | null;
    scanProgressNodes: readonly string[];
  }> = {
    fridge: uploadStatusFor("fridge"),
    freezer: uploadStatusFor("freezer"),
    pantry: uploadStatusFor("pantry"),
  };
  const validationModal =
    actionData?.type === "invalid-storage-image" &&
      !isValidationModalDismissed
      ? actionData
      : null;

  useEffect(() => {
    setReconciledInventory(selectedInventory);
  }, [selectedImage?.id, selectedInventory]);

  useEffect(() => {
    setIsValidationModalDismissed(false);

    if (actionData?.type === "scan-complete") {
      setReconciledInventory(actionData.inventory);
      void navigate(`/?imageId=${encodeURIComponent(actionData.imageId)}`);
    }
  }, [actionData, navigate]);

  useEffect(() => {
    if (!isUploading) {
      setScanProgressStageIndex(0);
      return;
    }

    setScanProgressStageIndex(0);

    const intervalId = window.setInterval(() => {
      setScanProgressStageIndex((stageIndex) =>
        Math.min(stageIndex + 1, SCAN_PROGRESS_STAGES.length - 1),
      );
    }, SCAN_PROGRESS_STAGE_MS);

    return () => window.clearInterval(intervalId);
  }, [isUploading]);

  async function handleImageChange(
    event: React.ChangeEvent<HTMLInputElement>,
    storageLocation: StorageImageLocation = "fridge",
  ) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file) {
      return;
    }

    setUploadErrors((errors) => ({ ...errors, [storageLocation]: undefined }));

    try {
      const dataUrl = await encodeFileAsJpegDataUrl(file);
      const formData = new FormData();
      formData.set("dataUrl", dataUrl);
      formData.set("originalName", file.name);
      formData.set("storageLocation", storageLocation);
      if (selectedImage) {
        formData.set("baseImageId", selectedImage.id);
      }
      await submit(formData, { method: "post" });
    } catch (error) {
      setUploadErrors((errors) => ({
        ...errors,
        [storageLocation]: error instanceof Error ? error.message : String(error),
      }));
    } finally {
      input.value = "";
    }
  }

  function handleDeleteImage(imageId: string) {
    const formData = new FormData();
    formData.set("intent", "delete-image");
    formData.set("imageId", imageId);
    void submit(formData, { method: "post" });
  }

  return (
    <main className="page">
      <div className="shell">
        {validationModal ? (
          <div
            aria-labelledby="validation-modal-title"
            aria-modal="true"
            className="modal-backdrop"
            role="dialog"
          >
            <div className="modal">
              <h2 id="validation-modal-title">
                This image cannot be scanned as food storage
              </h2>
              <p>{validationModal.reason}</p>
              <button
                className="modal-close"
                onClick={() => setIsValidationModalDismissed(true)}
                type="button"
              >
                OK
              </button>
            </div>
          </div>
        ) : null}

        <section className="workspace" aria-label="Fridge image workspace">
          <AgentWorkspace
            externalInventory={externalInventory}
            fridgeId="default-fridge"
            imageId={selectedImage?.id ?? null}
            inventory={reconciledInventory ?? emptyInventory()}
            key={selectedImage?.id ?? "empty-fridge-workspace"}
            locationImages={locationImages}
            onDeleteImage={handleDeleteImage}
            onInventoryUpdated={setReconciledInventory}
            onUploadImage={handleImageChange}
            uploadStatusByLocation={uploadStatusByLocation}
          />
        </section>
      </div>
    </main>
  );
}
