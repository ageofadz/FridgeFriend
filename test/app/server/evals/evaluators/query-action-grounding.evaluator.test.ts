import { describe, expect, it } from "vitest";

import {
  ACTION_COUNT_CORRECT_KEY,
  ACTION_SCHEMA_VALID_KEY,
  ACTION_TARGETS_GROUNDED_KEY,
  ACTION_TYPES_CORRECT_KEY,
  RECIPE_PROVENANCE_VALID_KEY,
  evaluateQueryActionGrounding,
} from "../../../../../app/server/evals/evaluators/query-action-grounding.evaluator";

import { evalResult, feedbackByKey, queryCase, queryOutput } from "./helpers";

const grounding = {
  itemIds: ["item-1", "item-2"],
  zoneIds: ["zone-1"],
  recipeIds: ["recipe-1"],
  imageIds: ["img-1"],
};

function focusItems(itemIds: string[]) {
  return { type: "focus_items", itemIds, emphasis: "highlight", reason: null };
}

describe("evaluateQueryActionGrounding", () => {
  it("passes every key for grounded, schema-valid actions", () => {
    const feedback = feedbackByKey(evaluateQueryActionGrounding({
      caseData: queryCase({
        expected: {
          requiredActionTypes: ["focus_items"],
          forbiddenActionTypes: ["preview_reorganization"],
          minimumRecipeProvenance: 1,
          allowedRecipeIds: ["recipe-1"],
        },
      }),
      result: evalResult({
        output: queryOutput({
          workspaceActions: [
            focusItems(["item-1"]),
            { type: "focus_zone", zoneId: "zone-1", reason: null },
            {
              type: "show_evidence",
              itemId: "item-2",
              imageId: "img-1",
              boundingBox: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
            },
          ],
          recipeIds: ["recipe-1"],
          grounding,
        }),
      }),
    }));

    for (const key of [
      ACTION_SCHEMA_VALID_KEY,
      ACTION_TYPES_CORRECT_KEY,
      ACTION_TARGETS_GROUNDED_KEY,
      ACTION_COUNT_CORRECT_KEY,
      RECIPE_PROVENANCE_VALID_KEY,
    ]) {
      expect(feedback.get(key)?.score, key).toBe(1);
    }
  });

  it("fails action_schema_valid for malformed actions", () => {
    const feedback = feedbackByKey(evaluateQueryActionGrounding({
      caseData: queryCase(),
      result: evalResult({
        output: queryOutput({
          workspaceActions: [{ type: "focus_items", itemIds: [] }],
          grounding,
        }),
      }),
    }));

    expect(feedback.get(ACTION_SCHEMA_VALID_KEY)?.score).toBe(0);
  });

  it("fails action_types_correct when a required type is missing or a forbidden one present", () => {
    const feedback = feedbackByKey(evaluateQueryActionGrounding({
      caseData: queryCase({
        expected: {
          requiredActionTypes: ["show_freshness"],
          forbiddenActionTypes: ["focus_items"],
        },
      }),
      result: evalResult({
        output: queryOutput({ workspaceActions: [focusItems(["item-1"])], grounding }),
      }),
    }));

    expect(feedback.get(ACTION_TYPES_CORRECT_KEY)?.score).toBe(0);
    expect(feedback.get(ACTION_TYPES_CORRECT_KEY)?.comment).toContain("show_freshness");
  });

  it("rejects action targets that are not in the grounding sets", () => {
    const feedback = feedbackByKey(evaluateQueryActionGrounding({
      caseData: queryCase(),
      result: evalResult({
        output: queryOutput({
          workspaceActions: [
            focusItems(["item-unknown"]),
            { type: "focus_zone", zoneId: "zone-unknown", reason: null },
            {
              type: "show_recipe_coverage",
              recipeId: "recipe-unknown",
              availableItemIds: [],
              uncertainItemIds: [],
              missingIngredients: [],
            },
          ],
          grounding,
        }),
      }),
    }));

    expect(feedback.get(ACTION_TARGETS_GROUNDED_KEY)?.score).toBe(0);
    expect(feedback.get(ACTION_TARGETS_GROUNDED_KEY)?.comment).toContain("item:item-unknown");
    expect(feedback.get(ACTION_TARGETS_GROUNDED_KEY)?.comment).toContain("zone:zone-unknown");
    expect(feedback.get(ACTION_TARGETS_GROUNDED_KEY)?.comment).toContain("recipe:recipe-unknown");
  });

  it("rejects preview_reorganization placements with unknown ids", () => {
    const feedback = feedbackByKey(evaluateQueryActionGrounding({
      caseData: queryCase(),
      result: evalResult({
        output: queryOutput({
          workspaceActions: [{
            type: "preview_reorganization",
            placements: [{ itemId: "item-1", zoneId: "zone-unknown" }],
          }],
          grounding,
        }),
      }),
    }));

    expect(feedback.get(ACTION_TARGETS_GROUNDED_KEY)?.score).toBe(0);
  });

  it("fails action_count_correct when required types are asserted but no actions emitted", () => {
    const feedback = feedbackByKey(evaluateQueryActionGrounding({
      caseData: queryCase({ expected: { requiredActionTypes: ["focus_items"] } }),
      result: evalResult({ output: queryOutput({ workspaceActions: [] }) }),
    }));

    expect(feedback.get(ACTION_COUNT_CORRECT_KEY)?.score).toBe(0);
    expect(feedback.get(ACTION_TYPES_CORRECT_KEY)?.score).toBe(0);
  });

  it("fails recipe_provenance_valid when recipe ids fall outside grounding or allowed list", () => {
    const outsideGrounding = feedbackByKey(evaluateQueryActionGrounding({
      caseData: queryCase({ expected: { minimumRecipeProvenance: 1 } }),
      result: evalResult({
        output: queryOutput({ recipeIds: ["recipe-unknown"], grounding }),
      }),
    }));
    expect(outsideGrounding.get(RECIPE_PROVENANCE_VALID_KEY)?.score).toBe(0);

    const belowMinimum = feedbackByKey(evaluateQueryActionGrounding({
      caseData: queryCase({ expected: { minimumRecipeProvenance: 2 } }),
      result: evalResult({
        output: queryOutput({ recipeIds: ["recipe-1"], grounding }),
      }),
    }));
    expect(belowMinimum.get(RECIPE_PROVENANCE_VALID_KEY)?.score).toBe(0);

    const outsideAllowed = feedbackByKey(evaluateQueryActionGrounding({
      caseData: queryCase({ expected: { allowedRecipeIds: ["recipe-other"] } }),
      result: evalResult({
        output: queryOutput({ recipeIds: ["recipe-1"], grounding }),
      }),
    }));
    expect(outsideAllowed.get(RECIPE_PROVENANCE_VALID_KEY)?.score).toBe(0);
  });

  it("passes not-asserted keys when the case declares no expectations", () => {
    const feedback = feedbackByKey(evaluateQueryActionGrounding({
      caseData: queryCase(),
      result: evalResult(),
    }));

    expect(feedback.get(ACTION_TYPES_CORRECT_KEY)?.score).toBe(1);
    expect(feedback.get(ACTION_COUNT_CORRECT_KEY)?.score).toBe(1);
    expect(feedback.get(RECIPE_PROVENANCE_VALID_KEY)?.score).toBe(1);
    expect(feedback.get(RECIPE_PROVENANCE_VALID_KEY)?.comment).toContain("Not asserted");
  });
});
