import { promptMessages } from "../../scan/services/prompt-messages.server";
import {
  WorkspaceActionPlanProviderSchema,
  WorkspaceActionPlanSchema,
  type QueryGraphDependencies,
} from "../schemas/query";
import { createQueryModel } from "../services/query-model.server";
import { loadInventoryContext } from "../services/inventory-context.server";
import type { FridgeQueryStateValue } from "../state";
import type { WorkspaceAction } from "../../../workspace/contracts";
import { ConversationContextSchema } from "../../../workspace/contracts";

function recipeEntries(state: FridgeQueryStateValue) {
  const retrieval = state.context.recipeRetrieval;
  if (!retrieval || typeof retrieval !== "object" || !("recipes" in retrieval)) return [];
  const recipes = (retrieval as { recipes?: unknown }).recipes;
  return Array.isArray(recipes)
    ? recipes.flatMap((recipe) => typeof recipe === "object" && recipe !== null && "id" in recipe && typeof recipe.id === "string"
      ? [{ id: recipe.id }]
      : [])
    : [];
}

function groundedActions(input: {
  actions: WorkspaceAction[];
  itemIds: Set<string>;
  zones: Map<string, string>;
  recipes: Set<string>;
  evidence: Map<string, { imageId: string; boundingBox: { x: number; y: number; width: number; height: number } }>;
}): WorkspaceAction[] {
  return input.actions.reduce<WorkspaceAction[]>((result, action) => {
    if (action.type === "focus_items" || action.type === "show_freshness") {
      const itemIds = action.itemIds.filter((itemId) => input.itemIds.has(itemId));
      if (itemIds.length > 0) result.push({ ...action, itemIds });
      return result;
    }

    if (action.type === "focus_zone") {
      if (input.zones.has(action.zoneId)) result.push(action);
      return result;
    }

    if (action.type === "show_evidence") {
      const evidence = input.evidence.get(action.itemId);
      if (evidence) result.push({ ...action, ...evidence });
      return result;
    }

    if (action.type === "show_recipe_coverage") {
      if (!input.recipes.has(action.recipeId)) return result;
      result.push({
        ...action,
        availableItemIds: action.availableItemIds.filter((itemId) => input.itemIds.has(itemId)),
        uncertainItemIds: action.uncertainItemIds.filter((itemId) => input.itemIds.has(itemId)),
      });
      return result;
    }

    if (action.type === "preview_reorganization") {
      const placements = action.placements.filter((placement) =>
        input.itemIds.has(placement.itemId) && input.zones.has(placement.zoneId),
      );
      if (placements.length > 0) result.push({ type: "preview_reorganization", placements });
      return result;
    }

    result.push(action);
    return result;
  }, []);
}

function expiryPriorityItemIds(state: FridgeQueryStateValue, itemIds: Set<string>) {
  const expiryPlan = state.context.expiryPlan;
  if (typeof expiryPlan !== "object" || expiryPlan === null || !("priorityItems" in expiryPlan) || !Array.isArray(expiryPlan.priorityItems)) {
    return [];
  }

  return expiryPlan.priorityItems.flatMap((item) =>
    typeof item === "object" && item !== null && "visibleItemId" in item && typeof item.visibleItemId === "string" && itemIds.has(item.visibleItemId)
      ? [item.visibleItemId]
      : [],
  );
}

export function createPlanWorkspaceActionsNode(deps: QueryGraphDependencies = {}) {
  return async function planWorkspaceActionsNode(state: FridgeQueryStateValue) {
    const loadedPrompt = deps.promptBundle?.workspaceActionPlan;
    if (!loadedPrompt) {
      return {
        context: { ...state.context, workspaceActions: [], workspaceActionError: "Workspace action prompt is unavailable." },
      };
    }

    const inventory = await loadInventoryContext(state, deps);
    const items = inventory?.items ?? [];
    const zones = inventory?.zones ?? [];
    const recipes = recipeEntries(state);
    const itemIds = new Set(items.map((item) => item.id));
    const zonesById = new Map(zones.map((zone) => [zone.id, zone.id]));
    const evidence = new Map(items.flatMap((item) => item.location.observations.slice(0, 1).map((observation) => [
      item.id,
      { imageId: observation.imageId, boundingBox: observation.boundingBox },
    ] as const)));
    const selection = ConversationContextSchema.catch({ selectedItemIds: [], selectedZoneIds: [], selectedRecipeId: null, seededItems: [] })
      .parse(state.context.conversationContext);
    const model = deps.workspaceActionModel ?? createQueryModel();
    const structuredModel = model.withStructuredOutput(WorkspaceActionPlanProviderSchema, {
      name: "FridgeWorkspaceActionPlan",
    });

    try {
      const messages = await promptMessages(loadedPrompt, {
        workspace_action_context_json: JSON.stringify({
          query: state.query,
          intent: state.intent,
          selection,
          items: items.map((item) => ({ id: item.id, name: item.displayName, zoneId: item.location.zoneId, evidence: item.location.observations[0] ?? null })),
          zones: zones.map((zone) => ({ id: zone.id, label: zone.label, type: zone.type })),
          recipes,
        }),
      });
      const result = await structuredModel.invoke(messages, {
        tags: ["query", "plan_workspace_actions"],
        metadata: {
          fridgeId: state.fridgeId,
          imageId: state.imageId,
          langsmithPromptName: loadedPrompt.name,
          langsmithPromptRef: loadedPrompt.ref,
        },
      });
      const parsed = WorkspaceActionPlanSchema.safeParse(result);

      if (!parsed.success) {
        return {
          context: {
            ...state.context,
            workspaceActions: [],
            workspaceActionError: `Workspace action plan returned invalid output: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
          },
        };
      }

      const actions = groundedActions({
        actions: parsed.data.actions,
        itemIds,
        zones: zonesById,
        recipes: new Set(recipes.map((recipe) => recipe.id)),
        evidence,
      });
      const priorityItemIds = expiryPriorityItemIds(state, itemIds);
      if (priorityItemIds.length > 0 && !actions.some((action) => action.type === "show_freshness")) {
        actions.push({ type: "show_freshness", itemIds: [...new Set(priorityItemIds)] });
      }

      return {
        context: {
          ...state.context,
          workspaceActions: actions,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        context: { ...state.context, workspaceActions: [], workspaceActionError: `Workspace action planning failed: ${message}` },
      };
    }
  };
}
