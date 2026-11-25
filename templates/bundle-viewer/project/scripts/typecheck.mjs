import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const compiler = require.resolve("typescript/bin/tsc");
for (const config of ["tsconfig.server.json", "tsconfig.web.json"]) {
  const result = spawnSync(
    process.execPath,
    [compiler, "--project", config, "--noEmit"],
    { stdio: "inherit", shell: false },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
    break;
  }
}
