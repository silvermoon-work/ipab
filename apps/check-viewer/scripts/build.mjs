import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const { prepareApp } = await import("@ipab/cli/devtools");
await prepareApp(fileURLToPath(new URL("../", import.meta.url)), {
  replace: true,
});
const state = mkdtempSync(join(process.cwd(), ".ipab-check-viewer-build-"));
try {
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL("../../cli/dist/main.js", import.meta.url)),
      "--state-dir",
      state,
      "build",
      fileURLToPath(new URL("../dist/prepared-app/", import.meta.url)),
      "--output",
      fileURLToPath(new URL("../dist/app.car", import.meta.url)),
      "--no-import",
      "--replace",
    ],
    { stdio: "inherit", shell: false },
  );
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(state, { recursive: true, force: true });
}
