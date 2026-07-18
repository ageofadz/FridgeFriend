// Pure trace sanitization helpers. No server-only module imports beyond
// node:crypto so eval and script callers can use them freely.

import { createHash } from "node:crypto";

const SECRET_KEY_PATTERN = /api[-_]?key|authorization|token|secret|password|signed[-_]?url|apikey/i;
const DATA_URL_PATTERN = /^data:[^;,]*;base64,/i;
const DEFAULT_MAX_STRING_LENGTH = 2000;
const MAX_ARRAY_LENGTH = 50;
const ARRAY_SAMPLE_SIZE = 3;

function sha256Hex(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function sanitizeString(value: string, maxStringLength: number): string {
  if (DATA_URL_PATTERN.test(value)) {
    return `[image:${sha256Hex(value).slice(0, 12)}]`;
  }
  if (value.length > maxStringLength) {
    const truncated = value.length - maxStringLength;
    return `${value.slice(0, maxStringLength)}…[truncated ${truncated} chars]`;
  }
  return value;
}

/**
 * Deep-walks a JSON-ish value producing a sanitized copy: base64 image data
 * URLs become `[image:<hash>]`, secret-keyed values become `[redacted]`,
 * oversized strings are truncated, and oversized arrays are summarized as
 * `{ count, sample }`. Never mutates its input.
 */
export function sanitizeTracePayload(
  value: unknown,
  opts?: { maxStringLength?: number },
): unknown {
  const maxStringLength = opts?.maxStringLength ?? DEFAULT_MAX_STRING_LENGTH;

  const walk = (current: unknown): unknown => {
    if (typeof current === "string") {
      return sanitizeString(current, maxStringLength);
    }

    if (Array.isArray(current)) {
      if (current.length > MAX_ARRAY_LENGTH) {
        return {
          count: current.length,
          sample: current.slice(0, ARRAY_SAMPLE_SIZE).map(walk),
        };
      }
      return current.map(walk);
    }

    if (typeof current === "object" && current !== null) {
      const result: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(current)) {
        result[key] = SECRET_KEY_PATTERN.test(key) ? "[redacted]" : walk(entry);
      }
      return result;
    }

    return current;
  };

  return walk(value);
}

const DEFAULT_IDENTIFIER_KEY_PATTERN = /^(user|fridge|image)[-_]?id$/i;

/**
 * Returns a copy of `metadata` with household identifier values replaced by
 * their stable hash (same semantics as `hashIdentifier` in
 * trace-context.server.ts: `h:` + first 16 hex chars of sha256). By default
 * userId/fridgeId/imageId-like keys are hashed; pass `keys` to override.
 */
export function hashHouseholdIdentifiers(
  metadata: Record<string, unknown>,
  keys?: string[],
): Record<string, unknown> {
  const shouldHash = (key: string) =>
    keys ? keys.includes(key) : DEFAULT_IDENTIFIER_KEY_PATTERN.test(key);

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    result[key] = shouldHash(key) && typeof value === "string" && value.length > 0
      ? `h:${sha256Hex(value).slice(0, 16)}`
      : value;
  }
  return result;
}
