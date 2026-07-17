import {
  continueQueryForFridgeThread,
  resumeQueryForFridgeImage,
  streamQueryForFridgeImage,
  type QueryGraphInput,
  type QueryStreamEvent,
} from "../query-graph.server";
import type { QueryResume } from "./schemas/query";

type QueryStreamPersistence = {
  onFinal?(event: Extract<QueryStreamEvent, { type: "final" }>): Promise<void> | void;
  onInterrupted?(event: QueryStreamEvent): Promise<void> | void;
  onError?(error: string): Promise<void> | void;
};

function encodeStreamEvent(event: QueryStreamEvent) {
  return `${JSON.stringify(event)}\n`;
}

export function createQueryStreamResponse(
  input: QueryGraphInput,
  streamFactory: (
    input: QueryGraphInput,
  ) => AsyncIterable<QueryStreamEvent> = streamQueryForFridgeImage,
  persistence: QueryStreamPersistence = {},
) {
  const encoder = new TextEncoder();

  return new Response(
    new ReadableStream({
      async start(controller) {
        try {
          for await (const event of streamFactory(input)) {
            if (event.type === "final") {
              await persistence.onFinal?.(event);
            }
            if (
              event.type === "clarification" ||
              event.type === "inventory_split_review" ||
              event.type === "inventory_mutation_review"
            ) {
              await persistence.onInterrupted?.(event);
            }
            controller.enqueue(encoder.encode(encodeStreamEvent(event)));
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await persistence.onError?.(message);
          controller.enqueue(
            encoder.encode(
              encodeStreamEvent({
                type: "error",
                error: `Query graph invocation failed: ${message}`,
              }),
            ),
          );
        } finally {
          controller.close();
        }
      },
    }),
    {
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-cache",
      },
    },
  );
}

export function createQueryResumeStreamResponse(input: {
  threadId: string;
  resume: QueryResume;
}, persistence: QueryStreamPersistence = {}) {
  return createQueryStreamResponse(
    {
      fridgeId: "resume",
      imageId: null,
      query: "resume",
      threadId: input.threadId,
    },
    () => resumeQueryForFridgeImage(input),
    persistence,
  );
}

export function createQueryContinuationStreamResponse(input: { threadId: string }, persistence: QueryStreamPersistence = {}) {
  return createQueryStreamResponse(
    {
      fridgeId: "continue",
      imageId: null,
      query: "continue",
      threadId: input.threadId,
    },
    () => continueQueryForFridgeThread(input),
    persistence,
  );
}
