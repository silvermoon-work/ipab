import { spawnSync } from "node:child_process";
import "./prepare.mjs";

const result = spawnSync(
  process.execPath,
  [
    "node_modules/@ipab/cli/dist/main.js",
    "build",
    "dist/prepared-app",
    "--output",
    "dist/app.car",
    "--replace",
  ],
  {
    stdio: "inherit",
  },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
