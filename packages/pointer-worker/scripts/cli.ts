#!/usr/bin/env tsx
import { runOperator, runtime } from "../src/operator.ts";

try {
  await runOperator(runtime.process.argv.slice(2));
} catch (err) {
  console.error(err instanceof Error ? err.message : "operator command failed");
  runtime.process.exitCode = 1;
}
