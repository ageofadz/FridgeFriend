import {
  ConversationContextSchema,
  type ConversationContext,
} from "../../../workspace/contracts";
import type { FridgeQueryStateValue } from "../state";

// Nodes read the workspace selection off the untyped `context` channel; a
// missing or malformed payload degrades to an empty selection instead of
// failing the node.
export function conversationContextFromState(
  state: Pick<FridgeQueryStateValue, "context">,
): ConversationContext {
  return ConversationContextSchema.catch({
    selectedItemIds: [],
    selectedZoneIds: [],
    selectedRecipeId: null,
    seededItems: [],
    seededBoundingBoxes: [],
  }).parse(state.context.conversationContext);
}
