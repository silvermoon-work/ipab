import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const cli = join(root, "apps", "cli", "dist", "main.js");
const pnpm = process.env.npm_execpath;
if (!pnpm || !/[/\\]pnpm(?:\.[cm]?js|\.exe)?$/.test(pnpm))
  throw new Error("Run this check with the repository's pnpm test-pnpm.");
const native = pnpm.endsWith(".exe");
const workspace = JSON.parse(
  await readFile(join(root, "package.json"), "utf8"),
);
const version = spawnSync(
  native ? pnpm : process.execPath,
  [...(native ? [] : [pnpm]), "--version"],
  { encoding: "utf8", shell: false },
);
if (version.error) throw version.error;
assert.equal(version.status, 0, version.stderr);
assert.equal(`pnpm@${version.stdout.trim()}`, workspace.packageManager);

const work = await mkdtemp(join(tmpdir(), "ipab-pnpm-"));
const config = join(work, "store.json");
const state = join(work, "state");
const env = {
  ...process.env,
  COREPACK_ENABLE_NETWORK: "0",
  COREPACK_ENABLE_AUTO_PIN: "0",
  TASK_CONTENT_CONFIG: config,
};
function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    stdio: "inherit",
    shell: false,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} ${args.join(" ")} failed`);
}
function runPnpm(args, cwd) {
  run(
    native ? pnpm : process.execPath,
    [...(native ? [] : [pnpm]), ...args],
    cwd,
  );
}
try {
  await writeFile(
    config,
    JSON.stringify({ backend: "local", dataDir: join(work, "blocks") }),
  );
  for (const template of ["node", "web-app"]) {
    const project = join(work, template);
    console.log(
      `Verifying ${template} with ${workspace.packageManager} on ${process.version}`,
    );
    run(
      process.execPath,
      [
        cli,
        "--state-dir",
        state,
        "init",
        `pnpm-${template}`,
        project,
        "--template",
        template,
      ],
      root,
    );
    const packagePath = join(project, "package.json");
    const original = await readFile(packagePath, "utf8");
    assert.equal(JSON.parse(original).packageManager, undefined);
    runPnpm(["install"], project);
    const bin = join(project, "node_modules", ".bin");
    await mkdir(bin, { recursive: true });
    await writeFile(
      join(bin, "ipab"),
      `#!/usr/bin/env node\nprocess.argv.splice(2, 0, "--state-dir", ${JSON.stringify(state)});\nimport(${JSON.stringify(pathToFileURL(cli).href)});\n`,
      { mode: 0o755 },
    );
    if (process.platform === "win32") {
      const wrapper = join(project, "ipab-runner.cjs");
      await writeFile(
        wrapper,
        `process.argv.splice(2, 0, "--state-dir", ${JSON.stringify(state)});\nimport(${JSON.stringify(pathToFileURL(cli).href)});\n`,
      );
      await writeFile(
        join(bin, "ipab.cmd"),
        `@"${process.execPath}" "${wrapper}" %*\r\n`,
      );
    }
    runPnpm(["typecheck"], project);
    runPnpm(["build"], project);
    run(
      process.execPath,
      [
        cli,
        "--state-dir",
        state,
        "bundle",
        "inspect",
        resolve(project, "dist", "app.car"),
      ],
      project,
    );
    assert.equal(await readFile(packagePath, "utf8"), original);
  }
} finally {
  await rm(work, { recursive: true, force: true });
}
