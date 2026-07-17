import { spawn } from "node:child_process";

const langSmithKeys = ["LANGSMITH_ENDPOINT", "LANGSMITH_API_KEY", "LANGSMITH_PROJECT"];
const configuredKeys = langSmithKeys.filter((key) => process.env[key]?.trim());

if (configuredKeys.length > 0 && configuredKeys.length < langSmithKeys.length) {
  const missingKeys = langSmithKeys.filter((key) => !process.env[key]?.trim());
  console.error(`LangSmith configuration is incomplete: ${missingKeys.join(", ")} must be set when using ${configuredKeys.join(", ")}`);
  process.exit(1);
}

if (configuredKeys.length === langSmithKeys.length) {
  process.env.LANGSMITH_TRACING = "true";
} else {
  delete process.env.LANGSMITH_TRACING;
}

const [command, ...args] = process.argv.slice(2);

if (!command) {
  console.error("Container command was missing");
  process.exit(1);
}

const child = spawn(command, args, {
  env: process.env,
  stdio: "inherit",
});

child.on("error", (error) => {
  console.error(`Container command ${command} failed to start: ${error.message}`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  process.exit(signal ? 128 : code ?? 1);
});
