import { describe, expect, it } from "vitest";

import { createPlanWorkspaceActionsNode } from "./plan-workspace-actions.node";

const prompt = {
  name: "workspace-action-plan" as const,
  ref: "fridgefriend-workspace-action-plan:latest",
  prompt: { invoke: async () => ({ toChatMessages: () => [] }) },
};

function state() {
  return {
    userId: "user-1",
    fridgeId: "fridge-1",
    imageId: "image-1",
    query: "How much milk is left?",
    threadId: "thread-1",
    intent: "inventory",
    context: {
      conversationContext: { selectedItemIds: ["item-1"], selectedZoneIds: [], selectedRecipeId: null },
    },
  } as never;
}

describe("workspace action planner", () => {
  it("keeps only actions grounded in current inventory evidence", async () => {
    const node = createPlanWorkspaceActionsNode({
      promptBundle: {
        queryMemoryExtraction: prompt as never,
        queryRecipeSearch: prompt as never,
        queryResponse: prompt as never,
        workspaceActionPlan: prompt as never,
      },
      workspaceActionModel: {
        withStructuredOutput: () => ({
          invoke: async () => ({
            actions: [
              { type: "focus_items", itemIds: ["item-1", "invented-item"], emphasis: "isolate", reason: "Quantity question" },
              { type: "show_evidence", itemId: "item-1", imageId: "wrong-image", boundingBox: { x: 0, y: 0, width: 1, height: 1 } },
              { type: "focus_zone", zoneId: "invented-zone", reason: null },
            ],
          }),
        }),
      } as never,
      loadInventoryForImage: () => ({
        id: "inventory-1",
        fridgeId: "fridge-1",
        scanId: "scan-1",
        source: "mocked-vision",
        model: "test",
        createdAt: "2026-07-17T00:00:00.000Z",
        items: [{
          id: "item-1", name: "milk", label: "Milk", cat: "dairy", subcat: null,
          qty: { amount: 1, unit: "package", precision: "estimated", fillLevel: null }, pack: "carton",
          loc: { status: "matched", zoneId: "zone-1", zoneType: "shelf", observations: [{ imageId: "image-1", depthBackRatio: 1, boundingBox: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 } }], confidence: 0.9 },
          conf: 0.9, src: ["detection-1"], attrs: { brand: null, variant: null, opened: null, expirationDate: null }, review: "inferred",
        }],
        zones: [{ id: "zone-1", type: "shelf", label: "Middle shelf", order: 0, boundingBox: { x: 0, y: 0, width: 1, height: 0.2 }, imageIds: ["image-1"], sourceZoneDetectionIds: ["zone-detection-1"], confidence: 0.9, estimatedCapacityRatio: null, estimatedOccupiedRatio: null }],
      }),
    });

    const result = await node(state());

    expect(result.context.workspaceActions).toEqual([
      { type: "focus_items", itemIds: ["item-1"], emphasis: "isolate", reason: "Quantity question" },
      { type: "show_evidence", itemId: "item-1", imageId: "image-1", boundingBox: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 } },
    ]);
  });
});
