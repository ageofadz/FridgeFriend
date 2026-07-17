import { requiredEnv } from "./env.server";

const REQUIRED_LANGSMITH_KEYS = [
  "LANGSMITH_API_KEY",
  "LANGSMITH_TRACING",
  "LANGSMITH_PROJECT",
  "LANGSMITH_PROMPT_ENVIRONMENT",
  "LANGSMITH_ENDPOINT",
] as const;

export function getLangSmithConfig() {
  return {
    apiKey: requiredEnv(REQUIRED_LANGSMITH_KEYS[0]),
    tracing: requiredEnv(REQUIRED_LANGSMITH_KEYS[1]),
    project: requiredEnv(REQUIRED_LANGSMITH_KEYS[2]),
    promptEnvironment: requiredEnv(REQUIRED_LANGSMITH_KEYS[3]),
    endpoint: requiredEnv(REQUIRED_LANGSMITH_KEYS[4]),
  };
}

export function assertLangSmithTracingEnabled() {
  const config = getLangSmithConfig();

  if (config.tracing !== "true") {
    throw new Error(
      `LANGSMITH_TRACING must be true to trace scan graph runs; received ${config.tracing}`,
    );
  }

  return config;
}
