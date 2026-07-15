import { mkdirSync } from "node:fs";
import { spawn } from "node:child_process";

import { config } from "dotenv";

config({ quiet: true });

const chromaPath = process.env.CHROMA_PATH || ".data/chroma";
const host = process.env.CHROMA_HOST || "127.0.0.1";
const port = process.env.CHROMA_PORT || "8000";

mkdirSync(chromaPath, { recursive: true });

const chroma = spawn(
  "chroma",
  ["run", "--path", chromaPath, "--host", host, "--port", port],
  {
    stdio: "inherit",
    shell: false,
  },
);

chroma.on("error", (error) => {
  console.error(`Failed to start Chroma at ${chromaPath}: ${error.message}`);
  process.exit(1);
});

chroma.on("exit", (code, signal) => {
  if (signal) {
    process.exit(128);
  }
  process.exit(code ?? 1);
});
