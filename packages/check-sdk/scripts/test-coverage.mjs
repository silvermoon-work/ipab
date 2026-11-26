import { run } from "../../../scripts/lib/run.mjs";
run("vitest", [
  "run",
  "--coverage",
  "--root",
  ".",
  "--config",
  "../../vitest.config.ts",
]);
