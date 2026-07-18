import type { EvalFeedback, EvalResult } from "../schemas/eval-result";
import type { QueryEvalCase } from "../schemas/query-eval-case";
import { hasOrderedNodeGroups, trajectoryNodeNames } from "../schemas/trajectory";

import { feedback, passFail, readQueryOutput } from "./shared";

export const INTENT_CORRECT_KEY = "intent_correct";
export const TERMINAL_ROUTE_CORRECT_KEY = "terminal_route_correct";
export const REQUIRED_NODES_PRESENT_KEY = "required_nodes_present";
export const FORBIDDEN_NODES_ABSENT_KEY = "forbidden_nodes_absent";
export const ROUTE_ORDER_CORRECT_KEY = "route_order_correct";

function notAsserted(key: string, field: string): EvalFeedback {
  return feedback(key, 1, `Not asserted: case declares no ${field} expectation.`);
}

export function evaluateQueryRoute(input: {
  caseData: QueryEvalCase;
  result: EvalResult;
}): EvalFeedback[] {
  const expected = input.caseData.expected;
  const output = readQueryOutput(input.result);
  const nodes = trajectoryNodeNames(input.result.trajectory);
  const route = nodes.join(" -> ") || "none";

  const intentFeedback = expected.intent === undefined
    ? notAsserted(INTENT_CORRECT_KEY, "intent")
    : passFail(
      INTENT_CORRECT_KEY,
      output.intent === expected.intent,
      `Expected intent ${expected.intent}; received ${String(output.intent)}.`,
    );

  const terminalFeedback = expected.terminalRoute === undefined
    ? notAsserted(TERMINAL_ROUTE_CORRECT_KEY, "terminal route")
    : passFail(
      TERMINAL_ROUTE_CORRECT_KEY,
      output.terminalRoute === expected.terminalRoute,
      `Expected terminal route ${expected.terminalRoute}; received ${output.terminalRoute || "none"}.`,
    );

  const requiredFeedback = expected.requiredNodes.length === 0
    ? notAsserted(REQUIRED_NODES_PRESENT_KEY, "required-node")
    : passFail(
      REQUIRED_NODES_PRESENT_KEY,
      expected.requiredNodes.every((node) => nodes.includes(node)),
      `Required nodes: ${expected.requiredNodes.join(", ")}; missing: ${expected.requiredNodes.filter((node) => !nodes.includes(node)).join(", ") || "none"}; route: ${route}.`,
    );

  const forbiddenFeedback = expected.forbiddenNodes.length === 0
    ? notAsserted(FORBIDDEN_NODES_ABSENT_KEY, "forbidden-node")
    : passFail(
      FORBIDDEN_NODES_ABSENT_KEY,
      expected.forbiddenNodes.every((node) => !nodes.includes(node)),
      `Forbidden nodes: ${expected.forbiddenNodes.join(", ")}; visited: ${expected.forbiddenNodes.filter((node) => nodes.includes(node)).join(", ") || "none"}; route: ${route}.`,
    );

  const orderFeedback = expected.orderedNodeGroups.length === 0
    ? notAsserted(ROUTE_ORDER_CORRECT_KEY, "ordered-node-group")
    : passFail(
      ROUTE_ORDER_CORRECT_KEY,
      hasOrderedNodeGroups(nodes, expected.orderedNodeGroups),
      `Ordered groups: ${expected.orderedNodeGroups.map((group) => `[${group.join(", ")}]`).join(" -> ")}; route: ${route}.`,
    );

  return [intentFeedback, terminalFeedback, requiredFeedback, forbiddenFeedback, orderFeedback];
}
