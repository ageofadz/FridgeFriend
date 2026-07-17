import { describe, expect, it } from "vitest";

import {
  geminiStreamParseErrorMessage,
  isGeminiStreamParseError,
} from "../../../../app/server/ai/gemini-errors.server";

describe("Gemini error handling", () => {
  it("recognizes Gemini stream parser failures", () => {
    const error = new Error("Failed to parse stream");
    error.name = "GoogleGenerativeAIError";

    expect(isGeminiStreamParseError(error)).toBe(true);
    expect(geminiStreamParseErrorMessage(error, "Query graph stream")).toBe(
      "Query graph stream failed because Gemini returned an unparsable stream: GoogleGenerativeAIError: Failed to parse stream",
    );
  });

  it("does not classify unrelated Gemini errors as stream parser failures", () => {
    const error = new Error("Google API key was not found");
    error.name = "GoogleGenerativeAIError";

    expect(isGeminiStreamParseError(error)).toBe(false);
  });
});
