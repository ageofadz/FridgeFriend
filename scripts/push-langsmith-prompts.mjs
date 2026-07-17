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

for (const promptDefinition of prompts) {
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
