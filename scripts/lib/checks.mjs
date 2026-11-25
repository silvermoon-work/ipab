import { spawnSync } from "node:child_process";

export function runChecks(commands) {
  const pnpm = process.env.npm_execpath;
  if (!pnpm || !/[/\\]pnpm(?:\.[cm]?js|\.exe)?$/.test(pnpm))
    throw new Error("Run this check with the repository's pnpm.");
  for (const command of commands) {
    const native = pnpm.endsWith(".exe");
    const result = spawnSync(
      native ? pnpm : process.execPath,
      [...(native ? [] : [pnpm]), "run", command],
      { stdio: "inherit", shell: false },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) {
      process.exitCode = result.status ?? 1;
      return;
    }
  }
}
