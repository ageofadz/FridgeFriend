import { decode as decodeJpeg } from "jpeg-js";

import { getFridgeImage } from "../../images.server";

const JPEG_DATA_URL_PREFIX = "data:image/jpeg;base64,";

function getJpegBytes(dataUrl: string, imageIndex: number) {
  if (!dataUrl.startsWith(JPEG_DATA_URL_PREFIX)) {
    throw new Error(`Image ${imageIndex + 1} must be a JPEG data URL`);
  }

  const bytes = Buffer.from(dataUrl.slice(JPEG_DATA_URL_PREFIX.length), "base64");

  try {
    decodeJpeg(bytes, { useTArray: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Image ${imageIndex + 1} is not loadable JPEG data: ${message}`,
    );
  }

  return bytes;
}

export function loadImageDataUrls(imageIds: string[]) {
  if (imageIds.length === 0) {
    throw new Error("At least one fridge image is required");
  }

  return imageIds.map((imageId, index) => {
    const image = getFridgeImage(imageId);

    if (!image) {
      throw new Error(`Image ${index + 1} not found in SQLite store: ${imageId}`);
    }

    return image.dataUrl;
  });
}

export function assertImagesAreLocallyLoadable(imageDataUrls: string[]) {
  imageDataUrls.forEach((image, index) => {
    getJpegBytes(image, index);
  });
}
