import { afterEach, describe, expect, it } from "vitest";

import { ensureLangSmithTracingEnv, getLangSmithConfig } from "../../../app/server/langsmith.server";

const names = [
  "LANGSMITH_ENDPOINT",
  "LANGSMITH_API_KEY",
  "LANGSMITH_PROJECT",
  "LANGSMITH_TRACING",
] as const;
const original = Object.fromEntries(names.map((name) => [name, process.env[name]]));

afterEach(() => {
  for (const name of names) {
    const value = original[name];

    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
});

describe("LangSmith runtime configuration", () => {
  it("uses no LangSmith configuration when no optional values are set", () => {
    names.forEach((name) => delete process.env[name]);

    expect(getLangSmithConfig()).toBeNull();
  });

  it("rejects partial LangSmith configuration", () => {
    process.env.LANGSMITH_PROJECT = "fridgefriend";
    delete process.env.LANGSMITH_ENDPOINT;
    delete process.env.LANGSMITH_API_KEY;

    expect(() => getLangSmithConfig()).toThrow(
      "LangSmith configuration is incomplete: LANGSMITH_ENDPOINT, LANGSMITH_API_KEY must be set when using LANGSMITH_PROJECT",
    );
  });

  it("returns complete LangSmith tracing configuration", () => {
    process.env.LANGSMITH_ENDPOINT = "https://api.smith.langchain.com";
    process.env.LANGSMITH_API_KEY = "test-key";
    process.env.LANGSMITH_PROJECT = "fridgefriend";

    expect(getLangSmithConfig()).toEqual({
      endpoint: "https://api.smith.langchain.com",
      apiKey: "test-key",
      project: "fridgefriend",
    });
  });

  it("enables LangSmith tracing when configuration is complete and tracing is unset", () => {
    process.env.LANGSMITH_ENDPOINT = "https://api.smith.langchain.com";
    process.env.LANGSMITH_API_KEY = "test-key";
    process.env.LANGSMITH_PROJECT = "fridgefriend";
    delete process.env.LANGSMITH_TRACING;

    ensureLangSmithTracingEnv();

    expect(process.env.LANGSMITH_TRACING).toBe("true");
  });

  it("does not override an explicit LANGSMITH_TRACING value", () => {
    process.env.LANGSMITH_ENDPOINT = "https://api.smith.langchain.com";
    process.env.LANGSMITH_API_KEY = "test-key";
    process.env.LANGSMITH_PROJECT = "fridgefriend";
    process.env.LANGSMITH_TRACING = "false";

    ensureLangSmithTracingEnv();

    expect(process.env.LANGSMITH_TRACING).toBe("false");
  });

  it("does not enable tracing when LangSmith is not configured", () => {
    names.forEach((name) => delete process.env[name]);

    ensureLangSmithTracingEnv();

    expect(process.env.LANGSMITH_TRACING).toBeUndefined();
  });

  it("does not enable tracing when LangSmith configuration is incomplete", () => {
    names.forEach((name) => delete process.env[name]);
    process.env.LANGSMITH_PROJECT = "fridgefriend";

    ensureLangSmithTracingEnv();

    expect(process.env.LANGSMITH_TRACING).toBeUndefined();
  });
});
