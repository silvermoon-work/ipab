import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export function run(tool, args) {
  const entry =
    tool === "vitest"
      ? new URL("../vitest.mjs", import.meta.resolve("vitest"))
      : import.meta.resolve(tool);
  const result = spawnSync(process.execPath, [fileURLToPath(entry), ...args], {
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
