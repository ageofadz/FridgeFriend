import type { ReplayStep } from "../schemas/query-eval-case";

/**
 * Strict replay failure. The message always contains the word "replay" so
 * classifyError maps it to the `replay_mismatch` kind.
 */
export class ReplayMismatchError extends Error {
  details: { callId?: string; message: string };

  constructor(message: string, callId?: string) {
    super(message);
    this.name = "ReplayMismatchError";
    this.details = { ...(callId ? { callId } : {}), message };
  }
}

export type ReplayCallSite = {
  nodes: string[];
  schemaNames: string[];
};

// Some replay steps are authored with the spec's conceptual schema names while
// the production call sites pass their own `withStructuredOutput` config names.
// Both spellings are accepted; comparison happens on the canonical form.
const SCHEMA_NAME_ALIASES: Record<string, string> = {
  FridgeFriendMemoryExtraction: "MemoryCandidates",
  FridgeRecipeSearchInterpretation: "RecipeSearchRequest",
  FridgeRecipeRetrievalGrade: "RecipeRetrievalGrade",
  FridgeRecipeTournamentEvaluation: "RecipeTournamentEvaluation",
  FridgeGroceryRecipeSelection: "GroceryRecipeSelection",
  FridgeGroceryAisleAssignment: "GroceryAisleAssignment",
  FridgePantryCompletionAisleAssignment: "GroceryAisleAssignment",
  FridgeWorkspaceActionPlan: "WorkspaceActionPlan",
};

export function canonicalSchemaName(name: string): string {
  return SCHEMA_NAME_ALIASES[name] ?? name;
}

/**
 * Registry of every model call site in the production query graph. Site keys
 * are the replay sequence names; nodes and schema names identify which
 * production call the site replays. Both the spec's conceptual schema names
 * and the production config names are listed.
 */
export const QUERY_REPLAY_CALL_SITES = {
  intent: {
    nodes: ["determine_intent"],
    schemaNames: ["IntentResponse"],
  },
  seeded_inventory_assertion: {
    nodes: ["apply_seeded_inventory_assertions"],
    schemaNames: ["SeededInventoryAssertions"],
  },
  memory_extraction: {
    nodes: ["extract_memory_candidates"],
    schemaNames: ["MemoryCandidates", "FridgeFriendMemoryExtraction"],
  },
  recipe_search: {
    nodes: ["build_recipe_search"],
    schemaNames: ["RecipeSearchRequest", "FridgeRecipeSearchInterpretation"],
  },
  recipe_retrieval_grade: {
    nodes: ["grade_recipe_retrieval"],
    schemaNames: ["RecipeRetrievalGrade", "FridgeRecipeRetrievalGrade"],
  },
  recipe_tournament: {
    nodes: ["evaluate_recipe"],
    schemaNames: ["RecipeTournamentEvaluation", "FridgeRecipeTournamentEvaluation"],
  },
  grocery_recipe_selection: {
    nodes: ["plan_groceries"],
    schemaNames: ["GroceryRecipeSelection", "FridgeGroceryRecipeSelection"],
  },
  grocery_aisle_assignment: {
    nodes: ["plan_groceries", "plan_pantry_completion"],
    schemaNames: [
      "GroceryAisleAssignment",
      "FridgeGroceryAisleAssignment",
      "FridgePantryCompletionAisleAssignment",
    ],
  },
  organization_plan: {
    nodes: ["plan_organization"],
    schemaNames: ["KitchenOrganizationPlan"],
  },
  enrichment: {
    nodes: ["run_focused_inventory_enrichment", "request_inventory_clarification"],
    schemaNames: ["FocusedInventoryEnrichment", "InventoryClarificationValue"],
  },
  inventory_split: {
    nodes: ["propose_scoped_inventory_split"],
    schemaNames: ["ScopedInventorySplitProposal"],
  },
  workspace_action: {
    nodes: ["plan_workspace_actions"],
    schemaNames: ["WorkspaceActionPlan", "FridgeWorkspaceActionPlan"],
  },
  response: {
    nodes: ["respond"],
    schemaNames: ["QueryResponse"],
  },
} as const satisfies Record<string, ReplayCallSite>;

export const SCAN_REPLAY_CALL_SITES = {
  image_validation: {
    nodes: ["validate_images"],
    schemaNames: ["ImageValidation"],
  },
  inventory_detection: {
    nodes: ["detect_inventory"],
    schemaNames: ["InventoryDetection"],
  },
  zone_map: {
    nodes: ["map_zones"],
    schemaNames: ["ZoneMap"],
  },
} as const satisfies Record<string, ReplayCallSite>;

export type ReplayCallSiteKey =
  | keyof typeof QUERY_REPLAY_CALL_SITES
  | keyof typeof SCAN_REPLAY_CALL_SITES;

const ALL_CALL_SITES: Record<string, ReplayCallSite> = {
  ...QUERY_REPLAY_CALL_SITES,
  ...SCAN_REPLAY_CALL_SITES,
};

function siteFor(step: ReplayStep): string | null {
  for (const [siteKey, site] of Object.entries(ALL_CALL_SITES)) {
    if (
      site.nodes.includes(step.expectedNode) &&
      site.schemaNames.some(
        (name) => canonicalSchemaName(name) === canonicalSchemaName(step.expectedSchemaName),
      )
    ) {
      return siteKey;
    }
  }
  return null;
}

/**
 * Groups replay steps by call site, preserving the case's array order within
 * each site. The query graph runs its memory and intent lanes in parallel, so
 * strict replay ordering is enforced per call site rather than globally
 * (documented deviation from the spec's single global sequence).
 */
export function groupReplaySteps(steps: ReplayStep[]): Map<string, ReplayStep[]> {
  const grouped = new Map<string, ReplayStep[]>();

  for (const step of steps) {
    const siteKey = siteFor(step);

    if (!siteKey) {
      throw new ReplayMismatchError(
        `Replay step ${step.callId} does not match any known call site ` +
          `(node "${step.expectedNode}", schema "${step.expectedSchemaName}")`,
        step.callId,
      );
    }

    const existing = grouped.get(siteKey);
    if (existing) {
      existing.push(step);
    } else {
      grouped.set(siteKey, [step]);
    }
  }

  return grouped;
}
