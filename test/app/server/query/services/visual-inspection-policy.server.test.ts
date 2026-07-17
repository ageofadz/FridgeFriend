import { describe, expect, it } from "vitest";

import { planFocusedVisualInspection } from "../../../../../app/server/query/services/visual-inspection-policy.server";

describe("planFocusedVisualInspection", () => {
  it("does not inspect crops for semantic inventory assessments", () => {
    expect(planFocusedVisualInspection({
      query: "How healthy would you say the items in my fridge are?",
      intent: "food_knowledge",
      itemIds: [],
    })).toEqual({ enabled: false });
  });

  it("inspects broad visible-state questions", () => {
    expect(planFocusedVisualInspection({
      query: "Are any expiration dates visible?",
      intent: "food_knowledge",
      itemIds: [],
    })).toEqual({ enabled: true });
  });

  it("inspects focused measurable inventory questions", () => {
    expect(planFocusedVisualInspection({
      query: "How much milk is left?",
      intent: "inventory",
      itemIds: ["item-1"],
    })).toEqual({ enabled: true, itemIds: ["item-1"] });
  });

  it("does not inspect every crop for broad inventory counts", () => {
    expect(planFocusedVisualInspection({
      query: "How many items are in my fridge?",
      intent: "inventory",
      itemIds: [],
    })).toEqual({ enabled: false });
  });
});
