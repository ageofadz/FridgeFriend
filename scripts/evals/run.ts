// Experiment runner (spec "Experiment runner"). With LangSmith configured it
// runs `evaluate()` against the canonical dataset; without configuration,
// replay mode falls back to a fully local run over the committed JSONL.
//
// Usage:
//   npm run eval:query:replay [-- --split=smoke --concurrency=4]
//   tsx scripts/evals/run.ts --suite=query|scan --mode=replay|live
//     [--split=smoke|regression|live|safety] [--dataset-revision=<revision>]
//     [--concurrency=<n>] [--experiment-prefix=<prefix>] [--cases=<jsonl path>]

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { EvalFeedback, EvalResult } from "../../app/server/evals/schemas/eval-result";
import { EvalResultSchema } from "../../app/server/evals/schemas/eval-result";
import { getLangSmithConfig } from "../../app/server/langsmith.server";
import {
  failingKeys,
  gitCommit,
  loadSuiteCases,
  parseArgs,
  prepareCaseForMode,
  REPO_ROOT,
  requireChoiceArg,
  runCaseLocally,
  runDeterministicEvaluators,
  SUITE_CONFIG,
  stringArg,
  type Mode,
  type Suite,
} from "./lib";

const DEFAULT_CONCURRENCY: Record<Suite, Record<Mode, number>> = {
  query: { replay: 10, live: 2 },
  scan: { replay: 4, live: 1 },
};

type CaseOutcome = {
  caseId: string;
  status: string;
  feedback: EvalFeedback[];
  errored: boolean;
};

type Summary = {
  suite: Suite;
  mode: Mode;
  startedAt: string;
  gitCommit: string;
  graphRevision: string;
  caseCount: number;
  passed: number;
  failed: number;
  failures: Array<{ caseId: string; keys: string[] }>;
  experimentUrl?: string;
};

async function resolveGraphRevision(suite: Suite): Promise<string> {
  try {
    const { graphRevisionFor } = await import("../../app/server/observability/trace-context.server");
    if (suite === "query") {
      const { createQueryGraph } = await import("../../app/server/query/graph.server");
      return graphRevisionFor(createQueryGraph({ checkpointer: null } as never) as never);
    }
    const { createScanGraph } = await import("../../app/server/scan/graph.server");
    return graphRevisionFor((await createScanGraph({})) as never);
  } catch (error) {
    console.warn(`Could not compute graphRevision: ${error instanceof Error ? error.message : String(error)}`);
    return "unknown";
  }
}

async function resolvePromptRefs(): Promise<string[]> {
  try {
    const { loadPromptBundle } = await import("../../app/server/prompts/registry.server");
    const bundle = await loadPromptBundle();
    return Object.values(bundle).map((prompt) => prompt.ref).sort();
  } catch {
    return [];
  }
}

function outcomeOf(caseId: string, result: EvalResult, feedback: EvalFeedback[]): CaseOutcome {
  return {
    caseId,
    status: result.status,
    feedback,
    errored: result.status !== "completed" && result.status !== "interrupted",
  };
}

function summarize(input: {
  suite: Suite;
  mode: Mode;
  startedAt: string;
  graphRevision: string;
  outcomes: CaseOutcome[];
  experimentUrl?: string;
}): Summary {
  const failures = input.outcomes
    .map((outcome) => ({
      caseId: outcome.caseId,
      keys: [
        ...failingKeys(outcome.feedback),
        ...(outcome.errored ? ["case_errored"] : []),
      ],
    }))
    .filter((failure) => failure.keys.length > 0)
    .sort((left, right) => left.caseId.localeCompare(right.caseId));

  return {
    suite: input.suite,
    mode: input.mode,
    startedAt: input.startedAt,
    gitCommit: gitCommit(),
    graphRevision: input.graphRevision,
    caseCount: input.outcomes.length,
    passed: input.outcomes.length - failures.length,
    failed: failures.length,
    failures,
    ...(input.experimentUrl ? { experimentUrl: input.experimentUrl } : {}),
  };
}

function writeSummary(summary: Summary) {
  const dir = path.join(REPO_ROOT, "artifacts/observability");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `latest-${summary.suite}-${summary.mode}-experiment.json`);
  writeFileSync(file, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`\nSummary written to ${path.relative(REPO_ROOT, file)}`);
}

function printTable(outcomes: CaseOutcome[]) {
  const width = Math.max(8, ...outcomes.map((outcome) => outcome.caseId.length));
  console.log(`\n${"caseId".padEnd(width)}  ${"status".padEnd(15)}  result`);
  console.log(`${"-".repeat(width)}  ${"-".repeat(15)}  ------`);
  for (const outcome of outcomes) {
    const keys = [...failingKeys(outcome.feedback), ...(outcome.errored ? ["case_errored"] : [])];
    const verdict = keys.length === 0 ? "PASS" : `FAIL (${keys.join(", ")})`;
    console.log(`${outcome.caseId.padEnd(width)}  ${outcome.status.padEnd(15)}  ${verdict}`);
  }
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index]);
    }
  });
  await Promise.all(lanes);
  return results;
}

// ---------------------------------------------------------------------------
// Local (no LangSmith) replay path
// ---------------------------------------------------------------------------

async function runLocal(input: {
  suite: Suite;
  mode: Mode;
  split?: string;
  concurrency: number;
  casesPath?: string;
  graphRevision: string;
  startedAt: string;
}): Promise<Summary> {
  const all = loadSuiteCases(input.suite, input.casesPath);
  const cases = input.split ? all.filter((loaded) => loaded.raw.split === input.split) : all;
  console.log(
    `LangSmith not configured — running ${cases.length} ${input.suite} case(s) locally in ${input.mode} mode.`,
  );

  const outcomes = await mapWithConcurrency(cases, input.concurrency, async (loaded) => {
    try {
      const { caseData, result } = await runCaseLocally(input.suite, loaded.raw, input.mode);
      const feedback = await runDeterministicEvaluators(input.suite, caseData, result);
      return outcomeOf(loaded.caseId, result, feedback);
    } catch (error) {
      console.error(
        `  ${loaded.caseId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return {
        caseId: loaded.caseId,
        status: "failed",
        feedback: [],
        errored: true,
      } satisfies CaseOutcome;
    }
  });

  printTable(outcomes);
  return summarize({ ...input, outcomes });
}

// ---------------------------------------------------------------------------
// LangSmith evaluate() path
// ---------------------------------------------------------------------------

async function runWithLangSmith(input: {
  suite: Suite;
  mode: Mode;
  split?: string;
  datasetRevision: string;
  concurrency: number;
  experimentPrefix?: string;
  graphRevision: string;
  startedAt: string;
}): Promise<Summary> {
  const { Client } = await import("langsmith");
  const { evaluate } = await import("langsmith/evaluation");
  const { CHAT_MODEL } = await import("../../app/server/ai/chat-model.server");
  const config = getLangSmithConfig()!;
  const client = new Client({ apiKey: config.apiKey, apiUrl: config.endpoint });
  const { datasetName } = SUITE_CONFIG[input.suite];
  const schema = SUITE_CONFIG[input.suite].schema;
  const localCases = loadSuiteCases(input.suite);
  const selectedLocalCases = input.split
    ? localCases.filter((loaded) => loaded.raw.split === input.split)
    : localCases;
  const localCaseIds = new Set(selectedLocalCases.map((loaded) => loaded.caseId));
  const remoteExamples = [];
  for await (const example of client.listExamples({ datasetName })) {
    const caseId = example.metadata?.caseId;
    if (typeof caseId === "string" && localCaseIds.has(caseId)) {
      remoteExamples.push(example);
    }
  }
  const remoteCaseIds = new Set(
    remoteExamples.flatMap((example) =>
      typeof example.metadata?.caseId === "string" ? [example.metadata.caseId] : [],
    ),
  );
  const missingCaseIds = selectedLocalCases
    .map((loaded) => loaded.caseId)
    .filter((caseId) => !remoteCaseIds.has(caseId));

  if (missingCaseIds.length > 0) {
    throw new Error(
      `LangSmith dataset ${datasetName} is missing current ${input.suite} eval cases: ` +
        `${missingCaseIds.join(", ")}. Run \`npm run eval:seed -- --suite=${input.suite} --replace\`.`,
    );
  }

  const target = async (inputs: Record<string, unknown>) => {
    const caseObj = inputs.case;
    if (typeof caseObj !== "object" || caseObj === null || Array.isArray(caseObj)) {
      throw new Error(
        `LangSmith ${input.suite} dataset example is missing inputs.case. ` +
          `Run \`npm run eval:seed -- --suite=${input.suite} --replace\` to migrate the dataset.`,
      );
    }
    const { result } = await runCaseLocally(input.suite, caseObj as Record<string, unknown>, input.mode);
    return { result };
  };

  const deterministicEvaluator = async (args: {
    inputs: Record<string, unknown>;
    outputs: Record<string, unknown>;
  }) => {
    const caseObj = prepareCaseForMode(args.inputs.case as Record<string, unknown>, input.mode);
    const result = EvalResultSchema.parse(args.outputs.result);
    const feedback = await runDeterministicEvaluators(input.suite, caseObj, result);
    return {
      results: feedback.map((entry) => ({
        key: entry.key,
        score: entry.score,
        comment: entry.comment,
      })),
    };
  };

  const evaluators: Array<typeof deterministicEvaluator> = [deterministicEvaluator];

  if (input.suite === "query" && input.mode === "live") {
    const { loadEvalPromptBundle } = await import("../../app/server/prompts/registry.server");
    const { evaluateQueryAnswerGrounding } = await import(
      "../../app/server/evals/evaluators/query-answer-grounding.evaluator"
    );
    const evalBundle = await loadEvalPromptBundle();

    evaluators.push(async (args) => {
      const caseObj = prepareCaseForMode(args.inputs.case as Record<string, unknown>, input.mode);
      const caseData = schema.parse(caseObj) as never;
      const result = EvalResultSchema.parse(args.outputs.result);
      const feedback = await evaluateQueryAnswerGrounding({
        caseData,
        result,
        promptBundle: evalBundle,
      });
      return {
        results: feedback.map((entry) => ({
          key: entry.key,
          score: entry.score,
          comment: entry.comment,
        })),
      };
    });
  }

  const promptRefs = await resolvePromptRefs();
  const experimentMetadata = {
    suite: input.suite,
    mode: input.mode,
    datasetRevision: input.datasetRevision,
    graphRevision: input.graphRevision,
    models: CHAT_MODEL,
    prompts: promptRefs,
    tools: [] as Array<{ name: string; description: string }>,
    gitCommit: gitCommit(),
    environment: "evaluation",
  };

  const results = await evaluate(target, {
    data: remoteExamples,
    evaluators: evaluators as never,
    client,
    maxConcurrency: input.concurrency,
    experimentPrefix:
      input.experimentPrefix ?? `fridgefriend-${input.suite}-${input.mode}`,
    metadata: experimentMetadata,
  });

  const outcomes: CaseOutcome[] = [];
  for (const row of results.results) {
    const caseObj = row.example.inputs?.case as Record<string, unknown> | undefined;
    const caseId = typeof caseObj?.caseId === "string" ? caseObj.caseId : String(row.example.id);
    const parsed = EvalResultSchema.safeParse(row.run.outputs?.result);
    const status = row.run.error
      ? "failed"
      : parsed.success
      ? parsed.data.status
      : "failed";
    const feedback = (row.evaluationResults?.results ?? []).map((entry) => ({
      key: entry.key,
      score: typeof entry.score === "number" ? entry.score : entry.score === true ? 1 : 0,
      comment: entry.comment ?? "",
    }));
    outcomes.push({
      caseId,
      status,
      feedback,
      errored: status !== "completed" && status !== "interrupted",
    });
  }

  let experimentUrl: string | undefined;
  try {
    const dataset = await client.readDataset({ datasetName });
    const project = await client.readProject({ projectName: results.experimentName });
    experimentUrl = `${client.getHostUrl()}/datasets/${dataset.id}/compare?selectedSessions=${project.id}`;
  } catch {
    experimentUrl = undefined;
  }

  console.log(`\nExperiment: ${results.experimentName}`);
  if (experimentUrl) {
    console.log(`Experiment URL: ${experimentUrl}`);
  }
  printTable(outcomes);
  return summarize({ ...input, outcomes, experimentUrl });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const suite = requireChoiceArg(args, "suite", ["query", "scan"] as const);
  const mode = requireChoiceArg(args, "mode", ["replay", "live"] as const);
  const split = stringArg(args, "split");
  const datasetRevision = stringArg(args, "dataset-revision") ?? "v1";
  const concurrency = Number(stringArg(args, "concurrency") ?? DEFAULT_CONCURRENCY[suite][mode]);
  const experimentPrefix = stringArg(args, "experiment-prefix");
  const casesPath = stringArg(args, "cases");
  const startedAt = new Date().toISOString();

  let config: ReturnType<typeof getLangSmithConfig>;
  try {
    config = getLangSmithConfig();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  let summary: Summary;
  if (config) {
    const graphRevision = await resolveGraphRevision(suite);
    summary = await runWithLangSmith({
      suite,
      mode,
      split,
      datasetRevision,
      concurrency,
      experimentPrefix,
      graphRevision,
      startedAt,
    });
  } else if (mode === "replay") {
    const graphRevision = await resolveGraphRevision(suite);
    summary = await runLocal({ suite, mode, split, concurrency, casesPath, graphRevision, startedAt });
  } else {
    console.error(
      "Live mode requires LangSmith configuration (LANGSMITH_ENDPOINT, LANGSMITH_API_KEY, " +
        "LANGSMITH_PROJECT) plus GOOGLE_API_KEY. Replay mode runs locally without credentials.",
    );
    process.exit(1);
  }

  writeSummary(summary!);
  console.log(
    `\n${summary!.passed}/${summary!.caseCount} case(s) passed the deterministic gate.` +
      (summary!.failed > 0 ? ` ${summary!.failed} failed.` : ""),
  );

  // Deterministic contract/safety failures and errored cases are the hard
  // gate; live judge scores are reported but never gate (spec "CI gates").
  if (summary!.failed > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
