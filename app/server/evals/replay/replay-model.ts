import { AIMessage } from "@langchain/core/messages";

import type { FridgeFriendChatModel } from "../../ai/chat-model.server";
import type { QueryGraphDependencies } from "../../query/schemas/query";
import type { ReplayConsumptionReport } from "../schemas/eval-result";
import type { ReplayStep } from "../schemas/query-eval-case";
import {
  ReplayMismatchError,
  canonicalSchemaName,
  groupReplaySteps,
} from "./replay-sequence";

export type ReplaySession = {
  modelFor(siteKey: string): FridgeFriendChatModel;
  consume(siteKey: string, schemaName?: string): unknown;
  intentRouter(): NonNullable<QueryGraphDependencies["intentEmbeddingRouter"]>;
  report(): ReplayConsumptionReport;
  modelCallCounts(): Record<string, number>;
};

/**
 * Deterministic replay session. Steps are grouped per call site; within a
 * site consumption is strictly ordered. Any unexpected call, schema mismatch,
 * or leftover step surfaces as a ReplayMismatchError naming the callId and
 * site (spec: failure kind `replay_mismatch` with a specific message).
 */
export function createReplaySession(steps: ReplayStep[]): ReplaySession {
  const queues = groupReplaySteps(steps);
  const orderedCallIds = steps.map((step) => step.callId);
  const consumedCallIds: string[] = [];
  const callsPerNode: Record<string, number> = {};

  function consume(siteKey: string, schemaName?: string): unknown {
    const queue = queues.get(siteKey);
    const step = queue?.shift();

    if (!step) {
      throw new ReplayMismatchError(
        `Replay mismatch: unexpected model call at site "${siteKey}" — no remaining replay steps`,
      );
    }

    if (
      schemaName !== undefined &&
      canonicalSchemaName(step.expectedSchemaName) !== canonicalSchemaName(schemaName)
    ) {
      throw new ReplayMismatchError(
        `Replay mismatch at site "${siteKey}": step ${step.callId} expected schema ` +
          `"${step.expectedSchemaName}" but the call used "${schemaName}"`,
        step.callId,
      );
    }

    consumedCallIds.push(step.callId);
    callsPerNode[step.expectedNode] = (callsPerNode[step.expectedNode] ?? 0) + 1;
    return step.output;
  }

  function modelFor(siteKey: string): FridgeFriendChatModel {
    return {
      invoke: async () => {
        const value = consume(siteKey);

        if (typeof value !== "string") {
          throw new ReplayMismatchError(
            `Replay mismatch at site "${siteKey}": expected a string output for a ` +
              `plain model invoke, received ${typeof value}`,
            consumedCallIds[consumedCallIds.length - 1],
          );
        }

        return new AIMessage(value);
      },
      withStructuredOutput: (_schema: unknown, config?: { name?: string }) => ({
        invoke: async () => consume(siteKey, config?.name),
      }),
    } as unknown as FridgeFriendChatModel;
  }

  function intentRouter(): NonNullable<QueryGraphDependencies["intentEmbeddingRouter"]> {
    return async () => ({
      accepted: consume("intent") as never,
      candidates: [],
    });
  }

  function report(): ReplayConsumptionReport {
    const consumed = new Set(consumedCallIds);
    const unusedCallIds = orderedCallIds.filter((callId) => !consumed.has(callId));

    return {
      consumedCallIds: [...consumedCallIds],
      unusedCallIds,
      consumedExactly: unusedCallIds.length === 0,
    };
  }

  function modelCallCounts(): Record<string, number> {
    return { ...callsPerNode };
  }

  return { modelFor, consume, intentRouter, report, modelCallCounts };
}
