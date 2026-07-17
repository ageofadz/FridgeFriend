import type { FridgeQueryStateValue } from "../state";

export async function retrieveKnowledgeNode(state: FridgeQueryStateValue) {
  return {
    context: {
      ...state.context,
      queryMode: "food_knowledge",
    },
  };
}
