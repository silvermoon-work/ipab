import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const cli = fileURLToPath(new URL("../apps/cli", import.meta.url));
const pnpm = process.env.npm_execpath;
if (!pnpm || !/[/\\]pnpm(?:\.[cm]?js|\.exe)?$/.test(pnpm))
  throw new Error("Run this script with pnpm link-cli.");

for (const args of [
  ["run", "build"],
  ["add", "--global", `@ipab/cli@link:${cli}`],
]) {
  const native = pnpm.endsWith(".exe");
  const result = spawnSync(
    native ? pnpm : process.execPath,
    [
      ...(native ? [] : [pnpm]),
      "--config.manage-package-manager-versions=false",
      ...args,
    ],
    { cwd: root, stdio: "inherit", shell: false },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
    break;
  }
}
