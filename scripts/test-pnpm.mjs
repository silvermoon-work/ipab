import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "yaml";
import { deliverables } from "./lib/release.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
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
const host = join(work, "host");
const cli = join(host, "node_modules", "@ipab", "cli", "dist", "main.js");
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
  const overrides = {};
  const packages = await deliverables(root);
  assert.equal(packages.length, 5, "Validate all five declared deliverables");
  for (const { directory, pkg } of packages) {
    const archive = join(work, `${pkg.name.split("/")[1]}.tgz`);
    runPnpm(["pack", "--out", archive], directory);
    overrides[pkg.name] = `file:${archive.replaceAll("\\", "/")}`;
  }
  const { catalog } = parse(
    await readFile(join(root, "pnpm-workspace.yaml"), "utf8"),
  );
  await mkdir(host);
  await writeFile(
    join(host, "package.json"),
    JSON.stringify({
      name: "ipab-packed-cli-check",
      private: true,
      type: "module",
      dependencies: overrides,
      devDependencies: {
        typescript: catalog.typescript,
        "@types/node": catalog["@types/node"],
      },
    }),
  );
  await writeFile(
    join(host, "pnpm-workspace.yaml"),
    JSON.stringify(
      { packages: ["."], overrides, allowBuilds: { esbuild: true } },
      null,
      2,
    ),
  );
  runPnpm(["install"], host);
  const imports = [];
  for (const { pkg } of packages) {
    const installed = JSON.parse(
      await readFile(
        join(host, "node_modules", pkg.name, "package.json"),
        "utf8",
      ),
    );
    assert.equal(installed.version, pkg.version);
    assert.equal(installed.private, false);
    for (const range of Object.values(installed.dependencies ?? {}))
      assert.ok(
        !/^(workspace|catalog|link|file):/.test(range),
        "Packed dependencies must be registry versions",
      );
    for (const subpath of Object.keys(installed.exports)) {
      if (subpath === "./package.json") continue;
      imports.push(
        subpath === "." ? pkg.name : `${pkg.name}${subpath.slice(1)}`,
      );
    }
  }
  const consumer = `${imports.map((name) => `import ${JSON.stringify(name)};`).join("\n")}\n`;
  await writeFile(join(host, "consumer.mjs"), consumer);
  await writeFile(join(host, "consumer.ts"), consumer);
  run(process.execPath, [join(host, "consumer.mjs")], host);
  run(
    process.execPath,
    [
      join(host, "node_modules", "typescript", "bin", "tsc"),
      "--noEmit",
      "--strict",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "--target",
      "ES2022",
      "--types",
      "node",
      "consumer.ts",
    ],
    host,
  );
  const reported = spawnSync(process.execPath, [cli, "--version"], {
    cwd: host,
    env,
    encoding: "utf8",
    shell: false,
  });
  if (reported.error) throw reported.error;
  assert.equal(reported.status, 0, reported.stderr);
  assert.equal(
    reported.stdout.trim(),
    packages.find(({ pkg }) => pkg.name === "@ipab/cli").pkg.version,
  );
  await writeFile(
    config,
    JSON.stringify({ backend: "local", dataDir: join(work, "blocks") }),
  );
  run(
    process.execPath,
    [
      cli,
      "--state-dir",
      state,
      "--store-rpc",
      "http://127.0.0.1:1",
      "pin",
      "list",
    ],
    host,
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
      host,
    );
    const packagePath = join(project, "package.json");
    const original = await readFile(packagePath, "utf8");
    assert.equal(JSON.parse(original).packageManager, undefined);
    await writeFile(
      join(project, "pnpm-workspace.yaml"),
      JSON.stringify({
        packages: ["."],
        overrides,
        allowBuilds: { esbuild: true },
      }),
    );
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
  const asset = await realpath(
    join(dirname(cli), "builtins", "template.web-app.car"),
  );
  const assetPath = relative(await realpath(work), asset);
  assert.ok(
    assetPath && !isAbsolute(assetPath) && !assetPath.startsWith(".."),
    "Only modify assets inside this check's temporary installation",
  );
  await unlink(asset);
  for (const corrupt of [false, true]) {
    if (corrupt) await writeFile(asset, "not a CAR");
    const result = spawnSync(
      process.execPath,
      [cli, "--state-dir", state, "pin", "list"],
      { cwd: host, env, encoding: "utf8", shell: false },
    );
    if (result.error) throw result.error;
    assert.equal(result.status, 1, "Missing/corrupt builtin CAR must fail");
    assert.notEqual(result.stderr.trim(), "", "CAR failure must be reported");
  }
} finally {
  await rm(work, { recursive: true, force: true });
}
