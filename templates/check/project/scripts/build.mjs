import { spawnSync } from "node:child_process";

const result = spawnSync("ipab", ["build"], {
  stdio: "inherit",
  shell: process.platform === "win32",
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
