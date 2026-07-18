import { describe, expect, it } from "vitest";

import {
  FORBIDDEN_NODES_ABSENT_KEY,
  INTENT_CORRECT_KEY,
  REQUIRED_NODES_PRESENT_KEY,
  ROUTE_ORDER_CORRECT_KEY,
  TERMINAL_ROUTE_CORRECT_KEY,
  evaluateQueryRoute,
} from "../../../../../app/server/evals/evaluators/query-route.evaluator";

import { evalResult, feedbackByKey, queryCase, queryOutput, trajectoryOf } from "./helpers";

const route = ["load_context", "determine_intent", "query_inventory", "respond"];

describe("evaluateQueryRoute", () => {
  it("passes every key when the route satisfies all expectations", () => {
    const feedback = feedbackByKey(evaluateQueryRoute({
      caseData: queryCase({
        expected: {
          intent: "inventory",
          terminalRoute: "respond",
          requiredNodes: ["determine_intent", "query_inventory"],
          forbiddenNodes: ["plan_groceries"],
          orderedNodeGroups: [["determine_intent"], ["query_inventory", "respond"]],
        },
      }),
      result: evalResult({ trajectory: trajectoryOf(route) }),
    }));

    for (const key of [
      INTENT_CORRECT_KEY,
      TERMINAL_ROUTE_CORRECT_KEY,
      REQUIRED_NODES_PRESENT_KEY,
      FORBIDDEN_NODES_ABSENT_KEY,
      ROUTE_ORDER_CORRECT_KEY,
    ]) {
      expect(feedback.get(key)?.score, key).toBe(1);
    }
  });

  it("fails intent_correct on an intent mismatch", () => {
    const feedback = feedbackByKey(evaluateQueryRoute({
      caseData: queryCase({ expected: { intent: "recipe" } }),
      result: evalResult({ output: queryOutput({ intent: "inventory" }) }),
    }));

    expect(feedback.get(INTENT_CORRECT_KEY)?.score).toBe(0);
  });

  it("fails terminal_route_correct when the run ends elsewhere", () => {
    const feedback = feedbackByKey(evaluateQueryRoute({
      caseData: queryCase({ expected: { terminalRoute: "respond" } }),
      result: evalResult({ output: queryOutput({ terminalRoute: "review_interrupt" }) }),
    }));

    expect(feedback.get(TERMINAL_ROUTE_CORRECT_KEY)?.score).toBe(0);
  });

  it("fails required_nodes_present and names the missing node", () => {
    const feedback = feedbackByKey(evaluateQueryRoute({
      caseData: queryCase({ expected: { requiredNodes: ["plan_expiry"] } }),
      result: evalResult({ trajectory: trajectoryOf(route) }),
    }));

    expect(feedback.get(REQUIRED_NODES_PRESENT_KEY)?.score).toBe(0);
    expect(feedback.get(REQUIRED_NODES_PRESENT_KEY)?.comment).toContain("plan_expiry");
  });

  it("fails forbidden_nodes_absent when a forbidden node was visited", () => {
    const feedback = feedbackByKey(evaluateQueryRoute({
      caseData: queryCase({ expected: { forbiddenNodes: ["query_inventory"] } }),
      result: evalResult({ trajectory: trajectoryOf(route) }),
    }));

    expect(feedback.get(FORBIDDEN_NODES_ABSENT_KEY)?.score).toBe(0);
  });

  it("fails route_order_correct when groups appear out of order", () => {
    const feedback = feedbackByKey(evaluateQueryRoute({
      caseData: queryCase({
        expected: { orderedNodeGroups: [["respond"], ["determine_intent"]] },
      }),
      result: evalResult({ trajectory: trajectoryOf(route) }),
    }));

    expect(feedback.get(ROUTE_ORDER_CORRECT_KEY)?.score).toBe(0);
  });

  it("skips with a passing score when no expectations are declared", () => {
    const feedback = feedbackByKey(evaluateQueryRoute({
      caseData: queryCase(),
      result: evalResult({ trajectory: [] }),
    }));

    for (const entry of feedback.values()) {
      expect(entry.score).toBe(1);
      expect(entry.comment).toContain("Not asserted");
    }
  });
});
