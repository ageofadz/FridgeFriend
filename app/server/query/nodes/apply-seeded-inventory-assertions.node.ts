import { getWriter } from "@langchain/langgraph";
import { z } from "zod";

import type { QueryGraphDependencies } from "../schemas/query";
import { promptMessages } from "../../scan/services/prompt-messages.server";
import { conversationContextFromState } from "../services/conversation-context.server";
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
  return conversationContextFromState(state).seededItems;
}

function seededInventoryAssertionOperationKey(state: FridgeQueryStateValue) {
  return `seeded_inventory_assertions:${state.threadId}:${state.query}:${JSON.stringify(selectedItems(state))}`;
}

export function createApplySeededInventoryAssertionsNode(
  deps: QueryGraphDependencies = {},
) {
  return async function applySeededInventoryAssertionsNode(
    state: FridgeQueryStateValue,
  ) {
    const seededItems = selectedItems(state);
    const operationKey = seededInventoryAssertionOperationKey(state);

    if (seededItems.length === 0 || state.completedOperationKeys.includes(operationKey)) {
      return {};
    }

    const model = deps.seededInventoryAssertionModel ?? createQueryModel();
    const loadedPrompt = deps.promptBundle?.seededInventoryAssertions;
    if (!loadedPrompt) throw new Error("Seeded inventory assertions prompt is unavailable.");
    const structuredModel = model.withStructuredOutput(
      SeededInventoryAssertionsSchema,
      { name: "SeededInventoryAssertions" },
    );

    try {
      const result = await structuredModel.invoke(await promptMessages(loadedPrompt, {
        seeded_inventory_assertion_context_json: JSON.stringify({
          query: state.query,
          selectedCrops: seededItems.map((item) => ({
            cropId: item.cropId,
            currentItemId: item.itemId,
          })),
        }),
      }), {
        tags: ["query", "apply_seeded_inventory_assertions"],
        metadata: {
          fridgeId: state.fridgeId,
          imageId: state.imageId,
          langsmithPromptName: loadedPrompt.name,
          langsmithPromptRef: loadedPrompt.ref,
        },
      });
      const parsed = SeededInventoryAssertionsSchema.safeParse(result);

      if (!parsed.success) {
        const error = `Selected inventory assertion extraction returned invalid output: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`;
        getWriter()?.({ type: "agent_event", event: {
          type: "inventory_assertion_failed",
          error,
        } });
        return {
          context: {
            ...state.context,
            seededInventoryAssertionError: error,
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
        completedOperationKeys: [...state.completedOperationKeys, operationKey],
        context: {
          ...state.context,
          seededInventoryAssertions: applied,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const assertionError = `Selected inventory assertion could not be applied: ${message}`;
      getWriter()?.({ type: "agent_event", event: {
        type: "inventory_assertion_failed",
        error: assertionError,
      } });
      return {
        context: {
          ...state.context,
          seededInventoryAssertionError: assertionError,
        },
      };
    }
  };
}
