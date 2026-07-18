import { describe, expect, it } from "vitest";

import {
  CASE_VALID_KEY,
  EXECUTION_SUCCESS_KEY,
  REPLAY_CONSUMED_EXACTLY_KEY,
  evaluateExecution,
} from "../../../../../app/server/evals/evaluators/execution.evaluator";

import { evalResult, feedbackByKey, queryCase } from "./helpers";

describe("evaluateExecution", () => {
  it("passes all keys for a completed run with exact replay consumption", () => {
    const feedback = feedbackByKey(evaluateExecution({
      caseData: queryCase(),
      result: evalResult({
        status: "completed",
        replay: { consumedCallIds: ["intent-1"], unusedCallIds: [], consumedExactly: true },
      }),
    }));

    expect(feedback.get(EXECUTION_SUCCESS_KEY)?.score).toBe(1);
    expect(feedback.get(CASE_VALID_KEY)?.score).toBe(1);
    expect(feedback.get(REPLAY_CONSUMED_EXACTLY_KEY)?.score).toBe(1);
  });

  it("fails execution_success for a failed run and includes the error", () => {
    const feedback = feedbackByKey(evaluateExecution({
      caseData: queryCase(),
      result: evalResult({
        status: "failed",
        error: { errorKind: "runtime", node: "respond", message: "boom" },
      }),
    }));

    expect(feedback.get(EXECUTION_SUCCESS_KEY)?.score).toBe(0);
    expect(feedback.get(EXECUTION_SUCCESS_KEY)?.comment).toContain("boom");
    expect(feedback.get(CASE_VALID_KEY)?.score).toBe(1);
  });

  it("treats an interrupted run as success when the case expects an interrupt without resume", () => {
    const feedback = feedbackByKey(evaluateExecution({
      caseData: queryCase({ expected: { expectedInterrupt: true } }),
      result: evalResult({ status: "interrupted" }),
    }));

    expect(feedback.get(EXECUTION_SUCCESS_KEY)?.score).toBe(1);
  });

  it("fails an interrupted run when the case provides a resume payload", () => {
    const feedback = feedbackByKey(evaluateExecution({
      caseData: queryCase({
        expected: { expectedInterrupt: true },
        resume: { inventoryMutationReview: { approved: true } },
      }),
      result: evalResult({ status: "interrupted" }),
    }));

    expect(feedback.get(EXECUTION_SUCCESS_KEY)?.score).toBe(0);
  });

  it("fails case_valid for invalid_case runs", () => {
    const feedback = feedbackByKey(evaluateExecution({
      caseData: queryCase(),
      result: evalResult({
        status: "invalid_case",
        error: { errorKind: "fixture", node: "load_context", message: "missing fixture" },
      }),
    }));

    expect(feedback.get(CASE_VALID_KEY)?.score).toBe(0);
    expect(feedback.get(EXECUTION_SUCCESS_KEY)?.score).toBe(0);
  });

  it("fails replay_consumed_exactly and names unused call ids", () => {
    const feedback = feedbackByKey(evaluateExecution({
      caseData: queryCase(),
      result: evalResult({
        replay: { consumedCallIds: ["a"], unusedCallIds: ["response-1"], consumedExactly: false },
      }),
    }));

    expect(feedback.get(REPLAY_CONSUMED_EXACTLY_KEY)?.score).toBe(0);
    expect(feedback.get(REPLAY_CONSUMED_EXACTLY_KEY)?.comment).toContain("response-1");
  });

  it("scores replay_consumed_exactly 1 with a not-applicable comment in live mode", () => {
    const feedback = feedbackByKey(evaluateExecution({
      caseData: queryCase(),
      result: evalResult({ mode: "live", replay: null }),
    }));

    expect(feedback.get(REPLAY_CONSUMED_EXACTLY_KEY)?.score).toBe(1);
    expect(feedback.get(REPLAY_CONSUMED_EXACTLY_KEY)?.comment).toContain("Not applicable");
  });
});
