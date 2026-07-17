import { END, START, StateGraph } from "@langchain/langgraph";

import { checkpointer } from "../checkpointer.server";
import type { StorageImageLocation } from "../images.server";
import { assertLangSmithTracingEnabled } from "../langsmith.server";
import { loadPromptBundle } from "../prompts/registry.server";
import { createAdjudicateLocationsNode } from "./nodes/adjudicate-locations.node";
import { createDetectInventoryNode } from "./nodes/detect-inventory.node";
import { createMapZonesNode } from "./nodes/map-zones.node";
import { persistScanNode, scanFailedNode } from "./nodes/persist-scan.node";
import { reconcileLocationsNode } from "./nodes/reconcile-locations.node";
import { reconcileInventoryNode } from "./nodes/reconcile-inventory.node";
import { createValidateImagesNode } from "./nodes/validate-images.node";
import {
  routeAfterImageValidation,
  routeAfterLocationAdjudication,
  routeAfterLocationReconciliation,
} from "./routing/scan-routing";
import { ScanState } from "./state";
import type { ScanStateValue } from "./state";

type ScanGraphInput = {
  fridgeId: string;
  imageId: string;
  storageLocation: StorageImageLocation;
};

function scanThreadId(imageId: string) {
  return `scan:${imageId}`;
}

export async function createScanGraph() {
  const promptBundle = await loadPromptBundle();

  return new StateGraph(ScanState)
    .addNode("validate_images", createValidateImagesNode({ promptBundle }))
    .addNode("start_scan_analysis", async () => ({ scanStatus: "processing" }))
    .addNode("detect_inventory", createDetectInventoryNode({ promptBundle }), {
      retryPolicy: {
        maxAttempts: 3,
        initialInterval: 1,
        backoffFactor: 2,
      },
    })
    .addNode("map_zones", createMapZonesNode({ promptBundle }), {
      retryPolicy: {
        maxAttempts: 3,
        initialInterval: 1,
        backoffFactor: 2,
      },
    })
    .addNode("reconcile_locations", reconcileLocationsNode)
    .addNode(
      "adjudicate_locations",
      createAdjudicateLocationsNode({ promptBundle }),
      {
        retryPolicy: {
          maxAttempts: 3,
          initialInterval: 1,
          backoffFactor: 2,
        },
      },
    )
    .addNode("reconcile_inventory", reconcileInventoryNode)
    .addNode("persist_scan", persistScanNode, {
      retryPolicy: {
        maxAttempts: 3,
        initialInterval: 0.5,
        backoffFactor: 2,
      },
    })
    .addNode("scan_failed", scanFailedNode)
    .addEdge(START, "validate_images")
    .addConditionalEdges("validate_images", routeAfterImageValidation, {
      start_scan_analysis: "start_scan_analysis",
      scan_failed: "scan_failed",
    })
    .addEdge("start_scan_analysis", "detect_inventory")
    .addEdge("start_scan_analysis", "map_zones")
    .addEdge(["detect_inventory", "map_zones"], "reconcile_locations")
    .addConditionalEdges(
      "reconcile_locations",
      routeAfterLocationReconciliation,
      {
        adjudicate_locations: "adjudicate_locations",
        reconcile_inventory: "reconcile_inventory",
        scan_failed: "scan_failed",
      },
    )
    .addConditionalEdges("adjudicate_locations", routeAfterLocationAdjudication, {
      reconcile_inventory: "reconcile_inventory",
      scan_failed: "scan_failed",
    })
    .addEdge("reconcile_inventory", "persist_scan")
    .addEdge("persist_scan", END)
    .addEdge("scan_failed", END)
    .compile({
      checkpointer,
    });
}

export async function createScanDisplayGraph() {
  const promptBundle = await loadPromptBundle();

  return new StateGraph(ScanState)
    .addNode("validate_images", createValidateImagesNode({ promptBundle }))
    .addNode("start_scan_analysis", async () => ({ scanStatus: "processing" }))
    .addNode("detect_inventory", createDetectInventoryNode({ promptBundle }), {
      retryPolicy: {
        maxAttempts: 3,
        initialInterval: 1,
        backoffFactor: 2,
      },
    })
    .addNode("map_zones", createMapZonesNode({ promptBundle }), {
      retryPolicy: {
        maxAttempts: 3,
        initialInterval: 1,
        backoffFactor: 2,
      },
    })
    .addNode("reconcile_locations", reconcileLocationsNode)
    .addNode(
      "adjudicate_locations",
      createAdjudicateLocationsNode({ promptBundle }),
      {
        retryPolicy: {
          maxAttempts: 3,
          initialInterval: 1,
          backoffFactor: 2,
        },
      },
    )
    .addNode("reconcile_inventory", reconcileInventoryNode)
    .addNode("scan_failed", scanFailedNode)
    .addEdge(START, "validate_images")
    .addConditionalEdges("validate_images", routeAfterImageValidation, {
      start_scan_analysis: "start_scan_analysis",
      scan_failed: "scan_failed",
    })
    .addEdge("start_scan_analysis", "detect_inventory")
    .addEdge("start_scan_analysis", "map_zones")
    .addEdge(["detect_inventory", "map_zones"], "reconcile_locations")
    .addConditionalEdges(
      "reconcile_locations",
      routeAfterLocationReconciliation,
      {
        adjudicate_locations: "adjudicate_locations",
        reconcile_inventory: "reconcile_inventory",
        scan_failed: "scan_failed",
      },
    )
    .addConditionalEdges("adjudicate_locations", routeAfterLocationAdjudication, {
      reconcile_inventory: "reconcile_inventory",
      scan_failed: "scan_failed",
    })
    .addEdge("reconcile_inventory", END)
    .addEdge("scan_failed", END)
    .compile({
      checkpointer,
    });
}

export function createScanPersistenceGraph() {
  return new StateGraph(ScanState)
    .addNode("persist_scan", persistScanNode, {
      retryPolicy: {
        maxAttempts: 3,
        initialInterval: 0.5,
        backoffFactor: 2,
      },
    })
    .addEdge(START, "persist_scan")
    .addEdge("persist_scan", END)
    .compile({
      checkpointer,
    });
}

export async function runScanForStorageImage(input: ScanGraphInput) {
  const langsmith = assertLangSmithTracingEnabled();
  const graph = await createScanDisplayGraph();
  const threadId = scanThreadId(input.imageId);

  return graph.invoke(
    {
      fridgeId: input.fridgeId,
      imageIds: [input.imageId],
      storageLocation: input.storageLocation,
    },
    {
      runName: "scan_storage_image",
      tags: ["fridgefriend", "scan_graph", "upload_scan"],
      metadata: {
        fridgeId: input.fridgeId,
        imageId: input.imageId,
        storageLocation: input.storageLocation,
        thread_id: threadId,
        langsmithProject: langsmith.project,
        langsmithPromptEnvironment: langsmith.promptEnvironment,
      },
      configurable: {
        thread_id: threadId,
      },
    },
  );
}

async function persistScanForFridgeImage(input: ScanGraphInput & {
  scanState: ScanStateValue;
}) {
  const langsmith = assertLangSmithTracingEnabled();
  const graph = createScanPersistenceGraph();
  const threadId = scanThreadId(input.imageId);

  await graph.invoke(
    {
      ...input.scanState,
      fridgeId: input.fridgeId,
      imageIds: [input.imageId],
      storageLocation: input.storageLocation,
    },
    {
      runName: "persist_scan_background",
      tags: ["fridgefriend", "scan_graph", "persist_scan"],
      metadata: {
        fridgeId: input.fridgeId,
        imageId: input.imageId,
        storageLocation: input.storageLocation,
        thread_id: threadId,
        langsmithProject: langsmith.project,
        langsmithPromptEnvironment: langsmith.promptEnvironment,
      },
      configurable: {
        thread_id: threadId,
      },
    },
  );
}

export function persistScanForFridgeImageInBackground(
  input: ScanGraphInput & { scanState: ScanStateValue },
) {
  setTimeout(() => {
    void persistScanForFridgeImage(input).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `Background persist_scan failed for image ${input.imageId}: ${message}`,
      );
    });
  }, 0);
}
