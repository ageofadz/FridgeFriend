import { spawn } from "node:child_process";

const inputArgs = process.argv.slice(2);
const args = ["dev"];

for (let index = 0; index < inputArgs.length; index += 1) {
  const arg = inputArgs[index];
  const next = inputArgs[index + 1];

  if (arg === "--host") {
    if (!next) {
      console.error("Missing host value after --host");
      process.exit(1);
    }
    args.push("--host", next);
    index += 1;
    continue;
  }

  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(arg) || arg === "localhost") {
    args.push("--host", arg);
    continue;
  }

  args.push(arg);
}

const server = spawn("react-router", args, {
  stdio: "inherit",
  shell: false,
});

server.on("error", (error) => {
  console.error(`Failed to start React Router dev server: ${error.message}`);
  process.exit(1);
});

server.on("exit", (code, signal) => {
  if (signal) {
    process.exit(128);
  }
  process.exit(code ?? 1);
});
