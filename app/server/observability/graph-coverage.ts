// Graph coverage source of truth. Topology is derived from the compiled
// LangGraph (`compiled.getGraph()`), never from a handwritten node list.

export type GraphTopology = {
  nodes: string[];
  edges: Array<{ source: string; target: string; conditional: boolean }>;
};

export type CoverageReport = {
  nodeCoverage: number;
  edgeCoverage: number;
  intentCoverage: number;
  coveredNodes: string[];
  uncoveredNodes: string[];
  coveredEdges: string[];
  uncoveredEdges: string[];
  nodeCases: Record<string, string[]>;
  exclusions: Array<{ node: string; reason: string }>;
};

export type NodeClass =
  | "deterministic"
  | "model"
  | "retrieval"
  | "persistence"
  | "interrupt"
  | "uncovered";

const GRAPH_SENTINELS = new Set(["__start__", "__end__"]);

function isBranchPseudoNode(name: string) {
  return name.startsWith("branch:") || name.includes(":branch:");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Extracts nodes and edges from a compiled graph's drawable representation.
 * `getGraph()` returns `{ nodes: Record<string, {id, name, data}>, edges:
 * Array<{source, target, conditional, data?}> }`; conditional edges can
 * appear multiple times for the same source/target pair, so edges are
 * deduplicated (a pair is conditional when any duplicate is).
 */
export function extractTopology(compiled: { getGraph(): unknown }): GraphTopology {
  const drawable = compiled.getGraph();

  if (!isRecord(drawable) || !isRecord(drawable.nodes) || !Array.isArray(drawable.edges)) {
    throw new Error("Compiled graph getGraph() did not return a drawable graph with nodes and edges");
  }

  const excluded = (name: string) => GRAPH_SENTINELS.has(name) || isBranchPseudoNode(name);
  const nodes = Object.keys(drawable.nodes).filter((name) => !excluded(name));
  const edgeMap = new Map<string, { source: string; target: string; conditional: boolean }>();

  for (const edge of drawable.edges) {
    if (!isRecord(edge) || typeof edge.source !== "string" || typeof edge.target !== "string") {
      continue;
    }
    if (excluded(edge.source) || excluded(edge.target)) {
      continue;
    }
    const key = `${edge.source}->${edge.target}`;
    const existing = edgeMap.get(key);
    const conditional = edge.conditional === true || existing?.conditional === true;
    edgeMap.set(key, { source: edge.source, target: edge.target, conditional });
  }

  return {
    nodes,
    edges: [...edgeMap.values()],
  };
}

export function edgeKey(edge: { source: string; target: string }) {
  return `${edge.source}->${edge.target}`;
}

/**
 * Computes node/edge/intent coverage against recorded trajectories. All
 * coverage numbers are fractions in [0, 1].
 *
 * Edge coverage is approximate: an edge `a->b` counts as covered when the
 * edge exists in the topology and `b` appears after `a` somewhere in a
 * trajectory's node order. Parallel lanes (memory lane vs intent lane)
 * interleave in the update stream, so ordering is a heuristic rather than a
 * literal transition record; it never marks edges absent from the topology.
 */
export function computeCoverage(input: {
  topology: GraphTopology;
  trajectories: Array<{ caseId: string; nodes: string[] }>;
  intentRoutes: { covered: string[]; all: string[] };
  exclusions?: Array<{ node: string; reason: string }>;
}): CoverageReport {
  const exclusions = input.exclusions ?? [];
  const excludedNodes = new Set(exclusions.map((exclusion) => exclusion.node));
  const countedNodes = input.topology.nodes.filter((node) => !excludedNodes.has(node));
  const countedEdges = input.topology.edges.filter(
    (edge) => !excludedNodes.has(edge.source) && !excludedNodes.has(edge.target),
  );

  const nodeCases = new Map<string, Set<string>>();
  for (const trajectory of input.trajectories) {
    for (const node of trajectory.nodes) {
      if (!nodeCases.has(node)) {
        nodeCases.set(node, new Set());
      }
      nodeCases.get(node)!.add(trajectory.caseId);
    }
  }

  const coveredNodes = countedNodes.filter((node) => nodeCases.has(node));
  const uncoveredNodes = countedNodes.filter((node) => !nodeCases.has(node));

  const edgeCovered = (edge: { source: string; target: string }) =>
    input.trajectories.some((trajectory) => {
      const sourceIndex = trajectory.nodes.indexOf(edge.source);
      if (sourceIndex === -1) return false;
      return trajectory.nodes.slice(sourceIndex + 1).includes(edge.target);
    });

  const coveredEdges = countedEdges.filter(edgeCovered).map(edgeKey);
  const uncoveredEdges = countedEdges.filter((edge) => !edgeCovered(edge)).map(edgeKey);

  const allIntents = input.intentRoutes.all;
  const coveredIntents = input.intentRoutes.covered.filter((intent) => allIntents.includes(intent));

  const ratio = (covered: number, total: number) => (total === 0 ? 1 : covered / total);

  return {
    nodeCoverage: ratio(coveredNodes.length, countedNodes.length),
    edgeCoverage: ratio(coveredEdges.length, countedEdges.length),
    intentCoverage: ratio(new Set(coveredIntents).size, allIntents.length),
    coveredNodes,
    uncoveredNodes,
    coveredEdges,
    uncoveredEdges,
    nodeCases: Object.fromEntries(
      [...nodeCases.entries()]
        .filter(([node]) => countedNodes.includes(node))
        .map(([node, cases]) => [node, [...cases].sort()]),
    ),
    exclusions,
  };
}

const MERMAID_CLASS_DEFS: Record<Exclude<NodeClass, never>, string> = {
  deterministic: "fill:#e8eef7,stroke:#4a6fa5,color:#1d3557",
  model: "fill:#fdeadd,stroke:#e07a2f,color:#7a3803",
  retrieval: "fill:#e3f4e8,stroke:#3f9159,color:#1d5731",
  persistence: "fill:#efe5f7,stroke:#8250b5,color:#4a2372",
  interrupt: "fill:#fbe3e6,stroke:#c9414f,color:#7c1f28",
  uncovered: "fill:#f2f2f2,stroke:#9a9a9a,color:#5c5c5c,stroke-dasharray: 4 3",
};

/**
 * Renders the topology as a Mermaid flowchart. Conditional edges use dotted
 * arrows. When `coveredNodes` is provided, nodes outside it are styled
 * `uncovered` regardless of their declared class.
 */
export function topologyToMermaid(
  topology: GraphTopology,
  opts: {
    nodeClasses?: Record<string, NodeClass>;
    coveredNodes?: string[];
  } = {},
): string {
  const covered = opts.coveredNodes ? new Set(opts.coveredNodes) : null;
  const lines: string[] = ["flowchart TD"];

  for (const node of topology.nodes) {
    lines.push(`  ${node}["${node}"]`);
  }

  for (const edge of topology.edges) {
    lines.push(`  ${edge.source} ${edge.conditional ? "-.->" : "-->"} ${edge.target}`);
  }

  for (const [className, style] of Object.entries(MERMAID_CLASS_DEFS)) {
    lines.push(`  classDef ${className} ${style}`);
  }

  const grouped = new Map<NodeClass, string[]>();
  for (const node of topology.nodes) {
    const declared = opts.nodeClasses?.[node] ?? "deterministic";
    const effective: NodeClass = covered && !covered.has(node) ? "uncovered" : declared;
    if (!grouped.has(effective)) {
      grouped.set(effective, []);
    }
    grouped.get(effective)!.push(node);
  }

  for (const [className, nodes] of grouped) {
    lines.push(`  class ${nodes.join(",")} ${className}`);
  }

  return `${lines.join("\n")}\n`;
}

// Classification of every production query-graph node. Model-backed nodes are
// the replay call-site registry nodes plus determine_intent. Interrupt wins
// over persistence and model for nodes that pause execution for review.
export const QUERY_NODE_CLASSES: Record<string, NodeClass> = {
  load_context: "retrieval",
  apply_seeded_inventory_assertions: "model",
  extract_memory_candidates: "model",
  filter_recipe_goal_candidates: "deterministic",
  validate_memory_candidates: "deterministic",
  apply_memory_writes: "interrupt",
  index_semantic_memory: "persistence",
  reload_memory_context: "retrieval",
  await_memory_before_intent: "deterministic",
  intent_ready_for_memory: "deterministic",
  memory_candidates_ready: "deterministic",
  continue_after_memory_classification: "deterministic",
  memory_ready_for_intent: "deterministic",
  continue_after_memory: "deterministic",
  memory_lane_finished: "deterministic",
  response_lane_finished: "deterministic",
  determine_intent: "model",
  build_recipe_search: "model",
  query_inventory: "retrieval",
  propose_scoped_inventory_split: "model",
  review_inventory_split: "interrupt",
  plan_expiry: "deterministic",
  assess_inventory_enrichment: "deterministic",
  run_focused_inventory_enrichment: "model",
  request_inventory_clarification: "interrupt",
  persist_inventory_enrichment: "persistence",
  retrieve_recipes: "retrieval",
  rank_retrieved_recipes: "deterministic",
  grade_recipe_retrieval: "model",
  rewrite_recipe_query: "deterministic",
  evaluate_recipe: "model",
  resolve_recipe_tournament: "deterministic",
  plan_groceries: "model",
  plan_pantry_completion: "model",
  plan_organization: "model",
  plan_placement_correction: "deterministic",
  calculate_space: "deterministic",
  request_clarification: "deterministic",
  plan_workspace_actions: "model",
  respond: "model",
};

export const QUERY_TOP_LEVEL_INTENTS = [
  "inventory",
  "expiry",
  "food_knowledge",
  "recipe",
  "shopping",
  "space",
  "organization",
  "placement_correction",
  "general_chat",
  "clarification",
] as const;
