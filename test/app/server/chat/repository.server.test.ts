import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  createChat,
  getChat,
  getOrCreateLatestChat,
  recentChatMessagesForQuery,
  resumeChatExecution,
  startChatTurn,
  updateChatAssistantMessage,
} from "../../../../app/server/chat/repository.server";
import { INITIAL_CHAT_ASSISTANT_TEXT } from "../../../../app/chat/contracts";
import { resetSqliteBootstrapCacheForTests } from "../../../../app/server/sqlite.server";

const databasePaths: string[] = [];

function withTestDatabase<T>(callback: () => T) {
  const databasePath = path.join(tmpdir(), `fridgefriend-chat-test-${randomUUID()}.sqlite`);
  const previousDatabasePath = process.env.DATABASE_PATH;
  databasePaths.push(databasePath);
  process.env.DATABASE_PATH = databasePath;
  resetSqliteBootstrapCacheForTests();

  try {
    return callback();
  } finally {
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    resetSqliteBootstrapCacheForTests();
  }
}

afterEach(() => {
  for (const databasePath of databasePaths.splice(0)) {
    rmSync(databasePath, { force: true });
    rmSync(`${databasePath}-wal`, { force: true });
    rmSync(`${databasePath}-shm`, { force: true });
  }
});

describe("chat persistence", () => {
  const scope = {
    userId: "user-1",
    fridgeId: "fridge-1",
    imageId: "image-1",
  };

  it("creates a persisted chat with its greeting and restores completed turns", () => withTestDatabase(() => {
    const chat = createChat(scope);

    expect(chat.messages).toHaveLength(1);
    expect(chat.messages[0]).toMatchObject({
      role: "assistant",
      status: "idle",
      payload: { text: INITIAL_CHAT_ASSISTANT_TEXT },
    });

    const userMessageId = randomUUID();
    const assistantMessageId = randomUUID();
    startChatTurn({
      ...scope,
      threadId: chat.id,
      userMessage: { id: userMessageId, role: "user", payload: { text: "What can I make?" } },
      assistantMessage: { id: assistantMessageId, role: "assistant", payload: { text: "" } },
    });
    updateChatAssistantMessage({
      ...scope,
      threadId: chat.id,
      assistantMessageId,
      payload: { text: "You can make a vegetable omelet." },
      status: "idle",
    });

    expect(getChat(chat.id, scope)).toMatchObject({
      executionStatus: "idle",
      messages: [
        { role: "assistant", payload: { text: INITIAL_CHAT_ASSISTANT_TEXT } },
        { id: userMessageId, role: "user", payload: { text: "What can I make?" } },
        { id: assistantMessageId, role: "assistant", status: "idle", payload: { text: "You can make a vegetable omelet." } },
      ],
    });
  }));

  it("returns the same latest chat and resumes its interrupted assistant response", () => withTestDatabase(() => {
    const chat = getOrCreateLatestChat(scope);
    const userMessageId = randomUUID();
    const assistantMessageId = randomUUID();
    startChatTurn({
      ...scope,
      threadId: chat.id,
      userMessage: { id: userMessageId, role: "user", payload: { text: "Check the carton." } },
      assistantMessage: { id: assistantMessageId, role: "assistant", payload: { text: "" } },
    });
    updateChatAssistantMessage({
      ...scope,
      threadId: chat.id,
      assistantMessageId,
      payload: { text: "How many eggs are left?" },
      status: "interrupted",
    });

    expect(getOrCreateLatestChat(scope).id).toBe(chat.id);
    expect(resumeChatExecution({ ...scope, threadId: chat.id })).toBe(assistantMessageId);
    const resumed = getChat(chat.id, scope);
    expect(resumed.executionStatus).toBe("running");
    expect(resumed.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: assistantMessageId, status: "running", payload: { text: "How many eggs are left?" } }),
    ]));
  }));

  it("returns compact completed chat messages for query context", () => withTestDatabase(() => {
    const chat = createChat(scope);
    const firstUserMessageId = randomUUID();
    const firstAssistantMessageId = randomUUID();
    startChatTurn({
      ...scope,
      threadId: chat.id,
      userMessage: { id: firstUserMessageId, role: "user", payload: { text: "What can I make?" } },
      assistantMessage: { id: firstAssistantMessageId, role: "assistant", payload: { text: "" } },
    });
    updateChatAssistantMessage({
      ...scope,
      threadId: chat.id,
      assistantMessageId: firstAssistantMessageId,
      payload: { text: "You can make soup." },
      status: "idle",
    });
    startChatTurn({
      ...scope,
      threadId: chat.id,
      userMessage: { id: randomUUID(), role: "user", payload: { text: "Tell me about that one." } },
      assistantMessage: { id: randomUUID(), role: "assistant", payload: { text: "" } },
    });

    expect(recentChatMessagesForQuery(getChat(chat.id, scope))).toEqual([
      { role: "assistant", text: INITIAL_CHAT_ASSISTANT_TEXT },
      { role: "user", text: "What can I make?" },
      { role: "assistant", text: "You can make soup." },
      { role: "user", text: "Tell me about that one." },
    ]);
  }));

  it("keeps latest chat selection scoped to the selected image", () => withTestDatabase(() => {
    const firstImageChat = createChat(scope);
    const secondImageScope = { ...scope, imageId: "image-2" };
    const fridgeWideScope = { ...scope, imageId: null };
    const secondImageChat = createChat(secondImageScope);
    const fridgeWideChat = createChat(fridgeWideScope);

    const userMessageId = randomUUID();
    const assistantMessageId = randomUUID();
    startChatTurn({
      ...secondImageScope,
      threadId: secondImageChat.id,
      userMessage: { id: userMessageId, role: "user", payload: { text: "What is in this image?" } },
      assistantMessage: { id: assistantMessageId, role: "assistant", payload: { text: "" } },
    });
    updateChatAssistantMessage({
      ...secondImageScope,
      threadId: secondImageChat.id,
      assistantMessageId,
      payload: { text: "This image has spinach." },
      status: "idle",
    });

    expect(getOrCreateLatestChat(scope).id).toBe(firstImageChat.id);
    expect(getOrCreateLatestChat(secondImageScope).id).toBe(secondImageChat.id);
    expect(getOrCreateLatestChat(fridgeWideScope).id).toBe(fridgeWideChat.id);
    expect(() => getChat(secondImageChat.id, scope)).toThrow(/was not found for this fridge/);
  }));
});
