import { config } from "dotenv";
import { Client } from "langsmith";
import { evaluate } from "langsmith/evaluation";

import { streamQueryForFridgeImage } from "../app/server/query/graph.server";
import { createQueryModel } from "../app/server/query/services/query-model.server";

config({ quiet: true });

const datasetName = "fridgefriend-recipe-provenance-rag-evals-v3";
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
    description: "Recipe retrieval provenance, faithfulness, and relevance evaluations",
  });
  await client.createExamples({
    datasetId: dataset.id,
    inputs: [
      { fridgeId, imageId, query: "What can I make from the ingredients in my fridge?" },
      { fridgeId, imageId, query: "Suggest a quick dinner from my available ingredients." },
      { fridgeId, imageId, query: "I prefer spicy food. What can I make from my fridge?" },
      { fridgeId, imageId, query: "Give me a dairy-free recipe that takes no more than 30 minutes." },
    ],
    outputs: [
      { requireTournamentCandidates: true },
      { requireTournamentCandidates: true },
      { requireTournamentCandidates: true },
      { requireTournamentCandidates: true },
    ],
  });
}

async function target(input: { fridgeId: string; imageId: string; query: string }) {
  let final: {
    answer: string;
    recipes: Array<{ name: string; matchedTags: string[]; matchedIngredients: string[]; missingIngredients: string[] }>;
    retrievalAudit?: Record<string, unknown>;
  } | null = null;
  for await (const event of streamQueryForFridgeImage(input)) {
    if (event.type === "final") {
      final = { answer: event.answer, recipes: event.recipes, retrievalAudit: event.retrievalAudit };
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
      const audit = recipeRetrievalAudit(outputs);
      const requireTournamentCandidates = referenceOutputs?.requireTournamentCandidates === true;
      const score = audit &&
        audit.vectorCandidates > 0 &&
        audit.deduplicatedCandidateIds > 0 &&
        audit.canonicalHydrationCount > 0 &&
        (!requireTournamentCandidates || audit.tournamentCandidates > 0)
        ? 1
        : 0;
      return { key: "retrieval_provenance", score };
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

type EvaluatedRecipeCard = {
  name: string;
  matchedTags: string[];
};

function recipeCards(outputs: Record<string, unknown>): EvaluatedRecipeCard[] {
  const recipes = outputs.recipes;
  if (!Array.isArray(recipes)) return [];
  return recipes.flatMap((recipe) =>
    typeof recipe === "object" && recipe !== null &&
    "name" in recipe && typeof recipe.name === "string" &&
    "matchedTags" in recipe && Array.isArray(recipe.matchedTags) &&
    recipe.matchedTags.every((tag: unknown) => typeof tag === "string")
      ? [{
        name: recipe.name,
        matchedTags: recipe.matchedTags as string[],
      }]
      : [],
  );
}

function recipeRetrievalAudit(outputs: Record<string, unknown>) {
  const audit = outputs.retrievalAudit;
  if (typeof audit !== "object" || audit === null) return null;
  const values = audit as Record<string, unknown>;
  const fields = ["vectorCandidates", "deduplicatedCandidateIds", "canonicalHydrationCount", "tournamentCandidates"] as const;
  if (!fields.every((field) => typeof values[field] === "number" && Number.isFinite(values[field]))) return null;
  return {
    vectorCandidates: values.vectorCandidates as number,
    deduplicatedCandidateIds: values.deduplicatedCandidateIds as number,
    canonicalHydrationCount: values.canonicalHydrationCount as number,
    tournamentCandidates: values.tournamentCandidates as number,
  };
}
