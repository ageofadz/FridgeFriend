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

const QUERY_FAILURE_MESSAGE = "I couldn't complete that request. Please try again.";

function encodeStreamEvent(event: QueryStreamEvent) {
  return `${JSON.stringify(event)}\n`;
}

function clientStreamEvent(event: QueryStreamEvent): QueryStreamEvent {
  if (event.type === "error") {
    return { ...event, error: QUERY_FAILURE_MESSAGE };
  }

  if (event.type === "agent_event" && event.event.type === "enrichment_failed") {
    return { ...event, event: { ...event.event, error: "Couldn't inspect the selected item." } };
  }

  if (event.type === "agent_event" && event.event.type === "inventory_assertion_failed") {
    return { ...event, event: { ...event.event, error: "Couldn't update the selected item." } };
  }

  return event;
}

export function createQueryStreamResponse(
  input: QueryGraphInput,
  streamFactory: (
    input: QueryGraphInput,
  ) => AsyncIterable<QueryStreamEvent> = streamQueryForFridgeImage,
  persistence: QueryStreamPersistence = {},
) {
  const encoder = new TextEncoder();
  let cancelled = false;

  return new Response(
    new ReadableStream({
      cancel() {
        cancelled = true;
      },
      async start(controller) {
        const enqueue = (event: QueryStreamEvent) => {
          if (cancelled || controller.desiredSize === null) {
            return false;
          }
          controller.enqueue(encoder.encode(encodeStreamEvent(event)));
          return true;
        };

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
            if (event.type === "error") {
              await persistence.onError?.(event.error);
            }
            if (!enqueue(clientStreamEvent(event)) || event.type === "error") {
              return;
            }
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await persistence.onError?.(message);
          enqueue({
            type: "error",
            error: QUERY_FAILURE_MESSAGE,
          });
        } finally {
          if (!cancelled && controller.desiredSize !== null) {
            controller.close();
          }
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
