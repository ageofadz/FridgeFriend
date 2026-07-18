import type { EvalFeedback, EvalResult } from "../schemas/eval-result";
import type { QueryEvalCase } from "../schemas/query-eval-case";
import type { ScanEvalCase } from "../schemas/scan-eval-case";

import { evaluateExecution } from "./execution.evaluator";
import { evaluateQueryActionGrounding } from "./query-action-grounding.evaluator";
import { evaluateQueryRoute } from "./query-route.evaluator";
import { evaluateQuerySafety } from "./query-safety.evaluator";
import { evaluateScanContract } from "./scan-contract.evaluator";
import { evaluateScanDetection } from "./scan-detection.evaluator";

export type QueryEvaluator = (input: {
  caseData: QueryEvalCase;
  result: EvalResult;
}) => EvalFeedback[];

export type ScanEvaluator = (input: {
  caseData: ScanEvalCase;
  result: EvalResult;
}) => EvalFeedback[];

export const deterministicQueryEvaluators: QueryEvaluator[] = [
  evaluateExecution,
  evaluateQueryRoute,
  evaluateQueryActionGrounding,
  evaluateQuerySafety,
];

export const deterministicScanEvaluators: ScanEvaluator[] = [
  evaluateExecution,
  evaluateScanContract,
  evaluateScanDetection,
];

export * from "./execution.evaluator";
export * from "./query-route.evaluator";
export * from "./query-action-grounding.evaluator";
export * from "./query-safety.evaluator";
export * from "./scan-contract.evaluator";
export * from "./scan-detection.evaluator";
export * from "./query-answer-grounding.evaluator";
