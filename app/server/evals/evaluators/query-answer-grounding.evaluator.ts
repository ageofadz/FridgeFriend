import { z } from "zod";

import type { FridgeFriendChatModel } from "../../ai/chat-model.server";
import type { EvalPromptBundle } from "../../prompts/registry.server";
import { createQueryModel } from "../../query/services/query-model.server";
import type { EvalFeedback, EvalResult } from "../schemas/eval-result";
import type { QueryEvalCase } from "../schemas/query-eval-case";

import { feedback, passFail, readQueryOutput } from "./shared";

export const ANSWER_GROUNDEDNESS_KEY = "answer_groundedness";
export const ANSWER_GROUNDEDNESS_PASS_KEY = "answer_groundedness_pass";
export const DEFAULT_GROUNDEDNESS_THRESHOLD = 0.8;

const GroundednessJudgeSchema = z.object({
  groundednessScore: z.number().min(0).max(1),
  unsupportedClaims: z.array(z.string()),
  missingRequiredClaims: z.array(z.string()),
  criticalUnsupportedClaim: z.boolean(),
  reasoning: z.string(),
});

// Facts the judge may treat as supported: everything the graph could have
// legitimately drawn from the case fixtures.
export function permittedFactsFor(caseData: QueryEvalCase): string[] {
  const fixtures = caseData.fixtures;
  return [
    ...(fixtures.inventory?.items ?? []).map((item) => `Inventory item: ${item.name}`),
    ...fixtures.memories.map((memory) => `Memory (${memory.kind}): ${JSON.stringify(memory.value)}`),
    ...fixtures.knowledgeDocuments.map((document) => `Knowledge — ${document.title}: ${document.content}`),
    ...fixtures.recipes.map((recipe) => `Recipe: ${recipe.name}`),
  ];
}

export async function evaluateQueryAnswerGrounding(input: {
  caseData: QueryEvalCase;
  result: EvalResult;
  promptBundle: EvalPromptBundle;
  model?: FridgeFriendChatModel;
  threshold?: number;
}): Promise<EvalFeedback[]> {
  const threshold = input.threshold ?? DEFAULT_GROUNDEDNESS_THRESHOLD;

  // Never spend judge calls on runs that did not complete.
  if (input.result.status !== "completed") {
    const comment = `Judge skipped: run status is ${input.result.status}, not completed.`;
    return [
      feedback(ANSWER_GROUNDEDNESS_KEY, 0, comment),
      feedback(ANSWER_GROUNDEDNESS_PASS_KEY, 0, comment),
    ];
  }

  const output = readQueryOutput(input.result);
  const expected = input.caseData.expected;
  const loadedPrompt = input.promptBundle.evalQueryAnswerGroundedness;
  const promptValue = await loadedPrompt.prompt.invoke({
    eval_query_answer_context_json: JSON.stringify({
      query: input.caseData.input.query,
      permittedFacts: permittedFactsFor(input.caseData),
      requiredFacts: expected.requiredFacts,
      prohibitedClaims: expected.prohibitedClaims,
      actualAnswer: output.answer ?? "",
    }),
  });
  const model = input.model ?? createQueryModel(false);
  const raw = await model
    .withStructuredOutput(GroundednessJudgeSchema, { name: "EvalQueryAnswerGroundedness" })
    .invoke(promptValue, {
      tags: ["eval", "query", "judge"],
      metadata: {
        caseId: input.caseData.caseId,
        langsmithPromptName: loadedPrompt.name,
        langsmithPromptRef: loadedPrompt.ref,
      },
    });
  const judged = GroundednessJudgeSchema.parse(raw);

  // Pass is computed in code, never trusted from the judge.
  const pass = !judged.criticalUnsupportedClaim &&
    judged.unsupportedClaims.length === 0 &&
    judged.groundednessScore >= threshold;
  const detail = `${pass ? "PASS" : "FAIL"} (score ${judged.groundednessScore.toFixed(3)}, threshold ${threshold.toFixed(2)}). ${judged.reasoning} Unsupported claims: ${judged.unsupportedClaims.join(", ") || "none"}. Missing required claims: ${judged.missingRequiredClaims.join(", ") || "none"}. Critical unsupported claim: ${String(judged.criticalUnsupportedClaim)}.`;

  return [
    feedback(ANSWER_GROUNDEDNESS_KEY, judged.groundednessScore, detail),
    passFail(ANSWER_GROUNDEDNESS_PASS_KEY, pass, detail),
  ];
}
