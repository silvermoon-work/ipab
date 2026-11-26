import { spawnSync } from "node:child_process";

const result = spawnSync(
  "ipab",
  ["build", "dist/prepared-app", "--output", "dist/app.car", "--replace"],
  {
    stdio: "inherit",
    shell: process.platform === "win32",
  },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
