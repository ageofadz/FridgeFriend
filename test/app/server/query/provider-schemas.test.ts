import { describe, expect, it } from "vitest";

import { MemoryExtractionResultProviderSchema } from "../../../../app/server/memory/schemas";
import {
  IntentResponseProviderSchema,
  RecipeSearchRequestProviderSchema,
} from "../../../../app/server/query/schemas/query";

const unsupportedProviderKeys = new Set([
  "$schema",
  "const",
  "default",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "minLength",
  "oneOf",
]);

function collectUnsupportedKeys(value: unknown, path = "schema"): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      collectUnsupportedKeys(item, `${path}[${index}]`)
    );
  }

  if (!value || typeof value !== "object") {
    return [];
  }

  return Object.entries(value).flatMap(([key, nested]) => [
    ...(unsupportedProviderKeys.has(key) ? [`${path}.${key}`] : []),
    ...(key === "type" && Array.isArray(nested) ? [`${path}.type[]`] : []),
    ...collectUnsupportedKeys(nested, `${path}.${key}`),
  ]);
}

describe("Gemini provider schemas", () => {
  it("avoid unsupported JSON Schema fields in query graph structured outputs", () => {
    expect(collectUnsupportedKeys(IntentResponseProviderSchema)).toEqual([]);
    expect(collectUnsupportedKeys(RecipeSearchRequestProviderSchema)).toEqual([]);
    expect(collectUnsupportedKeys(MemoryExtractionResultProviderSchema)).toEqual([]);
  });
});
