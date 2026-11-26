import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const state = mkdtempSync(join(tmpdir(), "ipab-check-viewer-build-"));
try {
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL("../../cli/dist/main.js", import.meta.url)),
      "--state-dir",
      state,
      "build",
      fileURLToPath(new URL("../", import.meta.url)),
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
