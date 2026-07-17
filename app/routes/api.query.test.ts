import { describe, expect, it } from "vitest";

import { createQueryStreamResponse } from "../server/query/stream-response.server";
import type {
  QueryGraphInput,
  QueryStreamEvent,
} from "../server/query-graph.server";

async function responseLines(response: Response) {
  const text = await response.text();
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as QueryStreamEvent);
}

describe("query API stream response", () => {
  const input: QueryGraphInput = {
    fridgeId: "fridge-1",
    imageId: "image-1",
    query: "What can I cook?",
    threadId: "thread-1",
  };

  it("streams NDJSON events in order", async () => {
    async function* streamFactory(): AsyncGenerator<QueryStreamEvent> {
      yield { type: "status", message: "Starting query graph." } as const;
      yield { type: "recipe_tournament_started", candidateCount: 2, displaySlotCount: 2 } as const;
      yield { type: "token", text: "Hello" } as const;
      yield { type: "token", text: " world" } as const;
      yield {
        type: "final",
        answer: "Hello world",
        intent: "recipe",
        recipes: [],
        visualEvidence: [],
      } as const;
    }

    const response = createQueryStreamResponse(input, streamFactory);

    expect(response.headers.get("content-type")).toContain(
      "application/x-ndjson",
    );
    expect(await responseLines(response)).toEqual([
      { type: "status", message: "Starting query graph." },
      { type: "recipe_tournament_started", candidateCount: 2, displaySlotCount: 2 },
      { type: "token", text: "Hello" },
      { type: "token", text: " world" },
      { type: "final", answer: "Hello world", intent: "recipe", recipes: [], visualEvidence: [] },
    ]);
  });

  it("streams specific error events when invocation fails", async () => {
    async function* streamFactory(): AsyncGenerator<QueryStreamEvent> {
      yield { type: "status", message: "Starting query graph." } as const;
      throw new Error("Food.com recipe Chroma search failed: connection refused");
    }

    const response = createQueryStreamResponse(input, streamFactory);

    expect(await responseLines(response)).toEqual([
      { type: "status", message: "Starting query graph." },
      {
        type: "error",
        error:
          "Query graph invocation failed: Food.com recipe Chroma search failed: connection refused",
      },
    ]);
  });

  it("streams with no selected image", async () => {
    async function* streamFactory(receivedInput: QueryGraphInput): AsyncGenerator<QueryStreamEvent> {
      expect(receivedInput.imageId).toBeNull();
      yield {
        type: "final",
        answer: "Describe what you have and I can track it.",
        intent: "inventory",
        recipes: [],
        visualEvidence: [],
      } as const;
    }

    const response = createQueryStreamResponse({
      ...input,
      imageId: null,
    }, streamFactory);

    expect(await responseLines(response)).toEqual([
      {
        type: "final",
        answer: "Describe what you have and I can track it.",
        intent: "inventory",
        recipes: [],
        visualEvidence: [],
      },
    ]);
  });
});
