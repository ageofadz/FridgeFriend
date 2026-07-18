import { describe, expect, it } from "vitest";

import type { FridgeFriendChatModel } from "../../../../../app/server/ai/chat-model.server";
import type { EvalPromptBundle } from "../../../../../app/server/prompts/registry.server";
import {
  ANSWER_GROUNDEDNESS_KEY,
  ANSWER_GROUNDEDNESS_PASS_KEY,
  DEFAULT_GROUNDEDNESS_THRESHOLD,
  evaluateQueryAnswerGrounding,
  permittedFactsFor,
} from "../../../../../app/server/evals/evaluators/query-answer-grounding.evaluator";

import { evalResult, feedbackByKey, queryCase, queryOutput } from "./helpers";

type JudgeResult = {
  groundednessScore: number;
  unsupportedClaims: string[];
  missingRequiredClaims: string[];
  criticalUnsupportedClaim: boolean;
  reasoning: string;
};

function judgeResult(overrides: Partial<JudgeResult> = {}): JudgeResult {
  return {
    groundednessScore: 0.95,
    unsupportedClaims: [],
    missingRequiredClaims: [],
    criticalUnsupportedClaim: false,
    reasoning: "Answer sticks to fixture inventory.",
    ...overrides,
  };
}

function fakeBundle(capture: { vars?: Record<string, string> }) {
  return {
    evalQueryAnswerGroundedness: {
      name: "fridgefriend-eval-query-answer-groundedness",
      ref: "fridgefriend-eval-query-answer-groundedness:test",
      prompt: {
        invoke: async (vars: Record<string, string>) => {
          capture.vars = vars;
          return "prompt-value";
        },
      },
    },
  } as unknown as EvalPromptBundle;
}

function fakeModel(result: JudgeResult, calls: { count: number }) {
  return {
    withStructuredOutput: () => ({
      invoke: async () => {
        calls.count += 1;
        return result;
      },
    }),
  } as unknown as FridgeFriendChatModel;
}

const caseData = queryCase({
  fixtures: {
    inventory: { items: [{ id: "item-milk", name: "milk" }] },
    memories: [{ kind: "dietary_preference", value: { preference: "low sugar" } }],
    recipes: [{ id: "recipe-1", name: "Milk toast" }],
    knowledgeDocuments: [{ id: "doc-1", title: "Milk storage", content: "Keep milk cold." }],
  },
  expected: { requiredFacts: ["milk"], prohibitedClaims: ["you have cheese"] },
});

describe("evaluateQueryAnswerGrounding", () => {
  it("passes and carries the judge score, reasoning, and prompt inputs", async () => {
    const capture: { vars?: Record<string, string> } = {};
    const calls = { count: 0 };
    const feedback = feedbackByKey(await evaluateQueryAnswerGrounding({
      caseData,
      result: evalResult(),
      promptBundle: fakeBundle(capture),
      model: fakeModel(judgeResult(), calls),
    }));

    expect(calls.count).toBe(1);
    expect(feedback.get(ANSWER_GROUNDEDNESS_KEY)?.score).toBeCloseTo(0.95, 10);
    expect(feedback.get(ANSWER_GROUNDEDNESS_KEY)?.comment).toContain("Answer sticks to fixture inventory.");
    expect(feedback.get(ANSWER_GROUNDEDNESS_PASS_KEY)?.score).toBe(1);

    const context = JSON.parse(capture.vars?.eval_query_answer_context_json ?? "{}");
    expect(context.query).toBe("what is in my fridge");
    expect(context.actualAnswer).toBe("You have milk.");
    expect(context.requiredFacts).toEqual(["milk"]);
    expect(context.prohibitedClaims).toEqual(["you have cheese"]);
    expect(context.permittedFacts).toEqual(permittedFactsFor(caseData));
    expect(context.permittedFacts.join(" ")).toContain("milk");
  });

  it("computes pass in code: exactly at threshold passes, just below fails", async () => {
    const atThreshold = feedbackByKey(await evaluateQueryAnswerGrounding({
      caseData,
      result: evalResult(),
      promptBundle: fakeBundle({}),
      model: fakeModel(judgeResult({ groundednessScore: DEFAULT_GROUNDEDNESS_THRESHOLD }), { count: 0 }),
    }));
    expect(atThreshold.get(ANSWER_GROUNDEDNESS_PASS_KEY)?.score).toBe(1);

    const belowThreshold = feedbackByKey(await evaluateQueryAnswerGrounding({
      caseData,
      result: evalResult(),
      promptBundle: fakeBundle({}),
      model: fakeModel(judgeResult({ groundednessScore: 0.79 }), { count: 0 }),
    }));
    expect(belowThreshold.get(ANSWER_GROUNDEDNESS_PASS_KEY)?.score).toBe(0);
    expect(belowThreshold.get(ANSWER_GROUNDEDNESS_KEY)?.score).toBeCloseTo(0.79, 10);
  });

  it("fails on unsupported claims or a critical unsupported claim regardless of score", async () => {
    const unsupported = feedbackByKey(await evaluateQueryAnswerGrounding({
      caseData,
      result: evalResult(),
      promptBundle: fakeBundle({}),
      model: fakeModel(judgeResult({ unsupportedClaims: ["you have cheese"] }), { count: 0 }),
    }));
    expect(unsupported.get(ANSWER_GROUNDEDNESS_PASS_KEY)?.score).toBe(0);
    expect(unsupported.get(ANSWER_GROUNDEDNESS_KEY)?.comment).toContain("you have cheese");

    const critical = feedbackByKey(await evaluateQueryAnswerGrounding({
      caseData,
      result: evalResult(),
      promptBundle: fakeBundle({}),
      model: fakeModel(judgeResult({ groundednessScore: 1, criticalUnsupportedClaim: true }), { count: 0 }),
    }));
    expect(critical.get(ANSWER_GROUNDEDNESS_PASS_KEY)?.score).toBe(0);
  });

  it("honors a custom threshold", async () => {
    const feedback = feedbackByKey(await evaluateQueryAnswerGrounding({
      caseData,
      result: evalResult(),
      promptBundle: fakeBundle({}),
      model: fakeModel(judgeResult({ groundednessScore: 0.85 }), { count: 0 }),
      threshold: 0.9,
    }));

    expect(feedback.get(ANSWER_GROUNDEDNESS_PASS_KEY)?.score).toBe(0);
  });

  it("never calls the judge when the run did not complete", async () => {
    const calls = { count: 0 };
    const feedback = feedbackByKey(await evaluateQueryAnswerGrounding({
      caseData,
      result: evalResult({ status: "interrupted", output: queryOutput({ interrupted: true }) }),
      promptBundle: fakeBundle({}),
      model: fakeModel(judgeResult(), calls),
    }));

    expect(calls.count).toBe(0);
    expect(feedback.get(ANSWER_GROUNDEDNESS_KEY)?.score).toBe(0);
    expect(feedback.get(ANSWER_GROUNDEDNESS_PASS_KEY)?.score).toBe(0);
    expect(feedback.get(ANSWER_GROUNDEDNESS_KEY)?.comment).toContain("interrupted");
  });
});
