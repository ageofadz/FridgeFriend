import { describe, expect, it } from "vitest";

import {
  hashHouseholdIdentifiers,
  sanitizeTracePayload,
} from "../../../../app/server/observability/sanitize-trace";

describe("sanitizeTracePayload", () => {
  it("replaces base64 image data URLs with a hashed placeholder", () => {
    const dataUrl = `data:image/png;base64,${"A".repeat(200)}`;
    const result = sanitizeTracePayload({ image: dataUrl }) as Record<string, unknown>;

    expect(result.image).toMatch(/^\[image:[0-9a-f]{12}\]$/);
    // Stable: same input yields same placeholder.
    const again = sanitizeTracePayload({ image: dataUrl }) as Record<string, unknown>;
    expect(again.image).toBe(result.image);
  });

  it("redacts secret-like keys including nested objects and case variants", () => {
    const result = sanitizeTracePayload({
      apiKey: "abc",
      API_KEY: "def",
      Authorization: "Bearer xyz",
      nested: {
        signed_url: "https://example.com?sig=1",
        "signed-url": "https://example.com?sig=2",
        password: "hunter2",
        refreshToken: "tok",
        SECRET_VALUE: "shh",
        safe: "keep me",
      },
    }) as Record<string, unknown>;

    expect(result.apiKey).toBe("[redacted]");
    expect(result.API_KEY).toBe("[redacted]");
    expect(result.Authorization).toBe("[redacted]");
    const nested = result.nested as Record<string, unknown>;
    expect(nested.signed_url).toBe("[redacted]");
    expect(nested["signed-url"]).toBe("[redacted]");
    expect(nested.password).toBe("[redacted]");
    expect(nested.refreshToken).toBe("[redacted]");
    expect(nested.SECRET_VALUE).toBe("[redacted]");
    expect(nested.safe).toBe("keep me");
  });

  it("truncates strings longer than the limit", () => {
    const long = "x".repeat(2500);
    const result = sanitizeTracePayload(long) as string;

    expect(result.startsWith("x".repeat(2000))).toBe(true);
    expect(result).toContain("…[truncated 500 chars]");

    const custom = sanitizeTracePayload("y".repeat(20), { maxStringLength: 10 }) as string;
    expect(custom).toBe(`${"y".repeat(10)}…[truncated 10 chars]`);
  });

  it("summarizes arrays longer than 50 entries", () => {
    const items = Array.from({ length: 120 }, (_, index) => `item-${index}`);
    const result = sanitizeTracePayload({ items }) as Record<string, unknown>;

    expect(result.items).toEqual({
      count: 120,
      sample: ["item-0", "item-1", "item-2"],
    });
  });

  it("leaves short arrays and primitives intact", () => {
    const value = { list: [1, 2, 3], flag: true, none: null, num: 4.5 };
    expect(sanitizeTracePayload(value)).toEqual(value);
  });

  it("never mutates its input", () => {
    const input = {
      apiKey: "abc",
      nested: { token: "t", list: Array.from({ length: 60 }, () => "v") },
      image: "data:image/jpeg;base64,QUJD",
    };
    const snapshot = structuredClone(input);

    sanitizeTracePayload(input);

    expect(input).toEqual(snapshot);
  });
});

describe("hashHouseholdIdentifiers", () => {
  it("hashes identifier keys stably without echoing the raw value", () => {
    const metadata = { userId: "user-1", fridgeId: "fridge-1", imageId: "img-1", other: "keep" };
    const first = hashHouseholdIdentifiers(metadata);
    const second = hashHouseholdIdentifiers(metadata);

    expect(first).toEqual(second);
    expect(first.other).toBe("keep");
    for (const key of ["userId", "fridgeId", "imageId"] as const) {
      expect(first[key]).toMatch(/^h:[0-9a-f]{16}$/);
      expect(first[key]).not.toBe(metadata[key]);
      expect(String(first[key])).not.toContain(metadata[key]);
    }
    // Different inputs hash differently.
    expect(first.userId).not.toBe(first.fridgeId);
    // Input not mutated.
    expect(metadata.userId).toBe("user-1");
  });

  it("honors an explicit key list", () => {
    const result = hashHouseholdIdentifiers(
      { customId: "abc", userId: "user-1" },
      ["customId"],
    );

    expect(result.customId).toMatch(/^h:[0-9a-f]{16}$/);
    expect(result.userId).toBe("user-1");
  });
});
