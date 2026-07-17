import type { ActionFunctionArgs } from "react-router";

import {
  runQueryForFridgeImage,
} from "../server/query-graph.server";
import {
  createQueryContinuationStreamResponse,
  createQueryResumeStreamResponse,
  createQueryStreamResponse,
} from "../server/query/stream-response.server";
import { QueryResumeSchema } from "../server/query/schemas/query";
import { jsonError } from "../server/http.server";
import { ConversationContextSchema, type ConversationContext } from "../workspace/contracts";
import { getChat, recentChatMessagesForQuery, resumeChatExecution, startChatTurn, updateChatAssistantMessage } from "../server/chat/repository.server";
import type { QueryStreamEvent } from "../workspace/query-events";

type QueryRequestBody = {
  action?: "start";
  userId?: string;
  fridgeId: string;
  imageId: string | null;
  query: string;
  threadId: string;
  requestId: string;
  recipeContinuation?: boolean;
  conversationContext: ConversationContext;
  userMessageId: string;
  assistantMessageId: string;
};

type ResumeRequestBody = {
  action: "resume";
  threadId: string;
  resume: ReturnType<typeof QueryResumeSchema.parse>;
  userId?: string;
  fridgeId: string;
  imageId: string | null;
  userMessageId: string;
  assistantMessageId: string;
  userMessageText: string;
};

type ContinueRequestBody = {
  action: "continue";
  userId?: string;
  fridgeId: string;
  imageId: string | null;
  threadId: string;
};

function wantsNdjson(request: Request) {
  return request.headers.get("accept")?.includes("application/x-ndjson") ??
    false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function requiredText(body: Record<string, unknown>, key: string, message: string) {
  const value = body[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(message);
  }
  return value.trim();
}

function readChatScope(body: Record<string, unknown>) {
  const userId = typeof body.userId === "string" && body.userId.trim().length > 0
    ? body.userId.trim()
    : undefined;
  const fridgeId = requiredText(body, "fridgeId", "Query request body must include fridgeId");
  const imageId = body.imageId;

  if (imageId !== null && (typeof imageId !== "string" || imageId.trim().length === 0)) {
    throw new Error("Query request body imageId must be a string or null");
  }

  return { userId, fridgeId, imageId: imageId === null ? null : imageId.trim() };
}

async function readQueryRequest(request: Request): Promise<QueryRequestBody | ResumeRequestBody | ContinueRequestBody> {
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
    const scope = readChatScope(body);
    const threadId = requiredText(body, "threadId", "Query resume request must include threadId");
    const resume = QueryResumeSchema.safeParse(body.resume);
    if (!resume.success) {
      throw new Error(`Query resume payload is invalid: ${resume.error.issues.map((issue) => issue.message).join("; ")}`);
    }
    return {
      action: "resume",
      ...scope,
      threadId,
      resume: resume.data,
      userMessageId: requiredText(body, "userMessageId", "Query resume request must include userMessageId"),
      assistantMessageId: requiredText(body, "assistantMessageId", "Query resume request must include assistantMessageId"),
      userMessageText: requiredText(body, "userMessageText", "Query resume request must include userMessageText"),
    };
  }

  if (body.action === "continue") {
    return {
      action: "continue",
      ...readChatScope(body),
      threadId: requiredText(body, "threadId", "Query continuation request must include threadId"),
    };
  }

  const { query, recipeContinuation, conversationContext } = body;
  const scope = readChatScope(body);

  if (typeof query !== "string" || query.trim().length === 0) {
    throw new Error("Query request body must include query");
  }

  const threadId = requiredText(body, "threadId", "Query request body must include threadId");
  const requestId = requiredText(body, "requestId", "Query request body must include requestId");

  const parsedConversationContext = ConversationContextSchema.safeParse(conversationContext ?? {});
  if (!parsedConversationContext.success) {
    throw new Error(`Query request conversationContext is invalid: ${parsedConversationContext.error.issues.map((issue) => issue.message).join("; ")}`);
  }

  return {
    ...scope,
    query: query.trim(),
    threadId: threadId.trim(),
    requestId: requestId.trim(),
    recipeContinuation: recipeContinuation === true,
    conversationContext: parsedConversationContext.data,
    userMessageId: requiredText(body, "userMessageId", "Query request body must include userMessageId"),
    assistantMessageId: requiredText(body, "assistantMessageId", "Query request body must include assistantMessageId"),
  };
}

function persistedAssistantPayload(event: Extract<QueryStreamEvent, { type: "final" }>) {
  return {
    text: event.answer,
    recipes: event.recipes,
    expiryPlan: event.expiryPlan,
    groceryPlan: event.groceryPlan,
    groceryPlanError: event.groceryPlanError,
    pantryCompletionPlan: event.pantryCompletionPlan,
    pantryCompletionError: event.pantryCompletionError,
    pantryCompletionClarification: event.pantryCompletionClarification,
    organizationPlan: event.organizationPlan,
    visualEvidence: event.visualEvidence,
  };
}

function interruptedAssistantPayload(event: QueryStreamEvent) {
  if (event.type === "clarification") {
    return { text: event.questions.map((question) => question.question).join("\n\n") };
  }
  if (event.type === "inventory_split_review") {
    return { text: event.summary };
  }
  if (event.type === "inventory_mutation_review") {
    return { text: `${event.itemName} in ${event.storageLocation}` };
  }
  throw new Error(`Cannot persist non-interrupt query event ${event.type}`);
}

function queryStreamPersistence(input: {
  userId?: string;
  fridgeId: string;
  imageId: string | null;
  threadId: string;
  assistantMessageId: string;
}) {
  const userId = input.userId ?? "default-user";
  const update = (payload: Record<string, unknown>, status: "idle" | "interrupted") =>
    updateChatAssistantMessage({
      userId,
      fridgeId: input.fridgeId,
      imageId: input.imageId,
      threadId: input.threadId,
      assistantMessageId: input.assistantMessageId,
      payload,
      status,
    });

  return {
    onFinal: (event: Extract<QueryStreamEvent, { type: "final" }>) => update(persistedAssistantPayload(event), "idle"),
    onInterrupted: (event: QueryStreamEvent) => update(interruptedAssistantPayload(event), "interrupted"),
    onError: (error: string) => update({ text: `Query graph error: ${error}` }, "idle"),
  };
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return jsonError(`Unsupported method ${request.method}`, 405);
  }

  let body: QueryRequestBody | ResumeRequestBody | ContinueRequestBody;

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
      startChatTurn({
        userId: body.userId ?? "default-user",
        fridgeId: body.fridgeId,
        imageId: body.imageId,
        threadId: body.threadId,
        userMessage: { id: body.userMessageId, role: "user", payload: { text: body.userMessageText } },
        assistantMessage: { id: body.assistantMessageId, role: "assistant", payload: { text: "" } },
      });
      return createQueryResumeStreamResponse(body, queryStreamPersistence({ ...body, assistantMessageId: body.assistantMessageId }));
    }
    if (body.action === "continue") {
      if (!wantsNdjson(request)) {
        return jsonError("Query continuation requests require application/x-ndjson", 406);
      }
      const assistantMessageId = resumeChatExecution({
        userId: body.userId ?? "default-user",
        fridgeId: body.fridgeId,
        imageId: body.imageId,
        threadId: body.threadId,
      });
      return createQueryContinuationStreamResponse(body, queryStreamPersistence({ ...body, assistantMessageId }));
    }
    const chat = getChat(body.threadId, {
      userId: body.userId ?? "default-user",
      fridgeId: body.fridgeId,
      imageId: body.imageId,
    });
    const input = {
      userId: body.userId,
      fridgeId: body.fridgeId,
      imageId: body.imageId,
      query: body.query,
      threadId: body.threadId,
      requestId: body.requestId,
      recipeContinuation: body.recipeContinuation,
      conversationContext: body.conversationContext,
      recentChatMessages: recentChatMessagesForQuery(chat),
    };

    startChatTurn({
      userId: body.userId ?? "default-user",
      fridgeId: body.fridgeId,
      imageId: body.imageId,
      threadId: body.threadId,
      userMessage: { id: body.userMessageId, role: "user", payload: { text: body.query, seededItems: body.conversationContext.seededItems } },
      assistantMessage: { id: body.assistantMessageId, role: "assistant", payload: { text: "" } },
    });

    if (wantsNdjson(request)) {
      return createQueryStreamResponse(input, undefined, queryStreamPersistence({ ...body, assistantMessageId: body.assistantMessageId }));
    }

    const result = await runQueryForFridgeImage(input);

    if (result.status === "interrupted") {
      // The graph paused for human input (clarification or split review). The
      // JSON path cannot resume mid-request, so report the pause explicitly.
      return Response.json({
        status: "interrupted",
        threadId: result.threadId,
        interrupts: result.interrupts,
      });
    }

    return Response.json({
      status: "completed",
      answer: result.answer,
      intent: result.intent,
      visualEvidence: result.visualEvidence,
      workspaceActions: result.workspaceActions,
      groceryPlan: result.groceryPlan,
      groceryPlanError: result.groceryPlanError,
      pantryCompletionPlan: result.pantryCompletionPlan,
      pantryCompletionError: result.pantryCompletionError,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return jsonError(`Query graph invocation failed: ${message}`, 500);
  }
}
