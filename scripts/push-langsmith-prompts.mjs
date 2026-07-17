import { readFile } from "node:fs/promises";

import { ChatPromptTemplate } from "@langchain/core/prompts";
import { config } from "dotenv";
import { Client } from "langsmith";

config({ quiet: true });

const prompts = JSON.parse(
  await readFile(
    new URL("../app/server/prompts/prompts.json", import.meta.url),
    "utf8",
  ),
);
const [option, promptName] = process.argv.slice(2);

if (option !== undefined && option !== "--name") {
  throw new Error(`Unknown option: ${option}`);
}

if (option === "--name" && !promptName) {
  throw new Error("Missing prompt name after --name");
}

if (process.argv.length > 4) {
  throw new Error("Only one prompt name may be provided");
}

const promptsToPush = promptName
  ? prompts.filter((prompt) => prompt.name === promptName)
  : prompts;

if (promptName && promptsToPush.length === 0) {
  throw new Error(`Unknown prompt name: ${promptName}`);
}

const client = new Client({
  apiKey: requiredEnv("LANGSMITH_API_KEY"),
  apiUrl: requiredEnv("LANGSMITH_ENDPOINT"),
});

function requiredEnv(name) {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function isUnchanged(error) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("Nothing to commit") ||
    message.includes("already exists on commit")
  );
}

for (const promptDefinition of promptsToPush) {
  const promptId = `fridgefriend-${promptDefinition.name}`;
  const prompt = ChatPromptTemplate.fromMessages(
    promptDefinition.messages,
    { templateFormat: promptDefinition.templateFormat },
  );

  try {
    const url = await client.pushPrompt(promptId, {
      object: prompt,
      description: promptDefinition.description,
      isPublic: false,
    });

    process.stdout.write(`${promptId}: pushed ${url}\n`);
  } catch (error) {
    if (!isUnchanged(error)) {
      throw error;
    }

    process.stdout.write(`${promptId}: unchanged\n`);
  }
}
