import type { LoaderFunctionArgs } from "react-router";

import {
  InventoryCropError,
  jpegDataUrlToBytes,
  resolveInventoryCropDataUrl,
} from "../server/query/services/focused-visual-context.server";

function jsonError(error: string, status: number) {
  return Response.json({ error }, { status });
}

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const cropId = url.searchParams.get("cropId")?.trim() ?? "";

  if (!cropId) {
    return jsonError("Inventory crop request requires cropId query parameter", 400);
  }

  try {
    const dataUrl = await resolveInventoryCropDataUrl({ cropId });
    return new Response(jpegDataUrlToBytes(dataUrl, cropId), {
      headers: {
        "Cache-Control": "private, max-age=3600",
        "Content-Type": "image/jpeg",
      },
    });
  } catch (error) {
    if (error instanceof InventoryCropError) {
      return jsonError(error.message, error.status);
    }

    const message = error instanceof Error ? error.message : String(error);
    return jsonError(`Inventory crop request failed: ${message}`, 500);
  }
}
