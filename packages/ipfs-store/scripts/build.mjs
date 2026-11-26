import { rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
for (const name of ["kubo.js", "kubo.js.map", "kubo.d.ts", "kubo.d.ts.map"])
  rmSync(new URL(`../dist/${name}`, import.meta.url), { force: true });
const result = spawnSync(
  process.execPath,
  [
    fileURLToPath(import.meta.resolve("typescript/bin/tsc")),
    "--project",
    "tsconfig.build.json",
  ],
  { stdio: "inherit", shell: false },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
