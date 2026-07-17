import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { getWriter } from "@langchain/langgraph";
import { z } from "zod";

import { ConversationContextSchema } from "../../../workspace/contracts";
import type { QueryGraphDependencies } from "../schemas/query";
import { createQueryModel } from "../services/query-model.server";
import {
  applySeededInventoryAssertions,
  type SeededInventoryAssertion,
} from "../services/seeded-inventory-assertion.server";
import type { FridgeQueryStateValue } from "../state";

const SeededInventoryAssertionsSchema = z.object({
  assertions: z.array(z.object({
    cropId: z.string().min(1),
    label: z.string().trim().min(1),
  })).default([]),
});

function selectedItems(state: FridgeQueryStateValue) {
  return ConversationContextSchema.catch({
    selectedItemIds: [],
    selectedZoneIds: [],
    selectedRecipeId: null,
    seededItems: [],
  }).parse(state.context.conversationContext).seededItems;
}

export function createApplySeededInventoryAssertionsNode(
  deps: QueryGraphDependencies = {},
) {
  return async function applySeededInventoryAssertionsNode(
    state: FridgeQueryStateValue,
  ) {
    const seededItems = selectedItems(state);

    if (seededItems.length === 0) {
      return {};
    }

    const model = deps.seededInventoryAssertionModel ?? createQueryModel();
    const structuredModel = model.withStructuredOutput(
      SeededInventoryAssertionsSchema,
      { name: "SeededInventoryAssertions" },
    );

    try {
      const result = await structuredModel.invoke([
        new SystemMessage("Extract direct, unambiguous user identity assertions about the selected inventory crops. Return one assertion for every selected crop the user is identifying or correcting. Do not infer labels from questions, requests, uncertainty, or general discussion. Only use cropId values supplied in the selected crop context."),
        new HumanMessage(JSON.stringify({
          query: state.query,
          selectedCrops: seededItems.map((item) => ({
            cropId: item.cropId,
            currentItemId: item.itemId,
          })),
        })),
      ], {
        tags: ["query", "apply_seeded_inventory_assertions"],
        metadata: {
          fridgeId: state.fridgeId,
          imageId: state.imageId,
        },
      });
      const parsed = SeededInventoryAssertionsSchema.safeParse(result);

      if (!parsed.success) {
        return {
          context: {
            ...state.context,
            seededInventoryAssertionError: `Selected inventory assertion extraction returned invalid output: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
          },
        };
      }

      const allowedCropIds = new Set(seededItems.map((item) => item.cropId));
      const assertions: SeededInventoryAssertion[] = parsed.data.assertions.filter(
        (assertion) => allowedCropIds.has(assertion.cropId),
      );
      const apply = deps.applySeededInventoryAssertions ?? applySeededInventoryAssertions;
      const applied = await apply({ seededItems, assertions });
      const writer = getWriter();

      for (const assertion of applied) {
        writer?.({ type: "agent_event", event: {
          type: "inventory_assertion_applied",
          itemId: assertion.itemId,
          cropId: assertion.cropId,
          label: assertion.label,
        } });
      }

      return {
        context: {
          ...state.context,
          seededInventoryAssertions: applied,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        context: {
          ...state.context,
          seededInventoryAssertionError: `Selected inventory assertion could not be applied: ${message}`,
        },
      };
    }
  };
}
