// Shared helpers for the eval scripts (seed/run/coverage/smoke). Keeps JSONL
// loading, hashing, arg parsing, and local eval-graph execution in one place.

import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { EvalFeedback, EvalResult } from "../../app/server/evals/schemas/eval-result";
import { QueryEvalCaseSchema } from "../../app/server/evals/schemas/query-eval-case";
import { ScanEvalCaseSchema } from "../../app/server/evals/schemas/scan-eval-case";

export type Suite = "query" | "scan";
export type Mode = "replay" | "live";

export const QUERY_DATASET_NAME = "fridgefriend-query-graph-evals-v1";
export const SCAN_DATASET_NAME = "fridgefriend-scan-graph-evals-v1";

export const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), "../../..");

export const SUITE_CONFIG: Record<
  Suite,
  { datasetName: string; sourcePath: string; schema: typeof QueryEvalCaseSchema | typeof ScanEvalCaseSchema }
> = {
  query: {
    datasetName: QUERY_DATASET_NAME,
    sourcePath: "examples/evals/query-v1.jsonl",
    schema: QueryEvalCaseSchema,
  },
  scan: {
    datasetName: SCAN_DATASET_NAME,
    sourcePath: "examples/evals/scan-v1.jsonl",
    schema: ScanEvalCaseSchema,
  },
};

// Judge feedback keys are quality signals, never a hard gate (spec "CI gates").
export const JUDGE_FEEDBACK_KEYS = new Set(["answer_groundedness", "answer_groundedness_pass"]);

// ---------------------------------------------------------------------------
// JSONL loading with zod validation
// ---------------------------------------------------------------------------

export type LoadedCase = {
  // Raw object exactly as committed — used for hashing and dataset payloads so
  // the fixture hash does not shift when schema defaults change.
  raw: Record<string, unknown>;
  caseId: string;
  line: number;
};

export class CaseValidationError extends Error {
  issues: string[];

  constructor(filePath: string, issues: string[]) {
    super(`Invalid eval cases in ${filePath}:\n  - ${issues.join("\n  - ")}`);
    this.name = "CaseValidationError";
    this.issues = issues;
  }
}

/**
 * Loads a JSONL case file and validates every row against the suite schema.
 * Throws a CaseValidationError listing every invalid row (caseId or line
 * number plus zod issues) and every duplicate caseId.
 */
export function loadSuiteCases(suite: Suite, filePath?: string): LoadedCase[] {
  const resolved = filePath ?? path.join(REPO_ROOT, SUITE_CONFIG[suite].sourcePath);
  const schema = SUITE_CONFIG[suite].schema;
  const lines = readFileSync(resolved, "utf8").split("\n");
  const cases: LoadedCase[] = [];
  const issues: string[] = [];
  const seen = new Map<string, number>();

  lines.forEach((text, index) => {
    if (text.trim().length === 0) return;
    const line = index + 1;
    let raw: unknown;

    try {
      raw = JSON.parse(text);
    } catch (error) {
      issues.push(`line ${line}: not valid JSON (${error instanceof Error ? error.message : String(error)})`);
      return;
    }

    const record = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : null;
    const caseId = record && typeof record.caseId === "string" && record.caseId.length > 0
      ? record.caseId
      : `line-${line}`;
    const parsed = schema.safeParse(raw);

    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "case"}: ${issue.message}`)
        .join("; ");
      issues.push(`${caseId} (line ${line}): ${detail}`);
      return;
    }

    const previous = seen.get(caseId);
    if (previous !== undefined) {
      issues.push(`${caseId} (line ${line}): duplicate caseId (already declared on line ${previous})`);
      return;
    }
    seen.set(caseId, line);
    cases.push({ raw: record!, caseId, line });
  });

  if (issues.length > 0) {
    throw new CaseValidationError(resolved, issues);
  }
  return cases;
}

// ---------------------------------------------------------------------------
// Fixture hashing
// ---------------------------------------------------------------------------

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, canonicalize(record[key])]),
    );
  }
  return value;
}

/**
 * Stable sha256 of the canonical JSON (recursively sorted keys) of a case.
 * Cases carry no timestamps or other volatile fields, so the whole
 * canonicalized case is hashed.
 */
export function fixtureHash(caseObj: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(caseObj))).digest("hex");
}

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

export type ParsedArgs = Record<string, string | boolean>;

export function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {};
  for (const token of argv) {
    if (!token.startsWith("--")) continue;
    const body = token.slice(2);
    const eq = body.indexOf("=");
    if (eq === -1) {
      args[body] = true;
    } else {
      args[body.slice(0, eq)] = body.slice(eq + 1);
    }
  }
  return args;
}

export function stringArg(args: ParsedArgs, name: string): string | undefined {
  const value = args[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function requireChoiceArg<T extends string>(
  args: ParsedArgs,
  name: string,
  choices: readonly T[],
): T {
  const value = stringArg(args, name);
  if (!value || !choices.includes(value as T)) {
    console.error(`Missing or invalid --${name}. Expected one of: ${choices.join("|")}`);
    process.exit(1);
  }
  return value as T;
}

export function gitCommit(): string {
  try {
    return execSync("git rev-parse HEAD", { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

// ---------------------------------------------------------------------------
// Local case execution and deterministic evaluation
// ---------------------------------------------------------------------------

/**
 * Returns a copy of the case prepared for the requested mode. Live mode strips
 * replay steps (the graph then calls the live model); replay mode passes the
 * case through unchanged.
 */
export function prepareCaseForMode(
  caseObj: Record<string, unknown>,
  mode: Mode,
): Record<string, unknown> {
  if (mode === "replay") return caseObj;
  const { replay: _replay, ...rest } = caseObj;
  return rest;
}

/**
 * Runs one case through the matching eval graph in this process. Graph modules
 * are imported lazily so scripts that never execute cases (e.g. seeding) do
 * not load production graph modules. Local replay runs require no LANGSMITH_*
 * or GOOGLE_API_KEY environment.
 */
export async function runCaseLocally(
  suite: Suite,
  caseObj: Record<string, unknown>,
  mode?: Mode,
): Promise<{ caseData: Record<string, unknown>; result: EvalResult }> {
  const prepared = mode ? prepareCaseForMode(caseObj, mode) : caseObj;
  const graph = suite === "query"
    ? (await import("../../app/server/evals/graphs/query-eval.graph")).createQueryEvalGraph()
    : (await import("../../app/server/evals/graphs/scan-eval.graph")).createScanEvalGraph();
  const state = await graph.invoke({ case: prepared, ...(mode ? { mode } : {}) });
  const result = (state as { result: EvalResult | null }).result;

  if (!result) {
    throw new Error(`Eval graph returned no result for case ${String(caseObj.caseId)}`);
  }
  return { caseData: prepared, result };
}

/** Runs every deterministic evaluator for the suite against one result. */
export async function runDeterministicEvaluators(
  suite: Suite,
  caseObj: Record<string, unknown>,
  result: EvalResult,
): Promise<EvalFeedback[]> {
  const evaluators = await import("../../app/server/evals/evaluators/index");

  if (suite === "query") {
    const caseData = QueryEvalCaseSchema.parse(caseObj);
    return evaluators.deterministicQueryEvaluators.flatMap((evaluator) =>
      evaluator({ caseData, result }),
    );
  }
  const caseData = ScanEvalCaseSchema.parse(caseObj);
  return evaluators.deterministicScanEvaluators.flatMap((evaluator) =>
    evaluator({ caseData, result }),
  );
}

/** Deterministic feedback keys that scored 0 (the hard gate). */
export function failingKeys(feedback: EvalFeedback[]): string[] {
  return feedback
    .filter((entry) => !JUDGE_FEEDBACK_KEYS.has(entry.key) && entry.score === 0)
    .map((entry) => entry.key);
}
