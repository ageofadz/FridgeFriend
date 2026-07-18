import { describe, expect, it } from "vitest";

import { createQueryStreamResponse } from "../../../app/server/query/stream-response.server";
import type {
  QueryGraphInput,
  QueryStreamEvent,
} from "../../../app/server/query-graph.server";

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
        dietaryRestrictions: [],
        dietaryPreferences: [],
        activeGoals: [],
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
      { type: "final", answer: "Hello world", intent: "recipe", recipes: [], visualEvidence: [], dietaryRestrictions: [], dietaryPreferences: [], activeGoals: [] },
    ]);
  });

  it("keeps invocation errors out of the client stream while persisting the failure state", async () => {
    async function* streamFactory(): AsyncGenerator<QueryStreamEvent> {
      yield { type: "status", message: "Starting query graph." } as const;
      throw new Error("Food.com recipe Chroma search failed: connection refused");
    }

    let persistedError: string | undefined;
    const response = createQueryStreamResponse(input, streamFactory, {
      onError(error) {
        persistedError = error;
      },
    });

    expect(await responseLines(response)).toEqual([
      { type: "status", message: "Starting query graph." },
      {
        type: "error",
        error: "I couldn't complete that request. Please try again.",
      },
    ]);
    expect(persistedError).toBe("Food.com recipe Chroma search failed: connection refused");
  });

  it("persists graph-produced errors before closing the stream", async () => {
    async function* streamFactory(): AsyncGenerator<QueryStreamEvent> {
      yield { type: "error", error: "Query graph completed without an answer" } as const;
    }

    let persistedError: string | undefined;
    const response = createQueryStreamResponse(input, streamFactory, {
      onError(error) {
        persistedError = error;
      },
    });

    expect(await responseLines(response)).toEqual([
      { type: "error", error: "I couldn't complete that request. Please try again." },
    ]);
    expect(persistedError).toBe("Query graph completed without an answer");
  });

  it("does not report an error after the client cancels the stream", async () => {
    let releaseStream: (() => void) | undefined;
    let markStarted: (() => void) | undefined;
    let markFinished: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const finished = new Promise<void>((resolve) => {
      markFinished = resolve;
    });

    async function* streamFactory(): AsyncGenerator<QueryStreamEvent> {
      markStarted?.();
      try {
        await new Promise<void>((resolve) => {
          releaseStream = resolve;
        });
        yield { type: "status", message: "Starting query graph." } as const;
      } finally {
        markFinished?.();
      }
    }

    let persistedError: string | undefined;
    const response = createQueryStreamResponse(input, streamFactory, {
      onError(error) {
        persistedError = error;
      },
    });

    await started;
    await response.body?.cancel();
    releaseStream?.();
    await finished;

    expect(persistedError).toBeUndefined();
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
        dietaryRestrictions: [],
        dietaryPreferences: [],
        activeGoals: [],
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
        dietaryRestrictions: [],
        dietaryPreferences: [],
        activeGoals: [],
      },
    ]);
  });
});
