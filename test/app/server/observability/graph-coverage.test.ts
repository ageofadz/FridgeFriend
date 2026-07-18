import { describe, expect, it } from "vitest";

import { createQueryGraph } from "../../../../app/server/query/graph.server";
import {
  computeCoverage,
  extractTopology,
  topologyToMermaid,
  QUERY_NODE_CLASSES,
  QUERY_TOP_LEVEL_INTENTS,
  type GraphTopology,
} from "../../../../app/server/observability/graph-coverage";
import { graphRevisionFor } from "../../../../app/server/observability/trace-context.server";

describe("extractTopology", () => {
  const topology = extractTopology(createQueryGraph({ checkpointer: null }));

  it("derives the real query graph topology without sentinels", () => {
    expect(topology.nodes.length).toBeGreaterThan(30);
    expect(topology.nodes).toContain("determine_intent");
    expect(topology.nodes).toContain("respond");
    expect(topology.nodes).not.toContain("__start__");
    expect(topology.nodes).not.toContain("__end__");
    for (const edge of topology.edges) {
      expect(edge.source).not.toBe("__start__");
      expect(edge.target).not.toBe("__end__");
    }
  });

  it("deduplicates edges and keeps conditional flags", () => {
    const keys = topology.edges.map((edge) => `${edge.source}->${edge.target}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(topology.edges.some((edge) => edge.conditional)).toBe(true);
  });

  it("classifies every production node exactly once", () => {
    expect(Object.keys(QUERY_NODE_CLASSES).sort()).toEqual([...topology.nodes].sort());
  });

  it("yields a stable graph revision", () => {
    const graph = createQueryGraph({ checkpointer: null });
    expect(graphRevisionFor(graph)).toBe(graphRevisionFor(createQueryGraph({ checkpointer: null })));
    expect(graphRevisionFor(graph)).toMatch(/^[0-9a-f]{16}$/);
  });
});

const syntheticTopology: GraphTopology = {
  nodes: ["a", "b", "c", "d"],
  edges: [
    { source: "a", target: "b", conditional: false },
    { source: "b", target: "c", conditional: true },
    { source: "b", target: "d", conditional: true },
    { source: "c", target: "d", conditional: false },
  ],
};

describe("computeCoverage", () => {
  it("computes known percentages on a synthetic topology", () => {
    const report = computeCoverage({
      topology: syntheticTopology,
      trajectories: [
        { caseId: "case-1", nodes: ["a", "b", "c"] },
        { caseId: "case-2", nodes: ["a", "b"] },
      ],
      intentRoutes: { covered: ["recipe", "inventory"], all: ["recipe", "inventory", "expiry", "shopping"] },
    });

    // 3 of 4 nodes, 2 of 4 edges (a->b, b->c), 2 of 4 intents.
    expect(report.nodeCoverage).toBeCloseTo(0.75);
    expect(report.edgeCoverage).toBeCloseTo(0.5);
    expect(report.intentCoverage).toBeCloseTo(0.5);
    expect(report.coveredNodes).toEqual(["a", "b", "c"]);
    expect(report.uncoveredNodes).toEqual(["d"]);
    expect(report.coveredEdges.sort()).toEqual(["a->b", "b->c"]);
    expect(report.uncoveredEdges.sort()).toEqual(["b->d", "c->d"]);
    expect(report.nodeCases).toEqual({
      a: ["case-1", "case-2"],
      b: ["case-1", "case-2"],
      c: ["case-1"],
    });
  });

  it("removes excluded nodes and their edges from the denominators", () => {
    const report = computeCoverage({
      topology: syntheticTopology,
      trajectories: [{ caseId: "case-1", nodes: ["a", "b"] }],
      intentRoutes: { covered: [], all: ["recipe"] },
      exclusions: [{ node: "d", reason: "unreachable in v1" }],
    });

    // Nodes counted: a, b, c. Edges counted: a->b, b->c.
    expect(report.nodeCoverage).toBeCloseTo(2 / 3);
    expect(report.edgeCoverage).toBeCloseTo(0.5);
    expect(report.intentCoverage).toBe(0);
    expect(report.uncoveredNodes).toEqual(["c"]);
    expect(report.exclusions).toEqual([{ node: "d", reason: "unreachable in v1" }]);
  });

  it("does not count edges from out-of-order node appearances", () => {
    const report = computeCoverage({
      topology: syntheticTopology,
      trajectories: [{ caseId: "case-1", nodes: ["c", "b"] }],
      intentRoutes: { covered: [], all: ["recipe"] },
    });

    expect(report.coveredEdges).toEqual([]);
  });

  it("exposes the ten top-level intents", () => {
    expect(QUERY_TOP_LEVEL_INTENTS).toHaveLength(10);
    expect(QUERY_TOP_LEVEL_INTENTS).toContain("recipe");
    expect(QUERY_TOP_LEVEL_INTENTS).toContain("clarification");
  });
});

describe("topologyToMermaid", () => {
  it("renders a flowchart with class defs, edges, and uncovered styling", () => {
    const mermaid = topologyToMermaid(syntheticTopology, {
      nodeClasses: { a: "retrieval", b: "model", c: "persistence", d: "interrupt" },
      coveredNodes: ["a", "b", "c"],
    });

    expect(mermaid).toMatch(/^flowchart TD/);
    for (const className of ["deterministic", "model", "retrieval", "persistence", "interrupt", "uncovered"]) {
      expect(mermaid).toContain(`classDef ${className}`);
    }
    expect(mermaid).toContain("a --> b");
    expect(mermaid).toContain("b -.-> c");
    expect(mermaid).toContain("class a retrieval");
    expect(mermaid).toContain("class d uncovered");
  });

  it("renders the real query topology with its node classes", () => {
    const topology = extractTopology(createQueryGraph({ checkpointer: null }));
    const mermaid = topologyToMermaid(topology, { nodeClasses: QUERY_NODE_CLASSES });

    expect(mermaid).toContain('determine_intent["determine_intent"]');
    expect(mermaid).toContain("respond");
  });
});
