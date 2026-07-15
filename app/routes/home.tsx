import { useState } from "react";
import {
  Form,
  redirect,
  useLoaderData,
  useNavigation,
  useSubmit,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";

import {
  createFridgeImage,
  getFridgeImage,
  listFridgeImages,
  type FridgeImage,
} from "../server/images.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const requestedImageId = url.searchParams.get("imageId");
  const images = listFridgeImages();
  const selectedImage =
    requestedImageId !== null
      ? await getFridgeImage(requestedImageId)
      : (images[0] ?? null);

  return {
    images,
    selectedImage,
  };
}

export async function action({ request }: ActionFunctionArgs) {
  const formData = await request.formData();
  const dataUrl = formData.get("dataUrl");
  const originalName = formData.get("originalName");

  if (typeof dataUrl !== "string" || dataUrl.length === 0) {
    throw new Error("Missing image data");
  }

  const image = createFridgeImage({
    dataUrl,
    originalName: typeof originalName === "string" ? originalName : null,
  });

  return redirect(`/?imageId=${encodeURIComponent(image.id)}`);
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
  const { images, selectedImage } = useLoaderData<{
    images: FridgeImage[];
    selectedImage: FridgeImage | null;
  }>();
  const submit = useSubmit();
  const navigation = useNavigation();
  const [uploadError, setUploadError] = useState<string | null>(null);
  const isUploading = navigation.state !== "idle";

  async function handleImageChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    if (!file) {
      return;
    }

    setUploadError(null);

    try {
      const dataUrl = await encodeFileAsJpegDataUrl(file);
      const formData = new FormData();
      formData.set("dataUrl", dataUrl);
      formData.set("originalName", file.name);
      await submit(formData, { method: "post" });
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : String(error));
    } finally {
      event.currentTarget.value = "";
    }
  }

  return (
    <main className="page">
      <div className="shell">

        <section className="workspace" aria-label="Fridge image workspace">
          <div className="upload-panel">
            <label className="upload-label" htmlFor="fridge-image">
              Upload a picture of your fridge
            </label>
            <input
              id="fridge-image"
              type="file"
              accept="image/*"
              capture="environment"
              disabled={isUploading}
              onChange={handleImageChange}
            />
            {isUploading ? <p className="form-note">Saving image...</p> : null}
            {uploadError ? <p className="form-error">{uploadError}</p> : null}
          </div>

          <div className="image-viewer">
            {selectedImage ? (
              <img
                src={selectedImage.dataUrl}
                alt={selectedImage.originalName ?? "Selected fridge"}
              />
            ) : (
              <div className="empty-state">No fridge uploaded yet.</div>
            )}
          </div>

          {images.length > 0 ? (
            <section className="image-list" aria-label="Saved fridges">
              {images.map((image) => (
                <Form method="get" key={image.id}>
                  <input type="hidden" name="imageId" value={image.id} />
                  <button
                    className={
                      selectedImage?.id === image.id
                        ? "thumbnail selected"
                        : "thumbnail"
                    }
                    type="submit"
                  >
                    <img
                      src={image.dataUrl}
                      alt={image.originalName ?? "Saved fridge"}
                    />
                  </button>
                </Form>
              ))}
            </section>
          ) : null}
        </section>
      </div>
    </main>
  );
}
