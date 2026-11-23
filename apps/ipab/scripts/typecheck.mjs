import { run } from "./lib/run.mjs";
run("typescript/bin/tsc", ["--noEmit", "--project", "tsconfig.json"]);
