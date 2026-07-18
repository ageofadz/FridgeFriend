import { END, START, StateGraph, type RetryPolicy } from "@langchain/langgraph";

import { checkpointer } from "../checkpointer.server";
import {
  readGeminiStream,
} from "../ai/gemini-errors.server";
import type { StorageImageLocation } from "../images.server";
import { getLangSmithConfig } from "../langsmith.server";
import { CHAT_VISION_MODEL } from "../ai/chat-model.server";
import {
  buildScanTraceOptions,
  graphRevisionFor,
  resolveTraceEnvironment,
} from "../observability/trace-context.server";
import { loadPromptBundle } from "../prompts/registry.server";
import { createDetectInventoryNode } from "./nodes/detect-inventory.node";
import { createGroundItemPlacementsNode } from "./nodes/ground-item-placements.node";
import { finalizeScanNode } from "./nodes/finalize-scan.node";
import { createMapZonesNode } from "./nodes/map-zones.node";
import { reconcileInventoryNode } from "./nodes/reconcile-inventory.node";
import { scanFailedNode } from "./nodes/scan-failed.node";
import { createValidateImagesNode } from "./nodes/validate-images.node";
import {
  routeAfterImageValidation,
  routeAfterInventoryReconciliation,
  routeAfterPlacementGrounding,
} from "./routing/scan-routing";
import { ScanState } from "./state";
import type { ScanStateValue } from "./state";
import type { ScanStreamEvent } from "../../workspace/scan-events";
import type { PromptBundle } from "../prompts/registry.server";
import type { FridgeFriendChatModel } from "../ai/chat-model.server";

export type ScanGraphInput = {
  fridgeId: string;
  imageId: string;
  storageLocation: StorageImageLocation;
};

export type ScanGraphDependencies = {
  promptBundle?: Pick<PromptBundle, "imageValidation" | "inventoryDetection" | "zoneMap">;
  validationModel?: FridgeFriendChatModel;
  detectionModel?: FridgeFriendChatModel;
  zoneMapModel?: FridgeFriendChatModel;
  loadImageDataUrls?: (imageIds: string[]) => string[];
  checkpointer?: typeof checkpointer | null;
};

const scanGraphModelRetryPolicy: RetryPolicy = {
  maxAttempts: 4,
  initialInterval: 1000,
  backoffFactor: 2,
  jitter: false,
  logWarning: false,
};

function scanThreadId(imageId: string) {
  return `scan:${imageId}`;
}

function scanConfig(input: ScanGraphInput, graphRevision: string) {
  const langsmith = getLangSmithConfig();
  const threadId = scanThreadId(input.imageId);
  const graphInput = scanGraphInput(input);
  const trace = buildScanTraceOptions({
    threadId,
    requestId: "",
    fridgeId: input.fridgeId,
    imageId: input.imageId,
    environment: resolveTraceEnvironment(),
    mode: "live",
    model: CHAT_VISION_MODEL,
    promptRefs: {},
    graphRevision,
    imageCount: graphInput.imageIds.length,
    storageKind: input.storageLocation,
  });

  return {
    runName: trace.runName,
    tags: trace.tags,
    metadata: {
      ...trace.metadata,
      ...(langsmith ? { langsmithProject: langsmith.project } : {}),
    },
    configurable: {
      thread_id: threadId,
    },
  };
}

function scanGraphInput(input: ScanGraphInput) {
  return {
    fridgeId: input.fridgeId,
    imageIds: [input.imageId],
    storageLocation: input.storageLocation,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * The scan pipeline:
 *
 * validate_images -> start_scan_analysis -> detect_inventory + map_zones
 * (parallel) -> ground_item_placements -> reconcile_inventory -> finalize_scan.
 *
 * Every validation failure routes to scan_failed, which records the failing
 * stage and reason. Database persistence happens in the caller — the graph
 * only produces the reconciled inventory and checkpoints its state.
 */
export async function createScanGraph(deps: ScanGraphDependencies = {}) {
  const promptBundle = deps.promptBundle ?? await loadPromptBundle();
  const graphCheckpointer = deps.checkpointer === undefined
    ? checkpointer
    : deps.checkpointer;

  return new StateGraph(ScanState)
    .addNode("validate_images", createValidateImagesNode({ promptBundle, validationModel: deps.validationModel, loadImageDataUrls: deps.loadImageDataUrls }), {
      retryPolicy: scanGraphModelRetryPolicy,
    })
    .addNode("start_scan_analysis", async () => ({ scanStatus: "processing" }))
    .addNode("detect_inventory", createDetectInventoryNode({ promptBundle, detectionModel: deps.detectionModel, loadImageDataUrls: deps.loadImageDataUrls }), {
      retryPolicy: scanGraphModelRetryPolicy,
    })
    .addNode("map_zones", createMapZonesNode({ promptBundle, zoneMapModel: deps.zoneMapModel, loadImageDataUrls: deps.loadImageDataUrls }), {
      retryPolicy: scanGraphModelRetryPolicy,
    })
    .addNode("ground_item_placements", createGroundItemPlacementsNode())
    .addNode("reconcile_inventory", reconcileInventoryNode)
    .addNode("finalize_scan", finalizeScanNode)
    .addNode("scan_failed", scanFailedNode)
    .addEdge(START, "validate_images")
    .addConditionalEdges("validate_images", routeAfterImageValidation, {
      start_scan_analysis: "start_scan_analysis",
      scan_failed: "scan_failed",
    })
    .addEdge("start_scan_analysis", "detect_inventory")
    .addEdge("start_scan_analysis", "map_zones")
    .addEdge(["detect_inventory", "map_zones"], "ground_item_placements")
    .addConditionalEdges("ground_item_placements", routeAfterPlacementGrounding, {
      reconcile_inventory: "reconcile_inventory",
      scan_failed: "scan_failed",
    })
    .addConditionalEdges(
      "reconcile_inventory",
      routeAfterInventoryReconciliation,
      {
        finalize_scan: "finalize_scan",
        scan_failed: "scan_failed",
      },
    )
    .addEdge("finalize_scan", END)
    .addEdge("scan_failed", END)
    .compile(graphCheckpointer ? { checkpointer: graphCheckpointer } : undefined);
}

/**
 * Minimal single-node graph used only to record the caller's final scan
 * outcome (the database-saved inventory) into the scan thread's checkpoint.
 * It shares the scan state schema and checkpointer, so the update lands on
 * the same thread as the scan run.
 */
function createRecordScanOutcomeGraph() {
  return new StateGraph(ScanState)
    .addNode("record_scan_outcome", finalizeScanNode)
    .addEdge(START, "record_scan_outcome")
    .addEdge("record_scan_outcome", END)
    .compile({
      checkpointer,
    });
}

export async function runScanForStorageImage(input: ScanGraphInput) {
  const graph = await createScanGraph();

  return graph.invoke(
    scanGraphInput(input),
    scanConfig(input, graphRevisionFor(graph)),
  );
}

export async function* streamScanForStorageImage(
  input: ScanGraphInput,
): AsyncGenerator<Exclude<ScanStreamEvent, { type: "image_created" | "complete" }>, ScanStateValue> {
  const graph = await createScanGraph();
  const config = scanConfig(input, graphRevisionFor(graph));
  const stream = await graph.stream(
    scanGraphInput(input),
    {
      ...config,
      streamMode: "updates",
    },
  );

  for await (const streamResult of readGeminiStream(stream, "Scan graph stream")) {
    if (streamResult.type === "gemini_stream_parse_error") {
      yield {
        type: "error",
        error: streamResult.error,
      };
      return (await graph.getState(config)).values as ScanStateValue;
    }

    const update = streamResult.chunk;

    if (!isRecord(update)) {
      throw new Error("Scan graph emitted an update with an invalid shape");
    }

    const nodeNames = Object.keys(update);

    for (const node of nodeNames) {
      yield { type: "status", node };
    }

    const detectionUpdate = update.detect_inventory;

    if (!isRecord(detectionUpdate)) {
      continue;
    }

    const detectionValidation = detectionUpdate.detectionValidation;
    const rawDetections = detectionUpdate.rawDetections;

    if (
      !isRecord(detectionValidation) ||
      detectionValidation.valid !== true ||
      !Array.isArray(rawDetections)
    ) {
      continue;
    }

    yield {
      type: "raw_detections",
      imageId: input.imageId,
      rawDetections: rawDetections as ScanStateValue["rawDetections"],
    };
  }

  const state = await graph.getState(config);
  const values = state.values as ScanStateValue;

  if (values.imageValidation?.valid === false) {
    yield {
      type: "invalid_storage_image",
      reason: values.imageValidation.reason ?? "Image validation failed",
    };
    return values;
  }

  if (values.error) {
    yield {
      type: "error",
      error: values.error.message,
    };
    return values;
  }

  if (!values.inventory) {
    yield {
      type: "error",
      error: "Scan ended without reconciled inventory",
    };
  }

  return values;
}

async function recordScanOutcomeForFridgeImage(input: ScanGraphInput & {
  scanState: ScanStateValue;
}) {
  const langsmith = getLangSmithConfig();
  const graph = createRecordScanOutcomeGraph();
  const threadId = scanThreadId(input.imageId);

  await graph.invoke(
    {
      ...input.scanState,
      fridgeId: input.fridgeId,
      imageIds: [input.imageId],
      storageLocation: input.storageLocation,
    },
    {
      runName: "record_scan_outcome_background",
      tags: ["fridgefriend", "scan_graph", "record_scan_outcome"],
      metadata: {
        fridgeId: input.fridgeId,
        imageId: input.imageId,
        storageLocation: input.storageLocation,
        thread_id: threadId,
        ...(langsmith ? { langsmithProject: langsmith.project } : {}),
      },
      configurable: {
        thread_id: threadId,
      },
    },
  );
}

/**
 * Records the final scan state (including the database-saved inventory) on
 * the scan thread's checkpoint without blocking the caller's response. The
 * database write itself happens before this call, in the upload route.
 */
export function persistScanForFridgeImageInBackground(
  input: ScanGraphInput & { scanState: ScanStateValue },
) {
  setTimeout(() => {
    void recordScanOutcomeForFridgeImage(input).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `Background scan-outcome recording failed for image ${input.imageId}: ${message}`,
      );
    });
  }, 0);
}
