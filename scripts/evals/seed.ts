// Seeds the canonical LangSmith datasets from the committed JSONL files.
// Spec "Datasets > Seeder behavior": validate, hash, create-if-missing, index
// remote examples by metadata.caseId, never silently mutate remote cases.
//
// Usage: npm run eval:seed -- [--suite=query|scan|all] [--replace]

import { Client } from "langsmith";
import type { Example } from "langsmith/schemas";

import { getLangSmithConfig } from "../../app/server/langsmith.server";
import {
  CaseValidationError,
  fixtureHash,
  loadSuiteCases,
  parseArgs,
  SUITE_CONFIG,
  stringArg,
  type LoadedCase,
  type Suite,
} from "./lib";

type SeedCounts = { created: number; skipped: number; changed: number; rejected: number };

function exampleMetadata(suite: Suite, loaded: LoadedCase, hash: string): Record<string, unknown> {
  const raw = loaded.raw;
  return {
    caseId: loaded.caseId,
    revision: typeof raw.revision === "string" ? raw.revision : "unknown",
    fixtureHash: hash,
    sourcePath: SUITE_CONFIG[suite].sourcePath,
    kind: typeof raw.kind === "string" ? raw.kind : "unknown",
    split: typeof raw.split === "string" ? raw.split : "unknown",
    tags: Array.isArray(raw.tags) ? raw.tags : [],
  };
}

async function ensureDataset(client: Client, datasetName: string): Promise<string> {
  try {
    const dataset = await client.readDataset({ datasetName });
    return dataset.id;
  } catch {
    const dataset = await client.createDataset(datasetName, {
      description: `Canonical FridgeFriend eval dataset seeded from the repository (${datasetName}).`,
    });
    console.log(`Created dataset ${datasetName} (${dataset.id})`);
    return dataset.id;
  }
}

async function indexRemoteExamples(
  client: Client,
  datasetId: string,
): Promise<Map<string, Example>> {
  const byCaseId = new Map<string, Example>();
  const duplicates: string[] = [];

  for await (const example of client.listExamples({ datasetId })) {
    const caseId = example.metadata?.caseId;
    if (typeof caseId !== "string" || caseId.length === 0) continue;
    if (byCaseId.has(caseId)) {
      duplicates.push(caseId);
      continue;
    }
    byCaseId.set(caseId, example);
  }

  if (duplicates.length > 0) {
    throw new Error(
      `Remote dataset ${datasetId} contains duplicate caseIds: ${duplicates.join(", ")}. ` +
        "Deduplicate the dataset in LangSmith before seeding.",
    );
  }
  return byCaseId;
}

async function seedSuite(client: Client, suite: Suite, replace: boolean): Promise<SeedCounts> {
  const { datasetName } = SUITE_CONFIG[suite];
  // Throws with every invalid row and every duplicate local caseId listed.
  const cases = loadSuiteCases(suite);
  console.log(`\n[${suite}] ${cases.length} valid local cases in ${SUITE_CONFIG[suite].sourcePath}`);

  const datasetId = await ensureDataset(client, datasetName);
  const remote = await indexRemoteExamples(client, datasetId);
  const counts: SeedCounts = { created: 0, skipped: 0, changed: 0, rejected: 0 };
  const rejections: string[] = [];

  for (const loaded of cases) {
    const hash = fixtureHash(loaded.raw);
    const metadata = exampleMetadata(suite, loaded, hash);
    const payload = {
      inputs: { case: loaded.raw },
      outputs: { caseId: loaded.caseId, expected: loaded.raw.expected ?? {} },
      metadata,
    };
    const existing = remote.get(loaded.caseId);

    if (!existing) {
      await client.createExample({ ...payload, dataset_id: datasetId });
      counts.created += 1;
      console.log(`  created  ${loaded.caseId} (${hash.slice(0, 12)})`);
      continue;
    }

    const remoteHash = existing.metadata?.fixtureHash;
    if (remoteHash === hash) {
      counts.skipped += 1;
      continue;
    }

    if (!replace) {
      counts.rejected += 1;
      rejections.push(
        `${loaded.caseId}: local hash ${hash.slice(0, 12)} != remote hash ${String(remoteHash).slice(0, 12)}`,
      );
      continue;
    }

    await client.updateExample({ id: existing.id, ...payload });
    counts.changed += 1;
    console.log(`  updated  ${loaded.caseId} (${String(remoteHash).slice(0, 12)} -> ${hash.slice(0, 12)})`);
  }

  console.log(
    `[${suite}] created=${counts.created} skipped=${counts.skipped} changed=${counts.changed} rejected=${counts.rejected}`,
  );

  if (rejections.length > 0) {
    console.error(
      `\n[${suite}] Refusing to mutate ${rejections.length} remote case(s) with changed fixtures ` +
        "(rerun with --replace to update them):",
    );
    for (const rejection of rejections) console.error(`  - ${rejection}`);
  }
  return counts;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const suiteArg = stringArg(args, "suite") ?? "all";
  const replace = args.replace === true;

  if (!["query", "scan", "all"].includes(suiteArg)) {
    console.error("Invalid --suite. Expected query|scan|all.");
    process.exit(1);
  }

  let config: ReturnType<typeof getLangSmithConfig>;
  try {
    config = getLangSmithConfig();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  if (!config) {
    console.error(
      "LangSmith is not configured. Set LANGSMITH_ENDPOINT, LANGSMITH_API_KEY, and " +
        "LANGSMITH_PROJECT to seed datasets (see artifacts/observability/langsmith-runbook.md).",
    );
    process.exit(1);
  }

  const client = new Client({ apiKey: config.apiKey, apiUrl: config.endpoint });
  const suites: Suite[] = suiteArg === "all" ? ["query", "scan"] : [suiteArg as Suite];
  let rejected = 0;

  for (const suite of suites) {
    const counts = await seedSuite(client, suite, replace);
    rejected += counts.rejected;
  }

  if (rejected > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  if (error instanceof CaseValidationError) {
    console.error(error.message);
  } else {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  }
  process.exit(1);
});
