import { config } from "dotenv";
import { Client } from "langsmith";
import { evaluate } from "langsmith/evaluation";

import { streamQueryForFridgeImage } from "../app/server/query/graph.server";
import { createQueryModel } from "../app/server/query/services/query-model.server";

config({ quiet: true });

const datasetName = "fridgefriend-recipe-tournament-rag-evals";
const fridgeId = requiredEnv("RAG_EVAL_FRIDGE_ID");
const imageId = requiredEnv("RAG_EVAL_IMAGE_ID");
const client = new Client({
  apiKey: requiredEnv("LANGSMITH_API_KEY"),
  apiUrl: requiredEnv("LANGSMITH_ENDPOINT"),
});

const judgeSchema = {
  type: "object",
  properties: {
    score: { type: "number" },
    reason: { type: "string" },
  },
  required: ["score", "reason"],
} as const;

function requiredEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

async function seedDataset() {
  if (await client.hasDataset({ datasetName })) return;
  const dataset = await client.createDataset(datasetName, {
    description: "Food.com tournament retrieval quality, faithfulness, and relevance evaluations",
  });
  await client.createExamples({
    datasetId: dataset.id,
    inputs: [
      { fridgeId, imageId, query: "Suggest a quick dinner from my available ingredients." },
      { fridgeId, imageId, query: "What is a high-protein meal I can make from my fridge?" },
      { fridgeId, imageId, query: "Give me a fast recipe that avoids ingredients I dislike." },
    ],
    outputs: [
      { expectedTopics: ["dinner"], expectedTags: [] },
      { expectedTopics: ["protein"], expectedTags: ["high protein"] },
      { expectedTopics: ["fast"], expectedTags: [] },
    ],
  });
}

async function target(input: { fridgeId: string; imageId: string; query: string }) {
  let final: { answer: string; recipes: Array<{ name: string; matchedTags: string[]; matchedIngredients: string[]; missingIngredients: string[]; tournamentPlacement?: string }> } | null = null;
  for await (const event of streamQueryForFridgeImage(input)) {
    if (event.type === "final") {
      final = { answer: event.answer, recipes: event.recipes };
    }
  }
  if (!final) throw new Error("Recipe RAG evaluation graph completed without a final response");
  return final;
}

async function judge(prompt: string) {
  const model = createQueryModel().withStructuredOutput(judgeSchema, { name: "FridgeRecipeRagEvaluationJudge" });
  const result = await model.invoke(prompt);
  if (
    typeof result !== "object" || result === null ||
    !("score" in result) || typeof result.score !== "number" || !Number.isFinite(result.score) ||
    !("reason" in result) || typeof result.reason !== "string"
  ) {
    throw new Error("Recipe RAG evaluation judge returned invalid output");
  }
  return { score: Math.max(0, Math.min(1, result.score)), reason: result.reason };
}

await seedDataset();

const results = await evaluate(target, {
  data: datasetName,
  client,
  experimentPrefix: "fridgefriend-recipe-tournament-rag",
  maxConcurrency: 3,
  evaluators: [
    ({ outputs, referenceOutputs }: EvaluationArgs) => {
      const expectedTags = Array.isArray(referenceOutputs?.expectedTags) ? referenceOutputs.expectedTags.filter((tag): tag is string => typeof tag === "string") : [];
      const expectedTopics = Array.isArray(referenceOutputs?.expectedTopics) ? referenceOutputs.expectedTopics.filter((topic): topic is string => typeof topic === "string") : [];
      const cards = recipeCards(outputs);
      const evidence = cards.flatMap((recipe) => [recipe.name, ...recipe.matchedTags]).join(" ").toLowerCase();
      const expected = [...expectedTags, ...expectedTopics];
      const score = expected.length === 0 ? Number(cards.length > 0) :
        expected.filter((term) => evidence.includes(term.toLowerCase())).length / expected.length;
      return { key: "retrieval_quality", score };
    },
    async ({ inputs, outputs }: EvaluationArgs) => {
      const result = await judge(`Rate 0 to 1 for faithfulness. Every answer claim must be supported by the supplied Food.com tournament cards. Question: ${String(inputs.query)}\nAnswer: ${String(outputs.answer)}\nCards: ${JSON.stringify(recipeCards(outputs))}`);
      return { key: "faithfulness", score: result.score, comment: result.reason };
    },
    async ({ inputs, outputs }: EvaluationArgs) => {
      const result = await judge(`Rate 0 to 1 for relevance. Does the answer and its Food.com tournament cards answer the question? Question: ${String(inputs.query)}\nAnswer: ${String(outputs.answer)}\nCards: ${JSON.stringify(recipeCards(outputs))}`);
      return { key: "answer_relevance", score: result.score, comment: result.reason };
    },
  ],
});

for await (const _result of results) {
  process.stdout.write(".");
}
process.stdout.write(`\nCompleted LangSmith experiment ${results.experimentName}\n`);

type EvaluationArgs = {
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown>;
  referenceOutputs?: Record<string, unknown>;
};

function recipeCards(outputs: Record<string, unknown>) {
  const recipes = outputs.recipes;
  if (!Array.isArray(recipes)) return [] as Array<{ name: string; matchedTags: string[] }>;
  return recipes.flatMap((recipe) =>
    typeof recipe === "object" && recipe !== null &&
    "name" in recipe && typeof recipe.name === "string" &&
    "matchedTags" in recipe && Array.isArray(recipe.matchedTags) &&
    recipe.matchedTags.every((tag: unknown) => typeof tag === "string")
      ? [{ name: recipe.name, matchedTags: recipe.matchedTags as string[] }]
      : [],
  );
}
