import type { QueryGraphDependencies } from "../../query/schemas/query";
import type { InventoryFixture } from "../schemas/query-eval-case";
import type { FixtureSideEffectLog } from "./fixture-workspace-adapter";

/**
 * Pure in-memory replacements for the SQLite-backed inventory dependencies.
 * No sqlite/chroma module is imported here — everything reads from the case
 * fixture and records would-be writes on the shared side-effect log.
 *
 * Note: `persist_inventory_enrichment` is covered by the optional
 * `persistInventoryEnrichments` graph dependency (injected by the eval
 * graphs), not by this adapter, because the node persists enrichments rather
 * than reading inventory. Without that injection the node no-ops whenever
 * there are no pending enrichments or no imageId.
 */
export function createFixtureInventoryAdapter(input: {
  inventory: InventoryFixture | null;
  log: FixtureSideEffectLog;
}): Pick<
  QueryGraphDependencies,
  | "loadInventoryForImage"
  | "householdInventoryTool"
  | "applySeededInventoryAssertions"
  | "persistInventoryEnrichments"
> {
  const { inventory, log } = input;

  return {
    // The fixture inventory is attached to whichever imageId the case uses.
    loadInventoryForImage: () => (inventory as never) ?? null,
    householdInventoryTool: {
      invoke: async () => ({
        // Production only issues list operations through this dependency, so
        // a list read never counts as a write.
        operation: "list" as const,
        status: "ok" as const,
        message: `Listed ${inventory?.items.length ?? 0} fixture inventory items`,
        item: null,
        items: (inventory?.items ?? []).map((item) => ({
          id: item.id,
          name: item.name,
        })),
      }),
    },
    // Seeded assertions would mutate the scanned inventory; the fixture
    // adapter applies none, so nothing is counted and nothing is written.
    applySeededInventoryAssertions: () => [],
    persistInventoryEnrichments: ({ imageId, enrichments }) => {
      log.counters.enrichmentWrites += enrichments.length;
      for (const enrichment of enrichments) {
        log.writes.push({
          kind: "inventory_enrichment",
          target: `${imageId}:${enrichment.itemId}`,
        });
      }
    },
  };
}
