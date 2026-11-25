import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const result = spawnSync(
  process.execPath,
  [
    fileURLToPath(new URL("../../cli/dist/main.js", import.meta.url)),
    "build",
    fileURLToPath(new URL("../", import.meta.url)),
    "--no-import",
    "--replace",
  ],
  { stdio: "inherit", shell: false },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
