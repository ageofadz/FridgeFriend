import { describe, expect, it } from "vitest";

import {
  createScanStreamParser,
  parseScanStreamEvent,
  type ScanStreamEvent,
} from "../../../app/components/scan-stream";

const rawDetection = {
  id: "milk",
  img: "image-1",
  name: "Milk",
  conf: 0.94,
  bbox: { x: 0.2, y: 0.3, width: 0.2, height: 0.4 },
  zone: null,
  pack: "carton",
  qty: "one carton",
};

describe("scan stream parser", () => {
  it("parses raw detections before scan completion across split NDJSON chunks", () => {
    const events: ScanStreamEvent[] = [];
    const parser = createScanStreamParser((event) => events.push(event));

    parser.push('{"type":"image_created","image":{"id":"image-1","originalName":"fridge.jpg","storageLocation":"fridge","baseImageId":null,"createdAt":"2026-07-17T00:00:00.000Z"}}\n{"type":"raw_dete');
    parser.push(`ctions","imageId":"image-1","rawDetections":[${JSON.stringify(rawDetection)}]}\n{"type":"status","node":"reconcile_inventory"}\n`);
    parser.close();

    expect(events).toEqual([
      {
        type: "image_created",
        image: {
          id: "image-1",
          originalName: "fridge.jpg",
          storageLocation: "fridge",
          baseImageId: null,
          createdAt: "2026-07-17T00:00:00.000Z",
        },
      },
      {
        type: "raw_detections",
        imageId: "image-1",
        rawDetections: [rawDetection],
      },
      { type: "status", node: "reconcile_inventory" },
    ]);
  });

  it("rejects malformed raw detection events", () => {
    expect(() => parseScanStreamEvent('{"type":"raw_detections","imageId":"image-1","rawDetections":[{"id":"milk"}]}')).toThrow(
      "Scan stream event had invalid shape for raw_detections",
    );
  });
});
