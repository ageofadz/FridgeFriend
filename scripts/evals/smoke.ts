// Deployment smoke test (spec "Deployment smoke test"). Pushes one replay
// query case (plus a live case when GOOGLE_API_KEY is present, and a replay
// scan case) through the deployed `query_eval_graph` / `scan_eval_graph`
// entrypoints of a running LangGraph server.
//
// Usage: npm run eval:smoke
// Env:   LANGGRAPH_API_URL (default http://localhost:2024)
//        DATABASE_PATH (optional — verified untouched when set)

import { statSync, readFileSync } from "node:fs";

import { encode as encodeJpeg } from "jpeg-js";

import { EvalResultSchema, type EvalResult } from "../../app/server/evals/schemas/eval-result";
import { getLangSmithConfig } from "../../app/server/langsmith.server";

const apiUrl = process.env.LANGGRAPH_API_URL ?? "http://localhost:2024";
const failures: string[] = [];

function check(label: string, ok: boolean, detail?: string) {
  console.log(`  ${ok ? "ok " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(`${label}${detail ? ` (${detail})` : ""}`);
}

// ---------------------------------------------------------------------------
// Embedded smoke cases (adapted from test/app/server/evals/graphs/*.test.ts)
// ---------------------------------------------------------------------------

function queryReplayCase() {
  return {
    caseId: "smoke-general-chat-replay",
    revision: "v1",
    kind: "route_contract",
    split: "smoke",
    description: "Smoke: general chat replay through the deployed query eval graph",
    tags: ["smoke"],
    input: { fridgeId: "eval-fridge", imageId: null, query: "Hello there." },
    fixtures: {},
    expected: { intent: "general_chat" },
    replay: [
      {
        callId: "intent-1",
        expectedNode: "determine_intent",
        expectedSchemaName: "IntentResponse",
        output: {
          intent: "general_chat",
          recipeContinuation: false,
          shoppingMode: "direct",
          enrichment: { itemNames: [], fields: [] },
        },
      },
      {
        callId: "memory-1",
        expectedNode: "extract_memory_candidates",
        expectedSchemaName: "MemoryCandidates",
        output: { candidates: [] },
      },
      {
        callId: "response-1",
        expectedNode: "respond",
        expectedSchemaName: "QueryResponse",
        output: "Hello from the smoke test.",
      },
      {
        callId: "workspace-1",
        expectedNode: "plan_workspace_actions",
        expectedSchemaName: "WorkspaceActionPlan",
        output: { actions: [] },
      },
    ],
  };
}

function queryLiveCase() {
  const { replay: _replay, ...rest } = queryReplayCase();
  return {
    ...rest,
    caseId: "smoke-general-chat-live",
    description: "Smoke: general chat live through the deployed query eval graph",
  };
}

function jpegDataUrl(): string {
  const jpeg = encodeJpeg(
    {
      data: Buffer.from([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]),
      width: 2,
      height: 2,
    },
    100,
  );
  return `data:image/jpeg;base64,${Buffer.from(jpeg.data).toString("base64")}`;
}

function scanReplayCase() {
  return {
    caseId: "smoke-invalid-image-replay",
    revision: "v1",
    kind: "route_contract",
    split: "smoke",
    description: "Smoke: invalid fridge photo routed to scan_failed via replay",
    tags: ["smoke"],
    input: { fridgeId: "eval-fridge", imageId: "image-1", storageLocation: "fridge" },
    fixtures: { images: [{ imageId: "image-1", dataUrl: jpegDataUrl() }] },
    expected: { terminalRoute: "scan_failed" },
    replay: [
      {
        callId: "validation-1",
        expectedNode: "validate_images",
        expectedSchemaName: "ImageValidation",
        output: { isFridge: false, reason: "Smoke test: not a fridge." },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Server access (SDK when resolvable, plain REST otherwise)
// ---------------------------------------------------------------------------

type Server = {
  waitRun(graphId: string, input: Record<string, unknown>): Promise<Record<string, unknown>>;
  graphIds(): Promise<string[]>;
};

async function connect(): Promise<Server> {
  try {
    const { Client } = await import("@langchain/langgraph-sdk");
    const client = new Client({ apiUrl });
    return {
      waitRun: async (graphId, input) =>
        (await client.runs.wait(null, graphId, { input })) as Record<string, unknown>,
      graphIds: async () => {
        const assistants = await client.assistants.search({ limit: 50 });
        return [...new Set(assistants.map((assistant) => assistant.graph_id))];
      },
    };
  } catch {
    console.log("(@langchain/langgraph-sdk not resolvable — falling back to plain REST)");
    return {
      waitRun: async (graphId, input) => {
        const response = await fetch(`${apiUrl}/runs/wait`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ assistant_id: graphId, input }),
        });
        if (!response.ok) throw new Error(`POST /runs/wait -> ${response.status} ${await response.text()}`);
        return (await response.json()) as Record<string, unknown>;
      },
      graphIds: async () => {
        const response = await fetch(`${apiUrl}/assistants/search`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ limit: 50 }),
        });
        if (!response.ok) throw new Error(`POST /assistants/search -> ${response.status}`);
        const assistants = (await response.json()) as Array<{ graph_id: string }>;
        return [...new Set(assistants.map((assistant) => assistant.graph_id))];
      },
    };
  }
}

function resultFromState(state: Record<string, unknown>): EvalResult | null {
  const parsed = EvalResultSchema.safeParse(state.result);
  return parsed.success ? parsed.data : null;
}

async function runEvalCase(input: {
  server: Server;
  graphId: string;
  caseObj: Record<string, unknown>;
  mode?: "replay" | "live";
  threadPrefix: string;
  expectStatus: string;
}) {
  const label = `${input.graphId} ${String(input.caseObj.caseId)}`;
  try {
    const state = await input.server.waitRun(input.graphId, {
      case: input.caseObj,
      ...(input.mode ? { mode: input.mode } : {}),
    });
    const result = resultFromState(state);

    check(`${label}: result parses as EvalResult`, result !== null);
    if (!result) return;
    check(`${label}: status ${input.expectStatus}`, result.status === input.expectStatus, `got ${result.status}${result.error ? `: [${result.error.errorKind}] ${result.error.message}` : ""}`);
    check(
      `${label}: fresh eval thread id`,
      result.threadId.startsWith(input.threadPrefix),
      `threadId=${result.threadId}`,
    );
  } catch (error) {
    check(label, false, error instanceof Error ? error.message : String(error));
  }
}

async function main() {
  console.log(`Smoke-testing LangGraph server at ${apiUrl}\n`);

  // Snapshot the household DB (if configured) to prove eval runs never write it.
  const databasePath = process.env.DATABASE_PATH;
  let dbBefore: { size: number; mtimeMs: number; bytes: Buffer } | null = null;
  if (databasePath) {
    try {
      const stat = statSync(databasePath);
      dbBefore = { size: stat.size, mtimeMs: stat.mtimeMs, bytes: readFileSync(databasePath) };
      console.log(`Watching DATABASE_PATH=${databasePath} (${stat.size} bytes)\n`);
    } catch {
      console.log(`DATABASE_PATH=${databasePath} does not exist yet — skipping write check.\n`);
    }
  }

  try {
    const ok = await fetch(`${apiUrl}/ok`, { signal: AbortSignal.timeout(3000) });
    if (!ok.ok) throw new Error(`GET /ok -> ${ok.status}`);
  } catch (error) {
    console.error(
      `LangGraph server is not reachable at ${apiUrl}.\n` +
        `Start it with \`npm run langgraph:dev\` (or set LANGGRAPH_API_URL), then rerun \`npm run eval:smoke\`.\n` +
        `(${error instanceof Error ? error.message : String(error)})`,
    );
    process.exit(1);
  }

  const server = await connect();

  try {
    const graphIds = await server.graphIds();
    check("query_eval_graph registered", graphIds.includes("query_eval_graph"), graphIds.join(", "));
    check("scan_eval_graph registered", graphIds.includes("scan_eval_graph"), graphIds.join(", "));
  } catch (error) {
    check("assistants search", false, error instanceof Error ? error.message : String(error));
  }

  console.log("\nReplay query case:");
  await runEvalCase({
    server,
    graphId: "query_eval_graph",
    caseObj: queryReplayCase(),
    threadPrefix: "eval:query:",
    expectStatus: "completed",
  });

  if (process.env.GOOGLE_API_KEY) {
    console.log("\nLive query case:");
    await runEvalCase({
      server,
      graphId: "query_eval_graph",
      caseObj: queryLiveCase(),
      mode: "live",
      threadPrefix: "eval:query:",
      expectStatus: "completed",
    });
  } else {
    console.log("\nGOOGLE_API_KEY not set — skipping live query case.");
  }

  console.log("\nReplay scan case:");
  await runEvalCase({
    server,
    graphId: "scan_eval_graph",
    caseObj: scanReplayCase(),
    threadPrefix: "eval:scan:",
    expectStatus: "completed",
  });

  if (databasePath && dbBefore) {
    const stat = statSync(databasePath);
    const unchanged =
      stat.size === dbBefore.size &&
      stat.mtimeMs === dbBefore.mtimeMs &&
      readFileSync(databasePath).equals(dbBefore.bytes);
    console.log("");
    check("no household DB writes", unchanged, `DATABASE_PATH=${databasePath}`);
  }

  try {
    const langsmith = getLangSmithConfig();
    if (langsmith) {
      console.log(
        `\nLangSmith tracing is configured — inspect traces in project "${langsmith.project}" at ${langsmith.endpoint} ` +
          `(filter tags: fridgefriend, query_graph, evaluation, replay; metadata: evalCaseId).`,
      );
    } else {
      console.log("\nLangSmith not configured — no trace URLs to print.");
    }
  } catch (error) {
    console.log(`\nLangSmith configuration incomplete: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (failures.length > 0) {
    console.error(`\nSmoke test FAILED (${failures.length}):\n  - ${failures.join("\n  - ")}`);
    process.exit(1);
  }
  console.log("\nSmoke test passed.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
