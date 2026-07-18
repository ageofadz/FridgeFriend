// Trace naming, tagging, and metadata for query/scan graph invocations, plus
// error classification shared with the eval harness. Metadata never carries
// raw household identifiers — only stable hashes.

import { createHash } from "node:crypto";

import { extractTopology, edgeKey } from "./graph-coverage";
import type { EvalError, EvalErrorKind } from "../evals/schemas/eval-result";

export type TraceEnvironment = "production" | "development" | "evaluation";
export type TraceMode = "live" | "replay";

export function resolveTraceEnvironment(): TraceEnvironment {
  return process.env.NODE_ENV === "production" ? "production" : "development";
}

export function hashIdentifier(value: string): string {
  return `h:${createHash("sha256").update(value).digest("hex").slice(0, 16)}`;
}

type BaseTraceInput = {
  threadId: string;
  requestId: string;
  fridgeId: string;
  imageId?: string | null;
  environment: TraceEnvironment;
  mode: TraceMode;
  model: string;
  promptRefs: Record<string, string>;
  graphRevision: string;
  evalCaseId?: string;
  evalDatasetRevision?: string;
};

export type QueryTraceInput = BaseTraceInput & {
  userId: string;
};

export type ScanTraceInput = BaseTraceInput & {
  userId?: string | null;
  imageCount: number;
  storageKind: string;
};

export type TraceOptions = {
  runName: string;
  tags: string[];
  metadata: Record<string, unknown>;
};

function evalMetadata(input: BaseTraceInput): Record<string, unknown> {
  return {
    ...(input.evalCaseId ? { evalCaseId: input.evalCaseId, evalMode: input.mode } : {}),
    ...(input.evalDatasetRevision ? { evalDatasetRevision: input.evalDatasetRevision } : {}),
  };
}

export function buildQueryTraceOptions(input: QueryTraceInput): TraceOptions {
  return {
    runName: "query_graph",
    tags: ["fridgefriend", "query_graph", input.environment, input.mode],
    metadata: {
      graph: "query_graph",
      graphRevision: input.graphRevision,
      environment: input.environment,
      thread_id: input.threadId,
      requestId: input.requestId,
      userIdHash: hashIdentifier(input.userId),
      fridgeIdHash: hashIdentifier(input.fridgeId),
      ...(input.imageId ? { imageIdHash: hashIdentifier(input.imageId) } : {}),
      model: input.model,
      promptRefs: input.promptRefs,
      ...evalMetadata(input),
    },
  };
}

export function buildScanTraceOptions(input: ScanTraceInput): TraceOptions {
  return {
    runName: "scan_graph",
    tags: ["fridgefriend", "scan_graph", input.environment, input.mode],
    metadata: {
      graph: "scan_graph",
      graphRevision: input.graphRevision,
      environment: input.environment,
      thread_id: input.threadId,
      requestId: input.requestId,
      ...(input.userId ? { userIdHash: hashIdentifier(input.userId) } : {}),
      fridgeIdHash: hashIdentifier(input.fridgeId),
      ...(input.imageId ? { imageIdHash: hashIdentifier(input.imageId) } : {}),
      model: input.model,
      promptRefs: input.promptRefs,
      imageCount: input.imageCount,
      storageKind: input.storageKind,
      ...evalMetadata(input),
    },
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return typeof error === "string" ? error : JSON.stringify(error);
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "";
}

function classifyErrorKind(error: unknown): EvalErrorKind {
  const name = errorName(error);
  const message = errorMessage(error);
  const haystack = `${name} ${message}`;

  if (/abort|timeout|timed[ _-]?out|deadline/i.test(haystack)) {
    return "timeout";
  }
  if (name === "ZodError" || /zod|schema (validation|parse)|structured output|invalid_type|failed to parse/i.test(haystack)) {
    return "schema";
  }
  if (/replay/i.test(haystack)) {
    return "replay_mismatch";
  }
  if (/fixture/i.test(haystack)) {
    return "fixture";
  }
  if (/provider|api key|api error|status 4\d\d|status 5\d\d|\b429\b|\b503\b|quota|rate limit|fetch failed|ECONNREFUSED|ENOTFOUND|overloaded/i.test(haystack)) {
    return "provider";
  }
  return "runtime";
}

export function classifyError(error: unknown, node: string): EvalError {
  return {
    errorKind: classifyErrorKind(error),
    node,
    message: errorMessage(error),
  };
}

/**
 * Stable revision hash of a compiled graph's topology (sorted node names and
 * edges). Changes whenever the graph structure changes.
 */
export function graphRevisionFor(compiledGraph: { getGraph(): unknown }): string {
  const topology = extractTopology(compiledGraph);
  const nodes = [...topology.nodes].sort();
  const edges = topology.edges
    .map((edge) => `${edgeKey(edge)}:${edge.conditional ? "c" : "d"}`)
    .sort();
  const digest = createHash("sha256")
    .update(JSON.stringify({ nodes, edges }))
    .digest("hex");
  return digest.slice(0, 16);
}
