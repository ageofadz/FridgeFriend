import { cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const sourceDirectory = process.env.PREBUILT_DATA_PATH ?? "/app/demo-corpus/prebuilt-data";
const appDirectory = process.env.DEMO_APP_DATA_PATH ?? "/var/lib/fridgefriend/app";
const chromaDirectory = process.env.DEMO_CHROMA_DATA_PATH ?? "/var/lib/fridgefriend/chroma";
const markerName = "demo-corpus.seed.json";
const sqliteName = "fridgefriend.sqlite";

async function directoryEntries(directory) {
  await mkdir(directory, { recursive: true });
  return readdir(directory);
}

async function assertSource() {
  const [entries, marker] = await Promise.all([
    directoryEntries(sourceDirectory),
    readFile(path.join(sourceDirectory, markerName), "utf8"),
  ]);

  if (!entries.includes(sqliteName) || !entries.includes("chroma")) {
    throw new Error(`Prebuilt demo data at ${sourceDirectory} must contain ${sqliteName} and chroma`);
  }

  return marker;
}

async function existingMarker() {
  try {
    return await readFile(path.join(appDirectory, markerName), "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

async function main() {
  const sourceMarker = await assertSource();
  const marker = await existingMarker();

  if (marker !== null) {
    if (marker !== sourceMarker) {
      throw new Error(`Existing demo data marker at ${path.join(appDirectory, markerName)} does not match the image. Reset with docker compose down -v before trying again.`);
    }

    return;
  }

  const [appEntries, chromaEntries] = await Promise.all([
    directoryEntries(appDirectory),
    directoryEntries(chromaDirectory),
  ]);

  if (appEntries.length > 0 || chromaEntries.length > 0) {
    throw new Error(`Demo volumes contain data without ${markerName}. Reset with docker compose down -v before trying again.`);
  }

  await cp(path.join(sourceDirectory, sqliteName), path.join(appDirectory, sqliteName));
  await cp(path.join(sourceDirectory, "chroma"), chromaDirectory, { recursive: true });
  await writeFile(path.join(appDirectory, markerName), sourceMarker, { flag: "wx" });
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Prebuilt demo data initialization failed: ${message}`);
  process.exitCode = 1;
});
