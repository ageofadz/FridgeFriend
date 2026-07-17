import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const graphSource = readFileSync(
  path.join(process.cwd(), "app/server/query/graph.server.ts"),
  "utf8",
);
const enrichmentSource = readFileSync(
  path.join(process.cwd(), "app/server/query/nodes/enrich-inventory.node.ts"),
  "utf8",
);
const persistMemorySource = readFileSync(
  path.join(process.cwd(), "app/server/query/nodes/persist-memory.node.ts"),
  "utf8",
);

describe("query graph policy", () => {
  it("keeps durable memory writes split into write, index, and reload nodes", () => {
    expect(graphSource).toContain('.addNode("apply_memory_writes"');
    expect(graphSource).toContain('.addNode("index_semantic_memory"');
    expect(graphSource).toContain('.addNode("reload_memory_context"');
    expect(graphSource).not.toContain('.addNode("persist_memory"');
    expect(graphSource).toContain(".addEdge(\"apply_memory_writes\", \"index_semantic_memory\")");
    expect(graphSource).toContain(".addEdge(\"index_semantic_memory\", \"reload_memory_context\")");
  });

  it("persists inventory enrichment only through the dedicated graph node", () => {
    const appendCallIndex = enrichmentSource.indexOf("appendFridgeInventoryEnrichments({");
    const persistNodeIndex = enrichmentSource.indexOf("createPersistInventoryEnrichmentNode");

    expect(persistNodeIndex).toBeGreaterThan(-1);
    expect(appendCallIndex).toBeGreaterThan(persistNodeIndex);
    expect(graphSource).toContain('.addNode("persist_inventory_enrichment"');
    expect(graphSource).toContain(".addEdge(\"run_focused_inventory_enrichment\", \"persist_inventory_enrichment\")");
    expect(graphSource).toContain(".addEdge(\"request_inventory_clarification\", \"persist_inventory_enrichment\")");
  });

  it("ranks recipe results after retrieval instead of inside the retrieval node", () => {
    expect(graphSource).toContain('.addNode("retrieve_recipes"');
    expect(graphSource).toContain('.addNode("rank_retrieved_recipes"');
    expect(graphSource).toContain(".addEdge(\"retrieve_recipes\", \"rank_retrieved_recipes\")");
    expect(graphSource).toContain(".addEdge(\"rank_retrieved_recipes\", \"grade_recipe_retrieval\")");
  });

  it("retries model-backed intent routing through the graph policy", () => {
    expect(graphSource).toContain('.addNode("determine_intent", createDetermineIntentNode(deps), {\n      retryPolicy: queryGraphModelRetryPolicy,\n    })');
  });

  it("uses graph operation keys for mutating query nodes", () => {
    expect(persistMemorySource).toContain("memoryOperationKey");
    expect(enrichmentSource).toContain("inventoryEnrichmentOperationKey");
    expect(enrichmentSource).toContain("completedOperationKeys");
  });
});
