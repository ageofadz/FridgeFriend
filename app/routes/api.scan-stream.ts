import type { ActionFunctionArgs } from "react-router";

import {
  createFridgeImage,
  getFridgeImage,
  parseStorageImageLocation,
} from "../server/images.server";
import { createScanStreamResponse } from "../server/scan/stream-response.server";
import { jsonError } from "../server/http.server";

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return jsonError(`Unsupported method ${request.method}`, 405);
  }

  try {
    const formData = await request.formData();
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

      if (!baseImage || baseImage.storageLocation !== "fridge") {
        throw new Error(`Cannot extend ${storageLocation} inventory because selected fridge image ${baseImageId} was not found`);
      }
    }

    const image = createFridgeImage({
      dataUrl,
      originalName: typeof originalName === "string" ? originalName : null,
      storageLocation,
      baseImageId: storageLocation === "fridge" ? null : baseImageId as string,
    });

    return createScanStreamResponse({
      fridgeId: "default-fridge",
      image,
      storageLocation,
      baseImageId: storageLocation === "fridge" ? null : baseImageId as string,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return jsonError(message, 400);
  }
}
