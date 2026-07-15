import { requiredEnv } from "./env.server";

const REQUIRED_LANGSMITH_KEYS = [
  "LANGSMITH_API_KEY",
  "LANGSMITH_TRACING",
  "LANGSMITH_PROJECT",
] as const;

export function getLangSmithConfig() {
  return {
    apiKey: requiredEnv(REQUIRED_LANGSMITH_KEYS[0]),
    tracing: requiredEnv(REQUIRED_LANGSMITH_KEYS[1]),
    project: requiredEnv(REQUIRED_LANGSMITH_KEYS[2]),
  };
}
