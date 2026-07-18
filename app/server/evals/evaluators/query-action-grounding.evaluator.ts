import { WorkspaceActionSchema } from "../../../workspace/contracts";
import type { EvalFeedback, EvalResult } from "../schemas/eval-result";
import type { QueryEvalCase } from "../schemas/query-eval-case";

import { feedback, passFail, readQueryOutput, recordsOf, stringsOf } from "./shared";

export const ACTION_SCHEMA_VALID_KEY = "action_schema_valid";
export const ACTION_TYPES_CORRECT_KEY = "action_types_correct";
export const ACTION_TARGETS_GROUNDED_KEY = "action_targets_grounded";
export const ACTION_COUNT_CORRECT_KEY = "action_count_correct";
export const RECIPE_PROVENANCE_VALID_KEY = "recipe_provenance_valid";

type ActionRefs = {
  itemIds: string[];
  zoneIds: string[];
  recipeIds: string[];
  imageIds: string[];
};

// Extracts every fixture-groundable id referenced by a workspace action,
// keyed by action type per the WorkspaceActionSchema contract.
function actionRefs(action: Record<string, unknown>): ActionRefs {
  const refs: ActionRefs = { itemIds: [], zoneIds: [], recipeIds: [], imageIds: [] };

  switch (action.type) {
    case "focus_items":
    case "show_freshness":
      refs.itemIds.push(...stringsOf(action.itemIds));
      break;
    case "focus_zone":
      if (typeof action.zoneId === "string") refs.zoneIds.push(action.zoneId);
      break;
    case "show_evidence":
      if (typeof action.itemId === "string") refs.itemIds.push(action.itemId);
      if (typeof action.imageId === "string") refs.imageIds.push(action.imageId);
      break;
    case "show_recipe_coverage":
      if (typeof action.recipeId === "string") refs.recipeIds.push(action.recipeId);
      refs.itemIds.push(...stringsOf(action.availableItemIds));
      refs.itemIds.push(...stringsOf(action.uncertainItemIds));
      break;
    case "preview_reorganization":
      for (const placement of recordsOf(Array.isArray(action.placements) ? action.placements : [])) {
        if (typeof placement.itemId === "string") refs.itemIds.push(placement.itemId);
        if (typeof placement.zoneId === "string") refs.zoneIds.push(placement.zoneId);
      }
      break;
    default:
      break;
  }

  return refs;
}

export function evaluateQueryActionGrounding(input: {
  caseData: QueryEvalCase;
  result: EvalResult;
}): EvalFeedback[] {
  const expected = input.caseData.expected;
  const output = readQueryOutput(input.result);
  const actions = recordsOf(output.workspaceActions);

  const schemaFailures = actions
    .map((action, index) => ({ index, parse: WorkspaceActionSchema.safeParse(action) }))
    .filter((entry) => !entry.parse.success);
  const schemaFeedback = passFail(
    ACTION_SCHEMA_VALID_KEY,
    schemaFailures.length === 0,
    schemaFailures.length === 0
      ? `All ${actions.length} workspace actions satisfy WorkspaceActionSchema.`
      : `Actions at indexes ${schemaFailures.map((entry) => entry.index).join(", ")} fail WorkspaceActionSchema.`,
  );

  const presentTypes = actions
    .map((action) => action.type)
    .filter((value): value is string => typeof value === "string");
  const missingTypes = expected.requiredActionTypes.filter((type) => !presentTypes.includes(type));
  const forbiddenPresent = expected.forbiddenActionTypes.filter((type) => presentTypes.includes(type));
  const typesAsserted = expected.requiredActionTypes.length > 0 || expected.forbiddenActionTypes.length > 0;
  const typesFeedback = !typesAsserted
    ? feedback(ACTION_TYPES_CORRECT_KEY, 1, "Not asserted: case declares no action-type expectations.")
    : passFail(
      ACTION_TYPES_CORRECT_KEY,
      missingTypes.length === 0 && forbiddenPresent.length === 0,
      `Present types: ${presentTypes.join(", ") || "none"}; missing required: ${missingTypes.join(", ") || "none"}; forbidden present: ${forbiddenPresent.join(", ") || "none"}.`,
    );

  const grounding = output.grounding;
  const knownItemIds = new Set(grounding.itemIds);
  const knownZoneIds = new Set(grounding.zoneIds);
  const knownRecipeIds = new Set(grounding.recipeIds);
  const knownImageIds = new Set(grounding.imageIds);
  const allowedItemIds = expected.allowedItemIds ? new Set(expected.allowedItemIds) : null;
  const allowedZoneIds = expected.allowedZoneIds ? new Set(expected.allowedZoneIds) : null;
  const ungrounded: string[] = [];

  for (const action of actions) {
    const refs = actionRefs(action);
    for (const itemId of refs.itemIds) {
      if (!knownItemIds.has(itemId) || (allowedItemIds && !allowedItemIds.has(itemId))) {
        ungrounded.push(`item:${itemId}`);
      }
    }
    for (const zoneId of refs.zoneIds) {
      if (!knownZoneIds.has(zoneId) || (allowedZoneIds && !allowedZoneIds.has(zoneId))) {
        ungrounded.push(`zone:${zoneId}`);
      }
    }
    for (const recipeId of refs.recipeIds) {
      if (!knownRecipeIds.has(recipeId)) ungrounded.push(`recipe:${recipeId}`);
    }
    for (const imageId of refs.imageIds) {
      if (!knownImageIds.has(imageId)) ungrounded.push(`image:${imageId}`);
    }
  }

  const targetsFeedback = passFail(
    ACTION_TARGETS_GROUNDED_KEY,
    ungrounded.length === 0,
    ungrounded.length === 0
      ? `All targets referenced by ${actions.length} actions exist in the grounding sets.`
      : `Ungrounded action targets: ${[...new Set(ungrounded)].join(", ")}.`,
  );

  // Kept intentionally simple: when required action types are asserted the
  // graph must emit at least one action; there is no exact-count contract for
  // workspace actions (expectedMutationCount governs mutations, not actions).
  const countFeedback = expected.requiredActionTypes.length === 0
    ? feedback(ACTION_COUNT_CORRECT_KEY, 1, "Not asserted: case declares no required action types.")
    : passFail(
      ACTION_COUNT_CORRECT_KEY,
      actions.length >= 1,
      `Required action types asserted; received ${actions.length} workspace actions.`,
    );

  const provenanceAsserted = expected.minimumRecipeProvenance !== undefined ||
    expected.allowedRecipeIds !== undefined;
  let provenanceFeedback: EvalFeedback;
  if (!provenanceAsserted) {
    provenanceFeedback = feedback(
      RECIPE_PROVENANCE_VALID_KEY,
      1,
      "Not asserted: case declares no recipe-provenance expectations.",
    );
  } else {
    const minimum = expected.minimumRecipeProvenance ?? 0;
    const allowedRecipeIds = expected.allowedRecipeIds ? new Set(expected.allowedRecipeIds) : null;
    const outsideGrounding = output.recipeIds.filter((recipeId) => !knownRecipeIds.has(recipeId));
    const outsideAllowed = allowedRecipeIds
      ? output.recipeIds.filter((recipeId) => !allowedRecipeIds.has(recipeId))
      : [];
    const passed = output.recipeIds.length >= minimum &&
      outsideGrounding.length === 0 &&
      outsideAllowed.length === 0;
    provenanceFeedback = passFail(
      RECIPE_PROVENANCE_VALID_KEY,
      passed,
      `Recipe ids: ${output.recipeIds.join(", ") || "none"} (minimum ${minimum}); outside grounding: ${outsideGrounding.join(", ") || "none"}; outside allowed list: ${outsideAllowed.join(", ") || "none"}.`,
    );
  }

  return [schemaFeedback, typesFeedback, targetsFeedback, countFeedback, provenanceFeedback];
}
