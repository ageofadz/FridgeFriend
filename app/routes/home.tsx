import { useEffect, useMemo, useRef, useState } from "react";
import {
  redirect,
  useActionData,
  useLoaderData,
  useNavigate,
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
  coerceInventoryStorageLocation,
  getFridgeInventoryForImage,
  inventoryWithoutStorageLocation,
  mergeStorageInventory,
  saveFridgeInventory,
} from "../server/inventories.server";
import {
  persistScanForFridgeImageInBackground,
  runScanForStorageImage,
} from "../server/scan/index.server";
import type { Inventory, RawDetection } from "../server/scan/schemas/inventory";
import { AgentWorkspace } from "../components/AgentWorkspace";
import { readScanStream } from "../components/scan-stream";
import {
  listStructuredMemoryContext,
  listUserSemanticMemories,
  resetUserProfileMemories,
} from "../server/memory/repository.server";
import { STORAGE_IMAGE_LOCATIONS } from "../workspace/contracts";
import { getOrCreateLatestChat } from "../server/chat/repository.server";
import type { PersistedChat } from "../chat/contracts";

type UploadActionData =
  | {
    type: "invalid-storage-image";
    reason: string;
  }
  | {
    type: "scan-failed";
    reason: string;
    storageLocation: StorageImageLocation;
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

type LocationImages = Partial<Record<StorageImageLocation, FridgeImage>>;

type StreamedScan = {
  image: FridgeImage;
  storageLocation: StorageImageLocation;
  rawDetections: RawDetection[] | null;
  transitionRawDetections: RawDetection[];
  awaitingRawDetections: boolean;
};

const HOME_REDIRECT_URL = "http://localhost:5173/";

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

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const requestedImageId = url.searchParams.get("imageId");
  const shouldShowUpload = url.searchParams.get("upload") === "1";
  const images = listFridgeImages();
  const requestedImage =
    requestedImageId !== null ? getFridgeImage(requestedImageId) : null;

  if (
    requestedImageId !== null &&
    (!requestedImage || imageStorageLocation(requestedImage) !== "fridge")
  ) {
    return redirect(HOME_REDIRECT_URL);
  }

  const selectedImage =
    shouldShowUpload
      ? null
      : requestedImage
      ? requestedImage
      : (images.find((image) => imageStorageLocation(image) === "fridge") ?? null);
  const locationImages = buildLocationImages(images, selectedImage);
  const selectedInventory = selectedImage
    ? getFridgeInventoryForImage(selectedImage.id)
    : null;
  const memoryContext = listStructuredMemoryContext({
    userId: "default-user",
    fridgeId: "default-fridge",
  });
  const chat = getOrCreateLatestChat({
    userId: "default-user",
    fridgeId: "default-fridge",
    imageId: selectedImage?.id ?? null,
  });

  return {
    images,
    selectedImage,
    locationImages,
    selectedInventory,
    externalInventory: memoryContext.externalInventory,
    dietaryRestrictions: memoryContext.dietaryRestrictions,
    dietaryPreferences: memoryContext.dietaryPreferences,
    activeGoals: memoryContext.activeGoals,
    semanticMemories: listUserSemanticMemories({
      userId: "default-user",
      fridgeId: "default-fridge",
    }),
    chat,
  };
}

export async function action({ request }: ActionFunctionArgs) {
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "reset-user-profile") {
    resetUserProfileMemories({
      userId: "default-user",
      fridgeId: "default-fridge",
    });

    return redirect(HOME_REDIRECT_URL);
  }

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
    for (const childImage of childImages) {
      deleteFridgeImage(childImage.id);
    }

    deleteFridgeImage(imageId);

    if (selectedImageId !== imageId && selectedImageId !== null) {
      return redirect(`/?imageId=${encodeURIComponent(selectedImageId)}`);
    }

    return redirect("/?upload=1");
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
    return {
      type: "scan-failed",
      reason: scanResult.error?.message ?? "Scan ended without reconciled inventory",
      storageLocation,
    } satisfies UploadActionData;
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
  const {
    selectedImage,
    selectedInventory,
    externalInventory,
    dietaryRestrictions,
    dietaryPreferences,
    activeGoals,
    semanticMemories,
    locationImages,
    chat,
  } = useLoaderData<{
    images: FridgeImage[];
    selectedImage: FridgeImage | null;
    locationImages: LocationImages;
    selectedInventory: Inventory | null;
    externalInventory: Awaited<ReturnType<typeof listStructuredMemoryContext>>["externalInventory"];
    dietaryRestrictions: Awaited<ReturnType<typeof listStructuredMemoryContext>>["dietaryRestrictions"];
    dietaryPreferences: Awaited<ReturnType<typeof listStructuredMemoryContext>>["dietaryPreferences"];
    activeGoals: Awaited<ReturnType<typeof listStructuredMemoryContext>>["activeGoals"];
    semanticMemories: ReturnType<typeof listUserSemanticMemories>;
    chat: PersistedChat;
  }>();
  const actionData = useActionData<UploadActionData>();
  const navigate = useNavigate();
  const submit = useSubmit();
  const [reconciledInventory, setReconciledInventory] =
    useState<Inventory | null>(selectedInventory);
  const [inventoryFinalizationId, setInventoryFinalizationId] = useState(0);
  const [streamedScan, setStreamedScan] = useState<StreamedScan | null>(null);
  const [deletingImageId, setDeletingImageId] = useState<string | null>(null);
  const [uploadingStorageLocation, setUploadingStorageLocation] =
    useState<StorageImageLocation | null>(null);
  const [scanProgressNodes, setScanProgressNodes] = useState<string[]>([]);
  const finalizedImageIdRef = useRef<string | null>(null);
  const [uploadErrors, setUploadErrors] = useState<
    Partial<Record<StorageImageLocation, string>>
  >({});
  const [isValidationModalDismissed, setIsValidationModalDismissed] =
    useState(false);
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
  const activeLocationImages = useMemo(() => {
    if (!streamedScan) {
      return locationImages;
    }

    return {
      ...locationImages,
      [streamedScan.storageLocation]: streamedScan.image,
    };
  }, [locationImages, streamedScan]);
  const activeImage = streamedScan?.storageLocation === "fridge"
    ? streamedScan.image
    : selectedImage;
  const visibleLocationImages = useMemo(() => {
    if (!deletingImageId) {
      return activeLocationImages;
    }

    if (activeLocationImages.fridge?.id === deletingImageId) {
      return {};
    }

    return Object.fromEntries(
      Object.entries(activeLocationImages).filter(
        ([, image]) => image.id !== deletingImageId,
      ),
    ) as LocationImages;
  }, [activeLocationImages, deletingImageId]);
  const visibleActiveImage = activeImage?.id === deletingImageId
    ? null
    : activeImage;

  useEffect(() => {
    setReconciledInventory(selectedInventory);
  }, [selectedImage?.id, selectedInventory]);

  useEffect(() => {
    setIsValidationModalDismissed(false);

    if (actionData?.type === "scan-complete") {
      setReconciledInventory(actionData.inventory);
      setInventoryFinalizationId((current) => current + 1);
      void navigate(`/?imageId=${encodeURIComponent(actionData.imageId)}`);
      return;
    }

    if (actionData?.type === "scan-failed") {
      setUploadErrors((errors) => ({
        ...errors,
        [actionData.storageLocation]: actionData.reason,
      }));
    }
  }, [actionData, navigate]);

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
    finalizedImageIdRef.current = null;
    setUploadingStorageLocation(storageLocation);
    setScanProgressNodes([]);

    try {
      const dataUrl = await encodeFileAsJpegDataUrl(file);
      const formData = new FormData();
      formData.set("dataUrl", dataUrl);
      formData.set("originalName", file.name);
      formData.set("storageLocation", storageLocation);
      if (selectedImage) {
        formData.set("baseImageId", selectedImage.id);
      }
      const response = await fetch("/api/scan-stream", {
        method: "POST",
        headers: { Accept: "application/x-ndjson" },
        body: formData,
      });
      let streamedImage: FridgeImage | null = null;
      let rawDetections: RawDetection[] = [];
      let completed = false;
      let terminalError: string | null = null;

      await readScanStream(response, (streamEvent) => {
        if (streamEvent.type === "image_created") {
          streamedImage = {
            ...streamEvent.image,
            dataUrl,
          };
          setStreamedScan({
            image: streamedImage,
            storageLocation,
            rawDetections: [],
            transitionRawDetections: [],
            awaitingRawDetections: true,
          });
          return;
        }

        if (streamEvent.type === "status") {
          setScanProgressNodes((nodes) =>
            nodes.includes(streamEvent.node)
              ? nodes
              : [...nodes, streamEvent.node],
          );
          return;
        }

        if (streamEvent.type === "raw_detections") {
          if (!streamedImage) {
            throw new Error("Scan stream emitted raw detections before creating an image");
          }

          rawDetections = streamEvent.rawDetections;
          setStreamedScan({
            image: streamedImage,
            storageLocation,
            rawDetections,
            transitionRawDetections: rawDetections,
            awaitingRawDetections: false,
          });
          return;
        }

        if (streamEvent.type === "invalid_storage_image") {
          terminalError = streamEvent.reason;
          setStreamedScan(null);
          return;
        }

        if (streamEvent.type === "error") {
          terminalError = streamEvent.error;
          setStreamedScan(null);
          return;
        }

        if (!streamedImage) {
          throw new Error("Scan stream completed before creating an image");
        }

        completed = true;
        setReconciledInventory(streamEvent.inventory);
        setStreamedScan({
          image: streamedImage,
          storageLocation,
          rawDetections: null,
          transitionRawDetections: rawDetections,
          awaitingRawDetections: false,
        });
        setInventoryFinalizationId((current) => current + 1);
        if (rawDetections.length === 0) {
          void navigate(`/?imageId=${encodeURIComponent(streamEvent.imageId)}`);
        } else {
          finalizedImageIdRef.current = streamEvent.imageId;
        }
      });

      if (terminalError) {
        throw new Error(terminalError);
      }

      if (!completed) {
        throw new Error("Scan stream ended before returning finalized inventory");
      }
    } catch (error) {
      setUploadErrors((errors) => ({
        ...errors,
        [storageLocation]: error instanceof Error ? error.message : String(error),
      }));
    } finally {
      setUploadingStorageLocation(null);
      setScanProgressNodes([]);
      input.value = "";
    }
  }

  function handleDeleteImage(imageId: string) {
    setDeletingImageId(imageId);
    setStreamedScan(null);
    setReconciledInventory(null);
    const formData = new FormData();
    formData.set("intent", "delete-image");
    formData.set("imageId", imageId);
    void submit(formData, { method: "post" });
  }

  function handleResetUserProfile() {
    const formData = new FormData();
    formData.set("intent", "reset-user-profile");
    void submit(formData, { method: "post" });
  }

  function handleInventoryFinalized() {
    const imageId = finalizedImageIdRef.current;

    if (!imageId) {
      return;
    }

    finalizedImageIdRef.current = null;
    void navigate(`/?imageId=${encodeURIComponent(imageId)}`);
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
        initialChat={chat}
            dietaryPreferences={dietaryPreferences}
            dietaryRestrictions={dietaryRestrictions}
            activeGoals={activeGoals}
            externalInventory={externalInventory}
            fridgeId="default-fridge"
            imageId={visibleActiveImage?.id ?? null}
            inventoryFinalizationId={inventoryFinalizationId}
            inventory={reconciledInventory ?? emptyInventory()}
            isInventorySceneLoading={streamedScan?.awaitingRawDetections ?? false}
            key={visibleActiveImage?.id ?? "empty-fridge-workspace"}
            locationImages={visibleLocationImages}
            onDeleteImage={handleDeleteImage}
            onInventoryUpdated={setReconciledInventory}
            onInventoryFinalized={handleInventoryFinalized}
            onResetUserProfile={handleResetUserProfile}
            onUploadImage={handleImageChange}
            semanticMemories={semanticMemories}
            streamedRawDetections={streamedScan?.rawDetections ?? []}
            streamedStorageLocation={streamedScan?.storageLocation ?? null}
            transitionRawDetections={streamedScan?.transitionRawDetections ?? []}
            uploadStatusByLocation={uploadStatusByLocation}
          />
        </section>
      </div>
    </main>
  );
}
