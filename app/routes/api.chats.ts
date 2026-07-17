import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

import { createChat, getChat, getOrCreateLatestChat } from "../server/chat/repository.server";
import { jsonError } from "../server/http.server";

type ChatScope = {
  userId: string;
  fridgeId: string;
  imageId: string | null;
};

function scopeFromSearchParams(searchParams: URLSearchParams): ChatScope {
  const userId = searchParams.get("userId")?.trim() || "default-user";
  const fridgeId = searchParams.get("fridgeId")?.trim();
  const imageId = searchParams.get("imageId");

  if (!fridgeId) {
    throw new Error("Chat requests must include fridgeId");
  }
  if (imageId !== null && !imageId.trim()) {
    throw new Error("Chat imageId must be a non-empty string or null");
  }

  return { userId, fridgeId, imageId: imageId?.trim() ?? null };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function scopeFromBody(body: Record<string, unknown>): ChatScope {
  const userId = typeof body.userId === "string" && body.userId.trim() ? body.userId.trim() : "default-user";
  const fridgeId = typeof body.fridgeId === "string" ? body.fridgeId.trim() : "";
  const imageId = body.imageId;

  if (!fridgeId) {
    throw new Error("Chat requests must include fridgeId");
  }
  if (imageId !== null && (typeof imageId !== "string" || !imageId.trim())) {
    throw new Error("Chat imageId must be a non-empty string or null");
  }

  return { userId, fridgeId, imageId: imageId === null ? null : imageId.trim() };
}

export async function loader({ request }: LoaderFunctionArgs) {
  try {
    const url = new URL(request.url);
    const scope = scopeFromSearchParams(url.searchParams);
    const threadId = url.searchParams.get("threadId")?.trim();
    const chat = threadId
      ? getChat(threadId, scope)
      : getOrCreateLatestChat(scope);

    return Response.json({ chat });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return jsonError(message, 400);
  }
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return jsonError(`Unsupported method ${request.method}`, 405);
  }

  try {
    const body: unknown = await request.json();

    if (!isRecord(body)) {
      throw new Error("Chat request body must be an object");
    }
    if (body.action !== "create") {
      throw new Error("Chat request action must be create");
    }

    const chat = createChat(scopeFromBody(body));
    return Response.json({ chat }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return jsonError(message, 400);
  }
}
