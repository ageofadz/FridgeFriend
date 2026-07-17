import { getWriter, type LangGraphRunnableConfig } from "@langchain/langgraph";

import {
  createOrLoadOrganizationPlan,
  getOrganizationPlanByRequestId,
} from "../../organization/repository.server";
import { getFridgeInventoryForImage } from "../../inventories.server";
import {
  OrganizationPlanDraftSchema,
  OrganizationPlanProviderSchema,
  type OrganizationPlanDraft,
} from "../../organization/schemas";
import type { QueryGraphDependencies } from "../schemas/query";
import { createQueryModel } from "../services/query-model.server";
import { promptMessages } from "../../scan/services/prompt-messages.server";
import type { FridgeQueryStateValue } from "../state";

function planningError(state: FridgeQueryStateValue, error: string) {
  return { context: { ...state.context, organizationPlan: null, organizationPlanError: error } };
}

function groundDraft(input: {
  draft: OrganizationPlanDraft;
  inventory: NonNullable<ReturnType<typeof getFridgeInventoryForImage>>;
}) {
  const items = new Map(input.inventory.items.map((item) => [item.id, item]));
  const zoneIds = new Set(input.inventory.zones.map((zone) => zone.id));
  const movedItemIds = new Set<string>();
  for (const move of input.draft.moves) {
    const item = items.get(move.itemId);
    if (!item) return `Kitchen organization plan referenced unknown item ${move.itemId}`;
    if (!zoneIds.has(move.fromZoneId) || !zoneIds.has(move.toZoneId)) return `Kitchen organization plan referenced a zone that is not in the scanned inventory`;
    if (move.fromZoneId === move.toZoneId) return `Kitchen organization plan kept ${item.label} in the same zone`;
    if (item.loc.zoneId !== move.fromZoneId) return `Kitchen organization plan expected ${item.label} in ${move.fromZoneId}, but its recorded zone is ${item.loc.zoneId ?? "unassigned"}`;
    if (movedItemIds.has(item.id)) return `Kitchen organization plan moved ${item.label} more than once`;
    movedItemIds.add(item.id);
  }
  return null;
}

export function createPlanOrganizationNode(deps: QueryGraphDependencies = {}) {
  return async function planOrganizationNode(
    state: FridgeQueryStateValue,
    config?: LangGraphRunnableConfig,
  ) {
    if (!state.requestId) return planningError(state, "Kitchen organization planning requires a request ID.");
    if (!state.imageId) return planningError(state, "Kitchen organization planning requires a scanned fridge image.");
    const writer = config ? getWriter(config) : undefined;
    const existing = getOrganizationPlanByRequestId(state.requestId);
    if (existing) {
      writer?.({ type: "organization_plan", plan: existing });
      return {
        context: {
          ...state.context,
          organizationPlan: existing,
          organizationPlanError: null,
          workspaceActions: existing.status === "pending" ? [{
            type: "preview_reorganization",
            placements: existing.moves.map((move) => ({ itemId: move.itemId, zoneId: move.toZoneId })),
          }] : [],
        },
      };
    }
    const inventory = deps.loadInventoryForImage
      ? await deps.loadInventoryForImage(state.imageId)
      : getFridgeInventoryForImage(state.imageId);
    if (!inventory) return planningError(state, "Kitchen organization planning requires a saved scanned inventory.");
    const model = deps.organizationPlannerModel ?? createQueryModel();
    const loadedPrompt = deps.promptBundle?.organizationPlan;
    if (!loadedPrompt) throw new Error("Organization plan prompt is unavailable.");
    const structuredModel = model.withStructuredOutput(OrganizationPlanProviderSchema, { name: "KitchenOrganizationPlan" });
    try {
      const result = await structuredModel.invoke(await promptMessages(loadedPrompt, {
        organization_plan_context_json: JSON.stringify({
          query: state.query,
          items: inventory.items.map((item) => ({
            id: item.id,
            label: item.label,
            category: item.cat,
            expirationDate: item.attrs.expirationDate,
            currentZoneId: item.loc.zoneId,
            currentZoneType: item.loc.zoneType,
          })),
          zones: inventory.zones.map((zone) => ({
            id: zone.id,
            label: zone.label,
            type: zone.type,
            observedOccupiedRatio: zone.estimatedOccupiedRatio,
          })),
        }),
      }), {
        tags: ["query", "plan_organization"],
        metadata: { fridgeId: state.fridgeId, imageId: state.imageId, requestId: state.requestId, langsmithPromptName: loadedPrompt.name, langsmithPromptRef: loadedPrompt.ref },
      });
      const parsed = OrganizationPlanDraftSchema.safeParse(result);
      if (!parsed.success) return planningError(state, `Kitchen organization plan returned invalid output: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
      const groundingError = groundDraft({ draft: parsed.data, inventory });
      if (groundingError) return planningError(state, groundingError);
      const plan = createOrLoadOrganizationPlan({
        requestId: state.requestId,
        userId: state.userId,
        fridgeId: state.fridgeId,
        imageId: state.imageId,
        inventory,
        draft: parsed.data,
      });
      writer?.({ type: "organization_plan", plan });
      return {
        context: {
          ...state.context,
          organizationPlan: plan,
          organizationPlanError: null,
          workspaceActions: [{
            type: "preview_reorganization",
            placements: plan.moves.map((move) => ({ itemId: move.itemId, zoneId: move.toZoneId })),
          }],
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return planningError(state, `Kitchen organization planning failed: ${message}`);
    }
  };
}
