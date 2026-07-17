import { describe, expect, it, vi } from "vitest";

const createChatModel = vi.fn((input: unknown) => input);

vi.mock("../../../../../app/server/ai/chat-model.server", () => ({
  CHAT_MODEL: "gemini-3.1-flash-lite",
  CHAT_PROVIDER: "google",
  createChatModel,
}));

describe("query model service", () => {
  it("disables provider streaming by default", async () => {
    const { createQueryModel } = await import("../../../../../app/server/query/services/query-model.server");

    createQueryModel();

    expect(createChatModel).toHaveBeenCalledWith({
      model: "gemini-3.1-flash-lite",
      streaming: false,
      maxOutputTokens: undefined,
    });
  });

  it("passes explicit streaming settings through", async () => {
    const { createQueryModel } = await import("../../../../../app/server/query/services/query-model.server");

    createQueryModel(true);

    expect(createChatModel).toHaveBeenLastCalledWith({
      model: "gemini-3.1-flash-lite",
      streaming: true,
      maxOutputTokens: undefined,
    });
  });

  it("uses a small output budget for intent routing", async () => {
    const { createIntentRoutingModel, INTENT_ROUTING_MAX_OUTPUT_TOKENS } = await import("../../../../../app/server/query/services/query-model.server");

    createIntentRoutingModel();

    expect(createChatModel).toHaveBeenLastCalledWith({
      model: "gemini-3.1-flash-lite",
      streaming: false,
      maxOutputTokens: INTENT_ROUTING_MAX_OUTPUT_TOKENS,
    });
  });
});
