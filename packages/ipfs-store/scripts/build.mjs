import { rmSync } from "node:fs";
import { run } from "../../../scripts/lib/run.mjs";
for (const name of ["kubo.js", "kubo.js.map", "kubo.d.ts", "kubo.d.ts.map"])
  rmSync(new URL(`../dist/${name}`, import.meta.url), { force: true });
run("typescript/bin/tsc", ["--project", "tsconfig.build.json"]);
