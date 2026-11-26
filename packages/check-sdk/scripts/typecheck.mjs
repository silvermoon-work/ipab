import { run } from "../../../scripts/lib/run.mjs";
run("typescript/bin/tsc", ["--noEmit", "--project", "tsconfig.json"]);
