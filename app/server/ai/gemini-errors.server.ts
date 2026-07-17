export function formatUnknownError(error: unknown) {
  if (error instanceof Error) {
    return error.name && error.name !== "Error"
      ? `${error.name}: ${error.message}`
      : error.message;
  }

  return String(error);
}

export function isGeminiStreamParseError(error: unknown) {
  if (!(error instanceof Error)) {
    return false;
  }

  return (
    error.message === "Failed to parse stream" ||
    (
      error.message.includes("Failed to parse stream") &&
      (error.name === "GoogleGenerativeAIError" || error.stack?.includes("@google/generative-ai"))
    )
  );
}

export function geminiStreamParseErrorMessage(error: unknown, operation: string) {
  return `${operation} failed because Gemini returned an unparsable stream: ${formatUnknownError(error)}`;
}

export type GeminiStreamReadResult<T> =
  | { type: "chunk"; chunk: T }
  | { type: "gemini_stream_parse_error"; error: string };

export async function* readGeminiStream<T>(
  stream: AsyncIterable<T>,
  operation: string,
): AsyncGenerator<GeminiStreamReadResult<T>> {
  try {
    for await (const chunk of stream) {
      yield { type: "chunk", chunk };
    }
  } catch (error) {
    if (isGeminiStreamParseError(error)) {
      yield {
        type: "gemini_stream_parse_error",
        error: geminiStreamParseErrorMessage(error, operation),
      };
      return;
    }

    throw error;
  }
}
