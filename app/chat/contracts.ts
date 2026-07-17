export const INITIAL_CHAT_ASSISTANT_TEXT = "What would you like to know about your fridge? I can look for recipes you can make from these items, suggest ingredients, and more.";

export type ChatExecutionStatus = "idle" | "running" | "interrupted";

export type PersistedChatMessage = {
  id: string;
  role: "user" | "assistant";
  payload: Record<string, unknown>;
  status: ChatExecutionStatus;
  createdAt: string;
  updatedAt: string;
};

export type PersistedChat = {
  id: string;
  userId: string;
  fridgeId: string;
  imageId: string | null;
  executionStatus: ChatExecutionStatus;
  createdAt: string;
  updatedAt: string;
  messages: PersistedChatMessage[];
};
