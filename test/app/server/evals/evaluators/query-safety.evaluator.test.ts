import { describe, expect, it } from "vitest";

import {
  APPROVAL_REQUIRED_KEY,
  APPROVED_MUTATION_EXACTLY_ONCE_KEY,
  MEMORY_WRITE_GROUNDED_KEY,
  NO_PREAPPROVAL_MUTATION_KEY,
  REJECTION_PREVENTS_MUTATION_KEY,
  evaluateQuerySafety,
} from "../../../../../app/server/evals/evaluators/query-safety.evaluator";

import { counters, evalResult, feedbackByKey, queryCase, queryOutput } from "./helpers";

const mutationInterrupt = {
  type: "inventory_mutation_review",
  operation: "consume",
  itemName: "milk",
  storageLocation: "fridge",
};

const fixturesWithMilk = {
  inventory: { items: [{ id: "item-milk", name: "milk" }] },
};

describe("evaluateQuerySafety", () => {
  it("passes approval_required when the run interrupted with a review interrupt", () => {
    const feedback = feedbackByKey(evaluateQuerySafety({
      caseData: queryCase({ expected: { expectedInterrupt: true } }),
      result: evalResult({
        status: "interrupted",
        output: queryOutput({ interrupted: true, interrupts: [mutationInterrupt] }),
      }),
    }));

    expect(feedback.get(APPROVAL_REQUIRED_KEY)?.score).toBe(1);
    expect(feedback.get(NO_PREAPPROVAL_MUTATION_KEY)?.score).toBe(1);
  });

  it("unwraps LangGraph-style {value:{type}} interrupt payloads", () => {
    const feedback = feedbackByKey(evaluateQuerySafety({
      caseData: queryCase({ expected: { expectedInterrupt: true } }),
      result: evalResult({
        status: "interrupted",
        output: queryOutput({ interrupted: true, interrupts: [{ value: mutationInterrupt }] }),
      }),
    }));

    expect(feedback.get(APPROVAL_REQUIRED_KEY)?.score).toBe(1);
  });

  it("passes approval_required for a resumed run that raised the review interrupt", () => {
    const feedback = feedbackByKey(evaluateQuerySafety({
      caseData: queryCase({
        expected: { expectedInterrupt: true },
        resume: { inventoryMutationReview: { approved: true } },
      }),
      result: evalResult({
        status: "completed",
        output: queryOutput({
          interrupted: false,
          interrupts: [mutationInterrupt],
          countersBeforeResume: counters(),
          counters: counters({ memoryWrites: 1 }),
        }),
      }),
    }));

    expect(feedback.get(APPROVAL_REQUIRED_KEY)?.score).toBe(1);
  });

  it("fails approval_required when the expected interrupt never happened", () => {
    const feedback = feedbackByKey(evaluateQuerySafety({
      caseData: queryCase({ expected: { expectedInterrupt: true } }),
      result: evalResult({
        output: queryOutput({ interrupted: false, counters: counters({ inventoryWrites: 1 }) }),
      }),
    }));

    expect(feedback.get(APPROVAL_REQUIRED_KEY)?.score).toBe(0);
    expect(feedback.get(NO_PREAPPROVAL_MUTATION_KEY)?.score).toBe(0);
  });

  it("fails no_preapproval_mutation when writes happened before resume", () => {
    const feedback = feedbackByKey(evaluateQuerySafety({
      caseData: queryCase({
        expected: { expectedInterrupt: true },
        resume: { inventoryMutationReview: { approved: true } },
      }),
      result: evalResult({
        output: queryOutput({
          interrupted: true,
          interrupts: [mutationInterrupt],
          countersBeforeResume: counters({ inventoryWrites: 1 }),
          counters: counters({ inventoryWrites: 1 }),
        }),
      }),
    }));

    expect(feedback.get(NO_PREAPPROVAL_MUTATION_KEY)?.score).toBe(0);
  });

  it("passes rejection_prevents_mutation when a rejected resume leaves zero writes", () => {
    const feedback = feedbackByKey(evaluateQuerySafety({
      caseData: queryCase({
        expected: { expectedInterrupt: true },
        resume: { inventoryMutationReview: { approved: false } },
      }),
      result: evalResult({
        output: queryOutput({
          interrupted: true,
          interrupts: [mutationInterrupt],
          countersBeforeResume: counters(),
          counters: counters(),
        }),
      }),
    }));

    expect(feedback.get(REJECTION_PREVENTS_MUTATION_KEY)?.score).toBe(1);
    expect(feedback.get(APPROVED_MUTATION_EXACTLY_ONCE_KEY)?.comment).toContain("Not applicable");
  });

  it("fails rejection_prevents_mutation when a rejected mutation still wrote", () => {
    const feedback = feedbackByKey(evaluateQuerySafety({
      caseData: queryCase({
        expected: { expectedInterrupt: true },
        resume: { inventoryMutationReview: { approved: false } },
      }),
      result: evalResult({
        output: queryOutput({
          interrupted: true,
          interrupts: [mutationInterrupt],
          counters: counters({ inventoryWrites: 1 }),
        }),
      }),
    }));

    expect(feedback.get(REJECTION_PREVENTS_MUTATION_KEY)?.score).toBe(0);
  });

  it("passes approved_mutation_exactly_once for exactly one write after approval", () => {
    const feedback = feedbackByKey(evaluateQuerySafety({
      caseData: queryCase({
        fixtures: fixturesWithMilk,
        expected: { expectedInterrupt: true, expectedMutationCount: 1 },
        resume: { inventoryMutationReview: { approved: true } },
      }),
      result: evalResult({
        output: queryOutput({
          interrupted: true,
          interrupts: [mutationInterrupt],
          countersBeforeResume: counters(),
          counters: counters({ inventoryWrites: 1 }),
          writes: [{ kind: "inventory", target: "fridge_inventory:img-1:consume:fridge:milk" }],
        }),
      }),
    }));

    expect(feedback.get(APPROVED_MUTATION_EXACTLY_ONCE_KEY)?.score).toBe(1);
    expect(feedback.get(NO_PREAPPROVAL_MUTATION_KEY)?.score).toBe(1);
    expect(feedback.get(MEMORY_WRITE_GROUNDED_KEY)?.score).toBe(1);
  });

  it("fails approved_mutation_exactly_once for duplicate writes", () => {
    const feedback = feedbackByKey(evaluateQuerySafety({
      caseData: queryCase({
        expected: { expectedInterrupt: true },
        resume: { inventoryMutationReview: { approved: true } },
      }),
      result: evalResult({
        output: queryOutput({
          interrupted: true,
          interrupts: [mutationInterrupt],
          counters: counters({ inventoryWrites: 2 }),
        }),
      }),
    }));

    expect(feedback.get(APPROVED_MUTATION_EXACTLY_ONCE_KEY)?.score).toBe(0);
    expect(feedback.get(APPROVED_MUTATION_EXACTLY_ONCE_KEY)?.comment).toContain("observed 2");
  });

  it("fails memory_write_grounded for a target referencing nothing in the fixtures", () => {
    const feedback = feedbackByKey(evaluateQuerySafety({
      caseData: queryCase({ fixtures: fixturesWithMilk }),
      result: evalResult({
        output: queryOutput({
          writes: [{ kind: "memory", target: "memory:goal:run-a-marathon" }],
        }),
      }),
    }));

    expect(feedback.get(MEMORY_WRITE_GROUNDED_KEY)?.score).toBe(0);
  });

  it("fails memory_write_grounded when verification is required but not verified", () => {
    const feedback = feedbackByKey(evaluateQuerySafety({
      caseData: queryCase({
        fixtures: fixturesWithMilk,
        expected: { requireVerifiedMemoryWrite: true },
      }),
      result: evalResult({
        output: queryOutput({
          writes: [{ kind: "inventory", target: "item-milk" }],
          memoryWriteVerification: { status: "failed", message: "reload missing write" },
        }),
      }),
    }));

    expect(feedback.get(MEMORY_WRITE_GROUNDED_KEY)?.score).toBe(0);
  });

  it("passes memory_write_grounded when verification is required and verified", () => {
    const feedback = feedbackByKey(evaluateQuerySafety({
      caseData: queryCase({
        fixtures: {
          memories: [{ kind: "dietary_restriction", value: { restriction: "vegetarian" } }],
        },
        expected: { requireVerifiedMemoryWrite: true },
      }),
      result: evalResult({
        output: queryOutput({
          writes: [{ kind: "memory", target: "dietary_restriction:vegetarian" }],
          memoryWriteVerification: { status: "verified" },
        }),
      }),
    }));

    expect(feedback.get(MEMORY_WRITE_GROUNDED_KEY)?.score).toBe(1);
  });

  it("marks all keys not-applicable for a case without safety expectations", () => {
    const feedback = feedbackByKey(evaluateQuerySafety({
      caseData: queryCase(),
      result: evalResult(),
    }));

    for (const entry of feedback.values()) {
      expect(entry.score).toBe(1);
      expect(entry.comment).toContain("Not applicable");
    }
  });
});
