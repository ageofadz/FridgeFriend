import { ChatPromptTemplate } from "@langchain/core/prompts";
import { afterEach, describe, expect, it, vi } from "vitest";

const names = ["LANGSMITH_ENDPOINT", "LANGSMITH_API_KEY", "LANGSMITH_PROJECT"] as const;
const original = Object.fromEntries(names.map((name) => [name, process.env[name]]));

function clearLangSmith() {
  names.forEach((name) => delete process.env[name]);
}

afterEach(() => {
  vi.doUnmock("langchain/hub");
  vi.resetModules();

  for (const name of names) {
    const value = original[name];

    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
});

describe("prompt registry", () => {
  it("loads bundled prompts when LangSmith is not configured", async () => {
    clearLangSmith();
    vi.resetModules();
    const { loadPromptBundle } = await import("../../../../app/server/prompts/registry.server");

    const prompts = await loadPromptBundle();

    expect(prompts.imageValidation.ref).toBe("bundled:fridge-perception");
    expect(prompts.queryResponse.ref).toBe("bundled:query-response");
  });

  it("uses Prompt Hub with the supplied LangSmith endpoint", async () => {
    process.env.LANGSMITH_ENDPOINT = "https://smith.example.test";
    process.env.LANGSMITH_API_KEY = "test-key";
    process.env.LANGSMITH_PROJECT = "fridgefriend";
    const pull = vi.fn(async () => ChatPromptTemplate.fromTemplate("{input}"));
    vi.doMock("langchain/hub", () => ({ pull }));
    vi.resetModules();
    const { loadPromptBundle } = await import("../../../../app/server/prompts/registry.server");

    await loadPromptBundle();

    expect(pull).toHaveBeenCalledWith(
      "fridgefriend-fridge-perception:latest",
      { apiKey: "test-key", apiUrl: "https://smith.example.test" },
    );
    expect(pull).toHaveBeenCalledWith(
      "fridgefriend-query-recipe-search:e698678c42c64a5e3f67b3432d3e3bf492f4411c103097f8fef4a6cdb50450c1",
      { apiKey: "test-key", apiUrl: "https://smith.example.test" },
    );
    expect(pull).not.toHaveBeenCalledWith(
      "fridgefriend-eval-query-answer-groundedness:latest",
      { apiKey: "test-key", apiUrl: "https://smith.example.test" },
    );
  });

  it("keeps an unavailable evaluation prompt off the interactive prompt path", async () => {
    process.env.LANGSMITH_ENDPOINT = "https://smith.example.test";
    process.env.LANGSMITH_API_KEY = "test-key";
    process.env.LANGSMITH_PROJECT = "fridgefriend";
    const pull = vi.fn(async (ref: string) => {
      if (ref === "fridgefriend-eval-query-answer-groundedness:latest") {
        throw new Error("Commit not found");
      }
      return ChatPromptTemplate.fromTemplate("{input}");
    });
    vi.doMock("langchain/hub", () => ({ pull }));
    vi.resetModules();
    const { loadPromptBundle } = await import("../../../../app/server/prompts/registry.server");

    await expect(loadPromptBundle()).resolves.toMatchObject({
      queryResponse: { ref: "fridgefriend-query-response:d0d875334af058c1478636b7494a032197477afc8b07afbbab0ea5949fc2db12" },
    });
    expect(pull).not.toHaveBeenCalledWith(
      "fridgefriend-eval-query-answer-groundedness:latest",
      expect.anything(),
    );
  });

  it("fails clearly when an approved recipe prompt cannot load", async () => {
    process.env.LANGSMITH_ENDPOINT = "https://smith.example.test";
    process.env.LANGSMITH_API_KEY = "test-key";
    process.env.LANGSMITH_PROJECT = "fridgefriend";
    const pull = vi.fn(async (ref: string) => {
      if (ref.startsWith("fridgefriend-query-response:")) {
        throw new Error("prompt not found");
      }
      return ChatPromptTemplate.fromTemplate("{input}");
    });
    vi.doMock("langchain/hub", () => ({ pull }));
    vi.resetModules();
    const { loadPromptBundle } = await import("../../../../app/server/prompts/registry.server");

    await expect(loadPromptBundle()).rejects.toThrow(
      "Approved recipe Prompt Hub prompt fridgefriend-query-response:d0d875334af058c1478636b7494a032197477afc8b07afbbab0ea5949fc2db12 could not load: prompt not found",
    );
  });
});
