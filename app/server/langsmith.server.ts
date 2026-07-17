const REQUIRED_LANGSMITH_KEYS = ["LANGSMITH_ENDPOINT", "LANGSMITH_API_KEY", "LANGSMITH_PROJECT"] as const;

type LangSmithConfig = {
  apiKey: string;
  endpoint: string;
  project: string;
};

export function getLangSmithConfig() {
  const values = Object.fromEntries(
    REQUIRED_LANGSMITH_KEYS.map((key) => [key, process.env[key]?.trim() ?? ""]),
  ) as Record<(typeof REQUIRED_LANGSMITH_KEYS)[number], string>;
  const supplied = REQUIRED_LANGSMITH_KEYS.filter((key) => values[key].length > 0);

  if (supplied.length === 0) {
    return null;
  }

  const missing = REQUIRED_LANGSMITH_KEYS.filter((key) => values[key].length === 0);

  if (missing.length > 0) {
    throw new Error(
      `LangSmith configuration is incomplete: ${missing.join(", ")} must be set when using ${supplied.join(", ")}`,
    );
  }

  return {
    apiKey: values.LANGSMITH_API_KEY,
    endpoint: values.LANGSMITH_ENDPOINT,
    project: values.LANGSMITH_PROJECT,
  } satisfies LangSmithConfig;
}

export function ensureLangSmithTracingEnv() {
  let config: LangSmithConfig | null;

  try {
    config = getLangSmithConfig();
  } catch {
    // Incomplete configuration is surfaced to callers of getLangSmithConfig.
    return;
  }

  if (config && !process.env.LANGSMITH_TRACING?.trim()) {
    process.env.LANGSMITH_TRACING = "true";
  }
}

ensureLangSmithTracingEnv();
