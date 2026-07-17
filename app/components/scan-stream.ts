import {
  ScanStreamEventSchema,
  type ScanStreamEvent,
} from "../workspace/scan-events";

export type { ScanStreamEvent } from "../workspace/scan-events";

export function parseScanStreamEvent(line: string): ScanStreamEvent {
  let payload: unknown;

  try {
    payload = JSON.parse(line);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Scan stream event was not valid JSON: ${message}`);
  }

  if (
    typeof payload !== "object" ||
    payload === null ||
    typeof (payload as Record<string, unknown>).type !== "string"
  ) {
    throw new Error("Scan stream event did not include a type");
  }

  const parsed = ScanStreamEventSchema.safeParse(payload);

  if (!parsed.success) {
    throw new Error(
      `Scan stream event had invalid shape for ${(payload as Record<string, unknown>).type as string}`,
    );
  }

  return parsed.data;
}

export function createScanStreamParser(
  onEvent: (event: ScanStreamEvent) => void,
) {
  let buffer = "";

  function flushLine(line: string) {
    if (line.trim().length === 0) {
      return;
    }

    onEvent(parseScanStreamEvent(line));
  }

  return {
    push(chunk: string) {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        flushLine(line);
      }
    },
    close() {
      flushLine(buffer);
      buffer = "";
    },
  };
}

export async function readScanStream(
  response: Response,
  onEvent: (event: ScanStreamEvent) => void,
) {
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `HTTP ${response.status}`);
  }

  if (!response.body) {
    throw new Error("Scan response did not include a stream body");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parser = createScanStreamParser(onEvent);

  while (true) {
    const result = await reader.read();

    if (result.done) {
      break;
    }

    parser.push(decoder.decode(result.value, { stream: true }));
  }

  const remaining = decoder.decode();

  if (remaining.length > 0) {
    parser.push(remaining);
  }

  parser.close();
}
