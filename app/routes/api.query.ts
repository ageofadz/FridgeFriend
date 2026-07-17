import type { ActionFunctionArgs } from "react-router";

import {
  runQueryForFridgeImage,
} from "../server/query-graph.server";
import { createQueryResumeStreamResponse, createQueryStreamResponse } from "../server/query/stream-response.server";
import { QueryResumeSchema } from "../server/query/schemas/query";
import { ConversationContextSchema, type ConversationContext } from "../workspace/contracts";

type QueryRequestBody = {
  action?: "start";
  userId?: string;
  fridgeId: string;
  imageId: string | null;
  query: string;
  threadId: string;
  conversationContext: ConversationContext;
};

type ResumeRequestBody = {
  action: "resume";
  threadId: string;
  resume: ReturnType<typeof QueryResumeSchema.parse>;
};

function jsonError(error: string, status: number) {
  return Response.json({ error }, { status });
}

function wantsNdjson(request: Request) {
  return request.headers.get("accept")?.includes("application/x-ndjson") ??
    false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function readQueryRequest(request: Request): Promise<QueryRequestBody | ResumeRequestBody> {
  let body: unknown;

  try {
    body = await request.json();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Query request body was not valid JSON: ${message}`);
  }

  if (!isRecord(body)) {
    throw new Error("Query request body must be an object");
  }

  if (body.action === "resume") {
    if (typeof body.threadId !== "string" || body.threadId.trim().length === 0) {
      throw new Error("Query resume request must include threadId");
    }
    const resume = QueryResumeSchema.safeParse(body.resume);
    if (!resume.success) {
      throw new Error(`Query resume payload is invalid: ${resume.error.issues.map((issue) => issue.message).join("; ")}`);
    }
    return { action: "resume", threadId: body.threadId.trim(), resume: resume.data };
  }

  const { userId, fridgeId, imageId, query, threadId, conversationContext } = body;

  if (typeof fridgeId !== "string" || fridgeId.trim().length === 0) {
    throw new Error("Query request body must include fridgeId");
  }

  if (imageId !== null && (typeof imageId !== "string" || imageId.trim().length === 0)) {
    throw new Error("Query request body imageId must be a string or null");
  }

  if (typeof query !== "string" || query.trim().length === 0) {
    throw new Error("Query request body must include query");
  }

  if (typeof threadId !== "string" || threadId.trim().length === 0) {
    throw new Error("Query request body must include threadId");
  }

  const parsedConversationContext = ConversationContextSchema.safeParse(conversationContext ?? {});
  if (!parsedConversationContext.success) {
    throw new Error(`Query request conversationContext is invalid: ${parsedConversationContext.error.issues.map((issue) => issue.message).join("; ")}`);
  }

  return {
    userId:
      typeof userId === "string" && userId.trim().length > 0
        ? userId.trim()
        : undefined,
    fridgeId: fridgeId.trim(),
    imageId: imageId === null ? null : imageId.trim(),
    query: query.trim(),
    threadId: threadId.trim(),
    conversationContext: parsedConversationContext.data,
  };
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return jsonError(`Unsupported method ${request.method}`, 405);
  }

  let body: QueryRequestBody | ResumeRequestBody;

  try {
    body = await readQueryRequest(request);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return jsonError(message, 400);
  }

  try {
    if (body.action === "resume") {
      if (!wantsNdjson(request)) {
        return jsonError("Query resume requests require application/x-ndjson", 406);
      }
      return createQueryResumeStreamResponse(body);
    }
    const input = {
      userId: body.userId,
      fridgeId: body.fridgeId,
      imageId: body.imageId,
      query: body.query,
      threadId: body.threadId,
      conversationContext: body.conversationContext,
    };

    if (wantsNdjson(request)) {
      return createQueryStreamResponse(input);
    }

    const result = await runQueryForFridgeImage(input);

    return Response.json({
      answer: result.answer,
      intent: result.intent,
      visualEvidence: result.visualEvidence,
      workspaceActions: result.workspaceActions,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return jsonError(`Query graph invocation failed: ${message}`, 500);
  }
}
