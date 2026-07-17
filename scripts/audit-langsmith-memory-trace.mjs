import { Client } from "langsmith";

const runId = process.argv[2]?.trim();

if (!runId) {
  throw new Error("Usage: node scripts/audit-langsmith-memory-trace.mjs <run-id>");
}

const requiredEnv = ["LANGSMITH_ENDPOINT", "LANGSMITH_API_KEY", "LANGSMITH_PROJECT"];
const missing = requiredEnv.filter((key) => !process.env[key]?.trim());

if (missing.length > 0) {
  throw new Error(`Missing LangSmith environment variables: ${missing.join(", ")}`);
}

const client = new Client({
  apiKey: process.env.LANGSMITH_API_KEY,
  apiUrl: process.env.LANGSMITH_ENDPOINT,
});

function flattenRuns(run) {
  const children = Array.isArray(run.child_runs) ? run.child_runs : [];
  return [run, ...children.flatMap(flattenRuns)];
}

function includesMemorySignal(run) {
  const haystack = [
    run.name,
    run.run_type,
    ...(Array.isArray(run.tags) ? run.tags : []),
    JSON.stringify(run.inputs ?? {}),
    JSON.stringify(run.outputs ?? {}),
  ].join("\n");

  return /memory|general_chat|apply_memory_writes|index_semantic_memory|reload_memory_context|dietaryPreferences|memoryWriteResults|memoryWriteVerification/iu.test(haystack);
}

function summarizeRun(run) {
  return {
    id: run.id,
    name: run.name,
    runType: run.run_type,
    parentRunId: run.parent_run_id ?? null,
    status: run.error ? "error" : "ok",
    error: run.error ?? null,
    tags: run.tags ?? [],
    inputs: run.inputs ?? null,
    outputs: run.outputs ?? null,
  };
}

const root = await client.readRun(runId, { loadChildRuns: true });
const runs = flattenRuns(root).filter(includesMemorySignal).map(summarizeRun);

process.stdout.write(`${JSON.stringify({
  runId,
  project: process.env.LANGSMITH_PROJECT,
  root: summarizeRun(root),
  memoryRelatedRuns: runs,
}, null, 2)}\n`);
