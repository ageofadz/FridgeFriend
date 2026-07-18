// Query graph coverage baseline generator (spec "Query graph coverage
// requirement" and "Generated graph artifacts"). Runs every replay case in
// the canonical query JSONL locally, computes coverage against the compiled
// production topology, and writes the four committed artifacts.
//
// Usage: npm run eval:coverage [-- --cases=<jsonl path>]
// Exit nonzero when nodeCoverage < 0.5, intentCoverage < 1.0, or any case
// failed execution.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  computeCoverage,
  extractTopology,
  topologyToMermaid,
  QUERY_NODE_CLASSES,
  QUERY_TOP_LEVEL_INTENTS,
  type CoverageReport,
} from "../../app/server/observability/graph-coverage";
import { graphRevisionFor } from "../../app/server/observability/trace-context.server";
import { QueryEvalCaseSchema } from "../../app/server/evals/schemas/query-eval-case";
import { trajectoryNodeNames } from "../../app/server/evals/schemas/trajectory";
import {
  failingKeys,
  loadSuiteCases,
  parseArgs,
  runCaseLocally,
  runDeterministicEvaluators,
  REPO_ROOT,
  stringArg,
} from "./lib";

// Static per-node documentation: one-line description and the external
// dependencies each node uses in production (fixture adapters replace all of
// them during evals).
const NODE_INFO: Record<string, { description: string; deps: string }> = {
  load_context: { description: "Loads scanned inventory and memory context for the fridge/image.", deps: "sqlite" },
  apply_seeded_inventory_assertions: { description: "Applies model-extracted seeded external-inventory assertions before the lanes fan out.", deps: "model, sqlite" },
  extract_memory_candidates: { description: "Extracts memory candidates (inventory changes, diet, goals) from the user query.", deps: "model" },
  filter_recipe_goal_candidates: { description: "Deterministically filters recipe-goal memory candidates.", deps: "none" },
  validate_memory_candidates: { description: "Validates memory candidates against loaded context.", deps: "none" },
  apply_memory_writes: { description: "Interrupt: pauses for inventory-mutation review, then persists approved memory writes.", deps: "sqlite" },
  index_semantic_memory: { description: "Indexes semantic memories into the vector store.", deps: "chroma" },
  reload_memory_context: { description: "Reloads memory context after writes so the response lane sees fresh state.", deps: "sqlite" },
  await_memory_before_intent: { description: "Parallel-lane barrier: intent lane waits for memory classification.", deps: "none" },
  intent_ready_for_memory: { description: "Parallel-lane barrier: signals intent completion to the memory lane.", deps: "none" },
  memory_candidates_ready: { description: "Parallel-lane barrier: memory candidates extracted.", deps: "none" },
  continue_after_memory_classification: { description: "Parallel-lane barrier: resumes after memory classification.", deps: "none" },
  memory_ready_for_intent: { description: "Parallel-lane barrier: memory lane ready for intent join.", deps: "none" },
  continue_after_memory: { description: "Parallel-lane barrier: resumes the response lane after memory writes.", deps: "none" },
  memory_lane_finished: { description: "Parallel-lane barrier: marks the memory lane as finished.", deps: "none" },
  response_lane_finished: { description: "Parallel-lane barrier: marks the response lane as finished.", deps: "none" },
  determine_intent: { description: "Classifies the top-level intent (embedding router + structured model call).", deps: "model, chroma" },
  build_recipe_search: { description: "Builds a structured recipe search request from the query.", deps: "model" },
  query_inventory: { description: "Queries household inventory for the active scope.", deps: "sqlite" },
  propose_scoped_inventory_split: { description: "Proposes a scoped inventory split for review.", deps: "model" },
  review_inventory_split: { description: "Interrupt: pauses for human review of the proposed inventory split.", deps: "none" },
  plan_expiry: { description: "Plans expiry answers from inventory freshness data.", deps: "none" },
  assess_inventory_enrichment: { description: "Decides whether focused inventory enrichment is needed.", deps: "none" },
  run_focused_inventory_enrichment: { description: "Runs focused enrichment over image crops for ambiguous items.", deps: "model" },
  request_inventory_clarification: { description: "Interrupt: asks the user clarification questions about inventory.", deps: "model" },
  persist_inventory_enrichment: { description: "Persists corrected enrichment evidence.", deps: "sqlite" },
  retrieve_recipes: { description: "Retrieves recipe candidates from the vector index.", deps: "chroma" },
  rank_retrieved_recipes: { description: "Deterministically ranks retrieved recipe candidates.", deps: "none" },
  grade_recipe_retrieval: { description: "Grades retrieval relevance to decide keep vs rewrite.", deps: "model" },
  rewrite_recipe_query: { description: "Rewrites the recipe query for another retrieval round.", deps: "none" },
  evaluate_recipe: { description: "Evaluates one recipe in the tournament bracket.", deps: "model" },
  resolve_recipe_tournament: { description: "Resolves tournament results into final recipe picks.", deps: "none" },
  plan_groceries: { description: "Selects grocery recipes and assigns aisles.", deps: "model" },
  plan_pantry_completion: { description: "Plans pantry-completion shopping from near-complete recipes.", deps: "model, chroma" },
  plan_organization: { description: "Plans kitchen organization moves.", deps: "model" },
  plan_placement_correction: { description: "Plans corrections for misplaced items.", deps: "none" },
  calculate_space: { description: "Calculates available storage space.", deps: "none" },
  request_clarification: { description: "Prepares a clarification response when intent is ambiguous.", deps: "none" },
  plan_workspace_actions: { description: "Plans structured workspace actions for the UI.", deps: "model" },
  respond: { description: "Composes the final natural-language answer.", deps: "model" },
};

const INTERRUPT_NODES = new Set([
  "apply_memory_writes",
  "review_inventory_split",
  "request_inventory_clarification",
]);

type CaseRun = {
  caseId: string;
  status: string;
  passed: boolean;
  failingKeys: string[];
  intent?: string;
  nodes: string[];
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const casesPath = stringArg(args, "cases");
  const cases = loadSuiteCases("query", casesPath);
  const replayCases = cases.filter(
    (loaded) => Array.isArray(loaded.raw.replay) && (loaded.raw.replay as unknown[]).length > 0,
  );
  console.log(`Running ${replayCases.length} replay case(s) of ${cases.length} total.`);

  const runs: CaseRun[] = [];
  for (const loaded of replayCases) {
    try {
      const { result } = await runCaseLocally("query", loaded.raw, "replay");
      const feedback = await runDeterministicEvaluators("query", loaded.raw, result);
      const keys = failingKeys(feedback);
      const errored = result.status !== "completed" && result.status !== "interrupted";
      const parsed = QueryEvalCaseSchema.parse(loaded.raw);
      runs.push({
        caseId: loaded.caseId,
        status: result.status,
        passed: !errored && keys.length === 0,
        failingKeys: [...keys, ...(errored ? ["case_errored"] : [])],
        intent: parsed.expected.intent,
        nodes: [...new Set(trajectoryNodeNames(result.trajectory))],
      });
      console.log(`  ${loaded.caseId}: ${result.status}${keys.length > 0 ? ` (failing: ${keys.join(", ")})` : ""}`);
    } catch (error) {
      runs.push({ caseId: loaded.caseId, status: "failed", passed: false, failingKeys: ["case_errored"], nodes: [] });
      console.error(`  ${loaded.caseId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const { createQueryGraph } = await import("../../app/server/query/graph.server");
  const compiled = createQueryGraph({ checkpointer: null } as never);
  const topology = extractTopology(compiled as never);
  const graphRevision = graphRevisionFor(compiled as never);

  const passing = runs.filter((run) => run.passed).sort((a, b) => a.caseId.localeCompare(b.caseId));
  const failed = runs.filter((run) => !run.passed);
  const trajectories = passing.map((run) => ({ caseId: run.caseId, nodes: run.nodes }));
  const coveredIntents = [...new Set(passing.flatMap((run) => (run.intent ? [run.intent] : [])))].sort();

  // __start__/__end__ are already stripped by extractTopology; no further
  // exclusions are claimed for the baseline.
  const report = computeCoverage({
    topology,
    trajectories,
    intentRoutes: { covered: coveredIntents, all: [...QUERY_TOP_LEVEL_INTENTS] },
    exclusions: [],
  });

  const generatedAt = new Date().toISOString();
  const dir = path.join(REPO_ROOT, "artifacts/observability");
  mkdirSync(dir, { recursive: true });

  writeFileSync(
    path.join(dir, "query-coverage-baseline.json"),
    `${JSON.stringify({ generatedAt, graphRevision, coverage: report, trajectories }, null, 2)}\n`,
  );
  writeFileSync(path.join(dir, "query-coverage-baseline.md"), coverageMarkdown(report, graphRevision, generatedAt, failed));
  const mermaid = topologyToMermaid(topology, {
    nodeClasses: QUERY_NODE_CLASSES,
    coveredNodes: report.coveredNodes,
  });
  writeFileSync(path.join(dir, "query-graph.mmd"), mermaid);
  writeFileSync(path.join(dir, "query-graph.md"), graphMarkdown(mermaid, topology.nodes, report, graphRevision, generatedAt));

  console.log(`\nnodeCoverage=${report.nodeCoverage.toFixed(3)} edgeCoverage=${report.edgeCoverage.toFixed(3)} intentCoverage=${report.intentCoverage.toFixed(3)}`);
  console.log(`Artifacts written to ${path.relative(REPO_ROOT, dir)}/`);

  const gateFailures: string[] = [];
  if (report.nodeCoverage < 0.5) gateFailures.push(`nodeCoverage ${report.nodeCoverage.toFixed(3)} < 0.5`);
  if (report.intentCoverage < 1.0) gateFailures.push(`intentCoverage ${report.intentCoverage.toFixed(3)} < 1.0`);
  if (failed.length > 0) gateFailures.push(`${failed.length} case(s) failed: ${failed.map((run) => run.caseId).join(", ")}`);

  if (gateFailures.length > 0) {
    console.error(`\nCoverage gate FAILED:\n  - ${gateFailures.join("\n  - ")}`);
    process.exit(1);
  }
  console.log("\nCoverage gate passed.");
}

function coverageMarkdown(
  report: CoverageReport,
  graphRevision: string,
  generatedAt: string,
  failed: CaseRun[],
): string {
  const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
  const list = (items: string[]) => (items.length > 0 ? items.map((item) => `- \`${item}\``).join("\n") : "_none_");
  const nodeCaseRows = Object.entries(report.nodeCases)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([node, cases]) => `| \`${node}\` | ${cases.map((id) => `\`${id}\``).join(", ")} |`)
    .join("\n");
  const exclusionRows = report.exclusions.length > 0
    ? report.exclusions.map((exclusion) => `| \`${exclusion.node}\` | ${exclusion.reason} |`).join("\n")
    : "| _none_ | `__start__`/`__end__` sentinels and `branch:*` pseudo-nodes are already stripped by `extractTopology` |";

  return `# Query graph coverage baseline

Generated: ${generatedAt}
Graph revision: \`${graphRevision}\`

Generated by \`npm run eval:coverage\` from \`examples/evals/query-v1.jsonl\`. Do not edit by hand.

## Summary

| Metric | Value | Gate |
| --- | --- | --- |
| Node coverage | ${pct(report.nodeCoverage)} (${report.coveredNodes.length}/${report.coveredNodes.length + report.uncoveredNodes.length}) | >= 50% |
| Edge coverage | ${pct(report.edgeCoverage)} (${report.coveredEdges.length}/${report.coveredEdges.length + report.uncoveredEdges.length}) | reported only |
| Intent coverage | ${pct(report.intentCoverage)} | = 100% |
${failed.length > 0 ? `\n**${failed.length} case(s) failed execution:** ${failed.map((run) => `\`${run.caseId}\` (${run.failingKeys.join(", ")})`).join(", ")}\n` : ""}
## Covered nodes

${list(report.coveredNodes)}

## Uncovered nodes

${list(report.uncoveredNodes)}

## Covered edges

${list(report.coveredEdges)}

## Uncovered edges

${list(report.uncoveredEdges)}

## Cases per covered node

| Node | Covering cases |
| --- | --- |
${nodeCaseRows || "| _none_ | |"}

## Exclusions

| Node | Reason |
| --- | --- |
${exclusionRows}
`;
}

function graphMarkdown(
  mermaid: string,
  nodes: string[],
  report: CoverageReport,
  graphRevision: string,
  generatedAt: string,
): string {
  const covered = new Set(report.coveredNodes);
  const rows = nodes
    .map((node) => {
      const info = NODE_INFO[node] ?? { description: "(undocumented node)", deps: "unknown" };
      const nodeClass = QUERY_NODE_CLASSES[node] ?? "deterministic";
      const cases = report.nodeCases[node] ?? [];
      return `| \`${node}\` | ${info.description} | ${nodeClass} | ${info.deps} | ${INTERRUPT_NODES.has(node) ? "yes" : "no"} | ${covered.has(node) ? "yes" : "no"} | ${cases.map((id) => `\`${id}\``).join(", ") || "—"} |`;
    })
    .join("\n");

  return `# Query graph topology

Generated: ${generatedAt}
Graph revision: \`${graphRevision}\`

Generated by \`npm run eval:coverage\` from the compiled production query graph (never hand-maintained). Node colors: blue = deterministic, orange = model-backed, green = retrieval/tool, purple = persistence, red = interrupt/review; dashed grey = not covered by the canonical suite. Dotted arrows are conditional routes.

\`\`\`mermaid
${mermaid.trimEnd()}
\`\`\`

## Nodes

External dependencies list what each node touches in production; eval runs replace all of them with in-memory fixture adapters and replayed model outputs.

| Node | Description | Class | External deps | Interrupt? | Covered? | Covering cases |
| --- | --- | --- | --- | --- | --- | --- |
${rows}

## Loops

- **Recipe retrieval loop:** \`retrieve_recipes\` -> \`grade_recipe_retrieval\` -> \`rewrite_recipe_query\` -> \`retrieve_recipes\`. The grade node decides whether retrieval is good enough; the rewrite node reformulates the query and re-enters retrieval (bounded retries).
- **Recipe tournament loop:** \`evaluate_recipe\` is re-entered per bracket matchup until \`resolve_recipe_tournament\` can pick winners.

## Interrupt points

- \`apply_memory_writes\` — \`inventory_mutation_review\`: approve/reject a proposed inventory mutation before anything is persisted.
- \`review_inventory_split\` — \`inventory_split_review\`: approve/reject a proposed scoped inventory split.
- \`request_inventory_clarification\` — \`inventory_clarification\`: answers to enrichment clarification questions.

All interrupts resume on the same eval thread via \`Command({ resume })\` with a fresh per-case \`MemorySaver\`.

## Parallel lanes

\`apply_seeded_inventory_assertions\` fans out to the memory lane (\`extract_memory_candidates\` ...) and the intent lane (\`determine_intent\` ...) which run in parallel and join through the barrier nodes (\`await_memory_before_intent\`, \`memory_lane_finished\`, \`response_lane_finished\`, ...). This is why replay ordering is enforced per call site rather than globally.
`;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
