import { run } from "./lib/run.mjs";

run("turbo", ["run", "test-ci", "--concurrency=1"]);
