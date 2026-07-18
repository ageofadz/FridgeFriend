import type { QueryFixtures } from "../schemas/query-eval-case";
import type { FixtureSideEffectCounters } from "../schemas/trajectory";

export type FixtureSideEffectWrite = { kind: string; target: string };

/**
 * Shared mutable record of every side effect the fixture adapters observed.
 * Safety evaluators assert on the counters instead of on private state.
 */
export type FixtureSideEffectLog = {
  counters: FixtureSideEffectCounters;
  writes: FixtureSideEffectWrite[];
};

export function createFixtureSideEffectLog(): FixtureSideEffectLog {
  return {
    counters: {
      inventoryWrites: 0,
      memoryWrites: 0,
      semanticMemoryIndexWrites: 0,
      enrichmentWrites: 0,
      workspaceActionsPlanned: 0,
    },
    writes: [],
  };
}

export function cloneCounters(log: FixtureSideEffectLog): FixtureSideEffectCounters {
  return { ...log.counters };
}

export type WorkspaceGrounding = {
  itemIds: string[];
  zoneIds: string[];
  recipeIds: string[];
  imageIds: string[];
};

function unique(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

/**
 * The full set of fixture ids a grounded response or workspace action may
 * reference. Consumed by the action-grounding evaluator via the eval output.
 */
export function workspaceGrounding(fixtures: QueryFixtures): WorkspaceGrounding {
  return {
    itemIds: unique([
      ...fixtures.workspace.itemIds,
      ...(fixtures.inventory?.items ?? []).map((item) => item.id),
    ]),
    zoneIds: unique(fixtures.workspace.zoneIds),
    recipeIds: unique([
      ...fixtures.workspace.recipeIds,
      ...fixtures.recipes.map((recipe) => recipe.id),
    ]),
    imageIds: unique([
      ...fixtures.workspace.imageIds,
      ...fixtures.images.map((image) => image.imageId),
    ]),
  };
}
