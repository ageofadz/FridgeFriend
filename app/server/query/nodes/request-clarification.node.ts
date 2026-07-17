import type { FridgeQueryStateValue } from "../state";

export async function requestClarificationNode(state: FridgeQueryStateValue) {
  return {
    answer: state.recipeClarification ?? "Ask a fridge inventory, food, recipe, shopping, or space question.",
  };
}
