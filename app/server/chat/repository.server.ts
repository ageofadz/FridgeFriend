import { randomUUID } from "node:crypto";

import {
  INITIAL_CHAT_ASSISTANT_TEXT,
  type ChatExecutionStatus,
  type PersistedChat,
  type PersistedChatMessage,
} from "../../chat/contracts";
import { withDatabase } from "../sqlite.server";

type ChatScope = {
  userId: string;
  fridgeId: string;
  imageId: string | null;
};

type ChatMessageInput = {
  id: string;
  role: "user" | "assistant";
  payload: Record<string, unknown>;
};

type ChatRow = {
  id: string;
  user_id: string;
  fridge_id: string;
  image_id: string | null;
  execution_status: ChatExecutionStatus;
  created_at: string;
  updated_at: string;
};

type ChatMessageRow = {
  id: string;
  role: "user" | "assistant";
  payload_json: string;
  status: ChatExecutionStatus;
  created_at: string;
  updated_at: string;
};

function isPayload(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePayload(messageId: string, payloadJson: string) {
  let payload: unknown;

  try {
    payload = JSON.parse(payloadJson);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Chat message ${messageId} has invalid payload JSON: ${message}`);
  }

  if (!isPayload(payload) || typeof payload.text !== "string") {
    throw new Error(`Chat message ${messageId} has an invalid payload`);
  }

  return payload;
}

function messageFromRow(row: ChatMessageRow): PersistedChatMessage {
  return {
    id: row.id,
    role: row.role,
    payload: parsePayload(row.id, row.payload_json),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function chatFromRow(row: ChatRow, messages: PersistedChatMessage[]): PersistedChat {
  return {
    id: row.id,
    userId: row.user_id,
    fridgeId: row.fridge_id,
    imageId: row.image_id,
    executionStatus: row.execution_status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    messages,
  };
}

function validateScope(scope: ChatScope) {
  if (!scope.userId.trim()) throw new Error("Chat userId is required");
  if (!scope.fridgeId.trim()) throw new Error("Chat fridgeId is required");
}

function getChatRow(id: string, scope: ChatScope) {
  return withDatabase((_, sqlite) => sqlite.prepare(`
    select id, user_id, fridge_id, image_id, execution_status, created_at, updated_at
    from fridge_chat_threads
    where id = ? and user_id = ? and fridge_id = ? and image_id is ?
  `).get(id, scope.userId, scope.fridgeId, scope.imageId) as ChatRow | undefined);
}

function loadChat(id: string, scope: ChatScope) {
  const row = getChatRow(id, scope);

  if (!row) {
    throw new Error(`Chat thread ${id} was not found for this fridge`);
  }

  const messages = withDatabase((_, sqlite) => sqlite.prepare(`
    select id, role, payload_json, status, created_at, updated_at
    from fridge_chat_messages
    where thread_id = ?
    order by created_at asc, rowid asc
  `).all(id) as ChatMessageRow[]).map(messageFromRow);

  return chatFromRow(row, messages);
}

export function createChat(scope: ChatScope): PersistedChat {
  validateScope(scope);
  const id = randomUUID();
  const assistantMessageId = randomUUID();
  const now = new Date().toISOString();

  withDatabase((_, sqlite) => {
    const transaction = sqlite.transaction(() => {
      sqlite.prepare(`
        insert into fridge_chat_threads (id, user_id, fridge_id, image_id, execution_status, created_at, updated_at)
        values (?, ?, ?, ?, 'idle', ?, ?)
      `).run(id, scope.userId, scope.fridgeId, scope.imageId, now, now);
      sqlite.prepare(`
        insert into fridge_chat_messages (id, thread_id, role, payload_json, status, created_at, updated_at)
        values (?, ?, 'assistant', ?, 'idle', ?, ?)
      `).run(assistantMessageId, id, JSON.stringify({ text: INITIAL_CHAT_ASSISTANT_TEXT }), now, now);
    });

    transaction();
  });

  return loadChat(id, scope);
}

export function getOrCreateLatestChat(scope: ChatScope): PersistedChat {
  validateScope(scope);
  const existing = withDatabase((_, sqlite) => sqlite.prepare(`
    select id
    from fridge_chat_threads
    where user_id = ? and fridge_id = ? and image_id is ?
    order by updated_at desc, rowid desc
    limit 1
  `).get(scope.userId, scope.fridgeId, scope.imageId) as { id: string } | undefined);

  return existing ? loadChat(existing.id, scope) : createChat(scope);
}

export function getChat(id: string, scope: ChatScope): PersistedChat {
  validateScope(scope);
  return loadChat(id, scope);
}

export function startChatTurn(input: ChatScope & {
  threadId: string;
  userMessage: ChatMessageInput;
  assistantMessage: ChatMessageInput;
}) {
  validateScope(input);

  if (input.userMessage.role !== "user") {
    throw new Error("A chat turn must start with a user message");
  }
  if (input.assistantMessage.role !== "assistant") {
    throw new Error("A chat turn must include an assistant message");
  }
  if (typeof input.userMessage.payload.text !== "string" || !input.userMessage.payload.text.trim()) {
    throw new Error("A chat user message must include text");
  }
  if (typeof input.assistantMessage.payload.text !== "string") {
    throw new Error("A chat assistant message must include text");
  }

  withDatabase((_, sqlite) => {
    const transaction = sqlite.transaction(() => {
      const thread = sqlite.prepare(`
        select id from fridge_chat_threads
        where id = ? and user_id = ? and fridge_id = ? and image_id is ?
      `).get(input.threadId, input.userId, input.fridgeId, input.imageId);

      if (!thread) {
        throw new Error(`Chat thread ${input.threadId} was not found for this fridge`);
      }

      const now = new Date().toISOString();
      sqlite.prepare(`
        insert into fridge_chat_messages (id, thread_id, role, payload_json, status, created_at, updated_at)
        values (?, ?, ?, ?, 'idle', ?, ?)
      `).run(input.userMessage.id, input.threadId, input.userMessage.role, JSON.stringify(input.userMessage.payload), now, now);
      sqlite.prepare(`
        insert into fridge_chat_messages (id, thread_id, role, payload_json, status, created_at, updated_at)
        values (?, ?, ?, ?, 'running', ?, ?)
      `).run(input.assistantMessage.id, input.threadId, input.assistantMessage.role, JSON.stringify(input.assistantMessage.payload), now, now);
      sqlite.prepare(`
        update fridge_chat_threads
        set execution_status = 'running', updated_at = ?
        where id = ?
      `).run(now, input.threadId);
    });

    transaction();
  });
}

export function updateChatAssistantMessage(input: ChatScope & {
  threadId: string;
  assistantMessageId: string;
  payload: Record<string, unknown>;
  status: ChatExecutionStatus;
}) {
  validateScope(input);

  if (typeof input.payload.text !== "string") {
    throw new Error("A chat assistant message must include text");
  }

  withDatabase((_, sqlite) => {
    const transaction = sqlite.transaction(() => {
      const now = new Date().toISOString();
      const result = sqlite.prepare(`
        update fridge_chat_messages
        set payload_json = ?, status = ?, updated_at = ?
        where id = ? and thread_id = ? and role = 'assistant'
      `).run(JSON.stringify(input.payload), input.status, now, input.assistantMessageId, input.threadId);

      if (result.changes !== 1) {
        throw new Error(`Assistant chat message ${input.assistantMessageId} was not found in thread ${input.threadId}`);
      }

      const thread = sqlite.prepare(`
        update fridge_chat_threads
        set execution_status = ?, updated_at = ?
        where id = ? and user_id = ? and fridge_id = ? and image_id is ?
      `).run(input.status, now, input.threadId, input.userId, input.fridgeId, input.imageId);

      if (thread.changes !== 1) {
        throw new Error(`Chat thread ${input.threadId} was not found for this fridge`);
      }
    });

    transaction();
  });
}

export function resumeChatExecution(input: ChatScope & { threadId: string }) {
  const chat = getChat(input.threadId, input);
  const assistantMessage = [...chat.messages].reverse().find((message) =>
    message.role === "assistant" && (message.status === "running" || message.status === "interrupted")
  );

  if (!assistantMessage) {
    throw new Error(`Chat thread ${input.threadId} has no resumable assistant response`);
  }

  updateChatAssistantMessage({
    ...input,
    assistantMessageId: assistantMessage.id,
    payload: assistantMessage.payload,
    status: "running",
  });

  return assistantMessage.id;
}
