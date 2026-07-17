import {
  resumeQueryForFridgeImage,
  streamQueryForFridgeImage,
  type QueryGraphInput,
  type QueryStreamEvent,
} from "../query-graph.server";
import type { QueryResume } from "./schemas/query";

function encodeStreamEvent(event: QueryStreamEvent) {
  return `${JSON.stringify(event)}\n`;
}

export function createQueryStreamResponse(
  input: QueryGraphInput,
  streamFactory: (
    input: QueryGraphInput,
  ) => AsyncIterable<QueryStreamEvent> = streamQueryForFridgeImage,
) {
  const encoder = new TextEncoder();

  return new Response(
    new ReadableStream({
      async start(controller) {
        try {
          for await (const event of streamFactory(input)) {
            controller.enqueue(encoder.encode(encodeStreamEvent(event)));
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
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
}) {
  return createQueryStreamResponse(
    {
      fridgeId: "resume",
      imageId: null,
      query: "resume",
      threadId: input.threadId,
    },
    () => resumeQueryForFridgeImage(input),
  );
}
