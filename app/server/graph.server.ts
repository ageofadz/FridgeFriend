import { END, START, StateGraph, StateSchema } from "@langchain/langgraph";
import { z } from "zod";

const FridgeState = new StateSchema({
  requestId: z.string(),
  stages: z.array(z.string()).default(() => []),
  response: z.string().default(""),
});

function appendStage(stages: string[], stage: string) {
  return [...stages, stage];
}

export function createFoundationGraph() {
  return new StateGraph(FridgeState)
    .addNode("analyze_images", async (state: typeof FridgeState.State) => ({
      stages: appendStage(state.stages, "analyze_images"),
    }))
    .addNode("build_inventory", async (state: typeof FridgeState.State) => ({
      stages: appendStage(state.stages, "build_inventory"),
    }))
    .addNode("persist_inventory", async (state: typeof FridgeState.State) => ({
      stages: appendStage(state.stages, "persist_inventory"),
    }))
    .addNode("wait_for_user", async (state: typeof FridgeState.State) => ({
      stages: appendStage(state.stages, "wait_for_user"),
    }))
    .addNode("determine_intent", async (state: typeof FridgeState.State) => ({
      stages: appendStage(state.stages, "determine_intent"),
    }))
    .addNode("retrieve_knowledge", async (state: typeof FridgeState.State) => ({
      stages: appendStage(state.stages, "retrieve_knowledge"),
    }))
    .addNode("call_tools", async (state: typeof FridgeState.State) => ({
      stages: appendStage(state.stages, "call_tools"),
    }))
    .addNode("respond", async (state: typeof FridgeState.State) => ({
      stages: appendStage(state.stages, "respond"),
      response: "Milestone 1 graph scaffold invoked.",
    }))
    .addEdge(START, "analyze_images")
    .addEdge("analyze_images", "build_inventory")
    .addEdge("build_inventory", "persist_inventory")
    .addEdge("persist_inventory", "wait_for_user")
    .addEdge("wait_for_user", "determine_intent")
    .addEdge("determine_intent", "retrieve_knowledge")
    .addEdge("retrieve_knowledge", "call_tools")
    .addEdge("call_tools", "respond")
    .addEdge("respond", END)
    .compile();
}
