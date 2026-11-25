import { chmodSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { run } from "../../../scripts/lib/run.mjs";

run("typescript/bin/tsc", ["--project", "tsconfig.build.json"]);
if (process.exitCode === 0 && process.platform !== "win32") {
  const entry = fileURLToPath(new URL("../dist/main.js", import.meta.url));
  chmodSync(entry, statSync(entry).mode | 0o111);
}
