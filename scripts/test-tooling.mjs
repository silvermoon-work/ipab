import { spawnSync } from "node:child_process";

const result = spawnSync(
  process.execPath,
  ["--test", "scripts/lib/ci-evidence.test.mjs"],
  { stdio: "inherit" },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
