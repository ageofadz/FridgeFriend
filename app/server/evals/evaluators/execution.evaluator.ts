import type { EvalFeedback, EvalResult } from "../schemas/eval-result";
import type { QueryEvalCase } from "../schemas/query-eval-case";
import type { ScanEvalCase } from "../schemas/scan-eval-case";

import { feedback, passFail } from "./shared";

export const EXECUTION_SUCCESS_KEY = "execution_success";
export const CASE_VALID_KEY = "case_valid";
export const REPLAY_CONSUMED_EXACTLY_KEY = "replay_consumed_exactly";

export function evaluateExecution(input: {
  caseData: QueryEvalCase | ScanEvalCase;
  result: EvalResult;
}): EvalFeedback[] {
  const { caseData, result } = input;
  const expected = caseData.expected as { expectedInterrupt?: boolean };
  const hasResume = "resume" in caseData && caseData.resume !== undefined;
  // A run that ends interrupted is a success when the case expects an
  // interrupt and provides no resume payload (the interrupt IS the outcome).
  const interruptedAsExpected = result.status === "interrupted" &&
    expected.expectedInterrupt === true &&
    !hasResume;
  const executionSucceeded = result.status === "completed" || interruptedAsExpected;

  const replayFeedback = result.replay === null
    ? feedback(
      REPLAY_CONSUMED_EXACTLY_KEY,
      1,
      `Not applicable: no replay consumption report (mode ${result.mode}).`,
    )
    : passFail(
      REPLAY_CONSUMED_EXACTLY_KEY,
      result.replay.consumedExactly,
      result.replay.consumedExactly
        ? `All ${result.replay.consumedCallIds.length} replay steps consumed exactly.`
        : `Replay steps not consumed exactly; unused call ids: ${result.replay.unusedCallIds.join(", ") || "none"}.`,
    );

  return [
    passFail(
      EXECUTION_SUCCESS_KEY,
      executionSucceeded,
      executionSucceeded
        ? `Run finished with status ${result.status}${interruptedAsExpected ? " (expected interrupt without resume)" : ""}.`
        : `Run finished with status ${result.status}${result.error ? `; error [${result.error.errorKind}@${result.error.node}]: ${result.error.message}` : ""}.`,
    ),
    passFail(
      CASE_VALID_KEY,
      result.status !== "invalid_case",
      result.status !== "invalid_case"
        ? "Case fixtures and input were accepted."
        : `Case rejected as invalid${result.error ? `: ${result.error.message}` : ""}.`,
    ),
    replayFeedback,
  ];
}
