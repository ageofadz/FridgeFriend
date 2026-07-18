import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  buildQueryTraceOptions,
  buildScanTraceOptions,
  classifyError,
  hashIdentifier,
  resolveTraceEnvironment,
} from "../../../../app/server/observability/trace-context.server";

const queryInput = {
  threadId: "query:img-1",
  requestId: "req-1",
  userId: "user-1",
  fridgeId: "fridge-1",
  imageId: "img-1",
  environment: "evaluation" as const,
  mode: "replay" as const,
  model: "gemini-3.1-flash-lite",
  promptRefs: { queryIntent: "ref-1" },
  graphRevision: "abc123",
};

describe("hashIdentifier", () => {
  it("produces stable prefixed hashes that are not the identity", () => {
    expect(hashIdentifier("user-1")).toBe(hashIdentifier("user-1"));
    expect(hashIdentifier("user-1")).toMatch(/^h:[0-9a-f]{16}$/);
    expect(hashIdentifier("user-1")).not.toContain("user-1");
    expect(hashIdentifier("user-1")).not.toBe(hashIdentifier("user-2"));
  });
});

describe("buildQueryTraceOptions", () => {
  it("returns the spec run name and exact tag order", () => {
    const trace = buildQueryTraceOptions(queryInput);

    expect(trace.runName).toBe("query_graph");
    expect(trace.tags).toEqual(["fridgefriend", "query_graph", "evaluation", "replay"]);
  });

  it("includes hashed identifiers and never raw ids", () => {
    const trace = buildQueryTraceOptions(queryInput);

    expect(trace.metadata).toMatchObject({
      graph: "query_graph",
      graphRevision: "abc123",
      environment: "evaluation",
      thread_id: "query:img-1",
      requestId: "req-1",
      userIdHash: hashIdentifier("user-1"),
      fridgeIdHash: hashIdentifier("fridge-1"),
      imageIdHash: hashIdentifier("img-1"),
      model: "gemini-3.1-flash-lite",
      promptRefs: { queryIntent: "ref-1" },
    });
    const serialized = JSON.stringify(trace.metadata);
    expect(serialized).not.toContain('"user-1"');
    expect(serialized).not.toContain('"fridge-1"');
    expect(serialized).not.toContain('"img-1"');
    expect(trace.metadata).not.toHaveProperty("userId");
    expect(trace.metadata).not.toHaveProperty("fridgeId");
    expect(trace.metadata).not.toHaveProperty("imageId");
  });

  it("omits imageIdHash and eval fields when absent, includes them when supplied", () => {
    const bare = buildQueryTraceOptions({ ...queryInput, imageId: null });
    expect(bare.metadata).not.toHaveProperty("imageIdHash");
    expect(bare.metadata).not.toHaveProperty("evalCaseId");
    expect(bare.metadata).not.toHaveProperty("evalMode");

    const evalTrace = buildQueryTraceOptions({
      ...queryInput,
      evalCaseId: "q-recipe-basic",
      evalDatasetRevision: "v1",
    });
    expect(evalTrace.metadata).toMatchObject({
      evalCaseId: "q-recipe-basic",
      evalDatasetRevision: "v1",
      evalMode: "replay",
    });
  });
});

describe("buildScanTraceOptions", () => {
  it("adds scan-specific metadata with the scan run name and tags", () => {
    const trace = buildScanTraceOptions({
      ...queryInput,
      threadId: "scan:img-1",
      environment: "production",
      mode: "live",
      imageCount: 1,
      storageKind: "fridge",
    });

    expect(trace.runName).toBe("scan_graph");
    expect(trace.tags).toEqual(["fridgefriend", "scan_graph", "production", "live"]);
    expect(trace.metadata).toMatchObject({
      graph: "scan_graph",
      imageCount: 1,
      storageKind: "fridge",
      fridgeIdHash: hashIdentifier("fridge-1"),
      imageIdHash: hashIdentifier("img-1"),
    });
    expect(JSON.stringify(trace.metadata)).not.toContain('"fridge-1"');
  });
});

describe("resolveTraceEnvironment", () => {
  it("maps NODE_ENV to production or development", () => {
    const original = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = "production";
      expect(resolveTraceEnvironment()).toBe("production");
      process.env.NODE_ENV = "test";
      expect(resolveTraceEnvironment()).toBe("development");
    } finally {
      process.env.NODE_ENV = original;
    }
  });
});

describe("classifyError", () => {
  it("classifies timeouts and aborts", () => {
    expect(classifyError(new Error("Request timed out"), "respond").errorKind).toBe("timeout");
    const abort = new Error("The operation was aborted");
    abort.name = "AbortError";
    expect(classifyError(abort, "respond").errorKind).toBe("timeout");
  });

  it("classifies zod/schema failures", () => {
    const zodError = z.object({ a: z.string() }).safeParse({ a: 1 }).error;
    expect(classifyError(zodError, "determine_intent").errorKind).toBe("schema");
    expect(classifyError(new Error("Failed to parse structured output"), "determine_intent").errorKind).toBe("schema");
  });

  it("classifies replay and fixture failures", () => {
    expect(classifyError(new Error("replay step missing for call site intent"), "determine_intent").errorKind).toBe("replay_mismatch");
    expect(classifyError(new Error("fixture image img-1 not found"), "validate_images").errorKind).toBe("fixture");
  });

  it("classifies provider errors", () => {
    expect(classifyError(new Error("Gemini API error: 429 quota exceeded"), "respond").errorKind).toBe("provider");
    expect(classifyError(new Error("fetch failed"), "respond").errorKind).toBe("provider");
  });

  it("defaults to runtime and records node and message", () => {
    const classified = classifyError(new Error("something broke"), "load_context");
    expect(classified).toEqual({
      errorKind: "runtime",
      node: "load_context",
      message: "something broke",
    });
  });

  it("handles non-Error values", () => {
    expect(classifyError("timeout waiting for lock", "respond").errorKind).toBe("timeout");
    expect(classifyError({ code: 500 }, "respond").message).toContain("500");
  });
});
