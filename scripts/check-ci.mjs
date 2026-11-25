import { runChecks } from "./lib/checks.mjs";

runChecks([
  "format-check",
  "build",
  "typecheck",
  "lint",
  "test-tooling",
  "test-ci",
  "lint-package",
]);
