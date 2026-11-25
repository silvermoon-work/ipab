import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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
async function verifyInstalledViewer(project) {
  function jsonCli(args) {
    const result = spawnSync(
      process.execPath,
      [cli, "--state-dir", state, "--json", ...args],
      { cwd: work, env, encoding: "utf8", shell: false },
    );
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  }
  const app = jsonCli(["bundle", "import", join(project, "dist", "app.car")]);
  const content = join(work, "viewer-content");
  await mkdir(content);
  await writeFile(
    join(content, ".bundle.yaml"),
    await readFile(join(project, "schemas", "content.json")),
  );
  await writeFile(
    join(content, "message.json"),
    JSON.stringify({ message: "SSR from installed viewer" }),
  );
  const data = jsonCli(["bundle", "build", content]);
  const child = spawn(
    process.execPath,
    [cli, "--state-dir", state, "exec", app.cid, data.cid, "--no-open"],
    { cwd: work, env, stdio: ["ignore", "ignore", "pipe"], shell: false },
  );
  let diagnostic = "";
  let readyResolve, readyReject;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  child.stderr.on("data", (chunk) => {
    diagnostic += chunk.toString();
    const url = diagnostic.match(/http:\/\/127\.0\.0\.1:\d+\//)?.[0];
    if (url) readyResolve(url);
  });
  const closed = new Promise((resolve, reject) => {
    child.once("error", (error) => {
      readyReject(error);
      reject(error);
    });
    child.once("close", (code) => {
      readyReject(new Error(`Viewer exited before connection: ${diagnostic}`));
      resolve(code);
    });
  });
  try {
    const url = await ready;
    const host = await fetch(url, { signal: AbortSignal.timeout(10_000) }).then(
      (response) => response.text(),
    );
    const secret = /nonce="([^"]+)"/.exec(host)?.[1];
    assert.ok(secret, "The real App must serve its framework host");
    const post = (path, body) =>
      fetch(new URL(path, url), {
        method: "POST",
        headers: {
          Origin: new URL(url).origin,
          "X-IPAB-Web": secret,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
    const session = await post("/session", {}).then((response) =>
      response.json(),
    );
    const response = await fetch(new URL("frame/index.html", url), {
      signal: AbortSignal.timeout(10_000),
    });
    const html = await response.text();
    assert.equal(response.status, 200, `${html}\n${diagnostic}`);
    assert.ok(
      html.includes("<h1>SSR from installed viewer</h1>"),
      "SSR must contain the real Content Bundle entry, with working React hooks",
    );
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal((await post("/disconnect", session)).status, 200);
    assert.equal(await closed, 0, diagnostic);
    console.log(
      "Verified installed viewer App execution, real content SSR and lease shutdown.",
    );
  } finally {
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      if (process.platform === "win32")
        run("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], work);
      else
        assert.ok(
          child.kill("SIGTERM"),
          "Could not stop the owned viewer subprocess",
        );
    }
    await closed;
  }
}
try {
  const archive = join(work, "cli.tgz");
  runPnpm(["pack", "--out", archive], join(root, "apps", "cli"));
  const overrides = {};
  for (const entry of await readdir(join(root, "packages"), {
    withFileTypes: true,
  })) {
    if (!entry.isDirectory()) continue;
    const directory = join(root, "packages", entry.name);
    const pkg = JSON.parse(
      await readFile(join(directory, "package.json"), "utf8"),
    );
    overrides[pkg.name] = `link:${directory.replaceAll("\\", "/")}`;
  }
  await mkdir(host);
  await writeFile(
    join(host, "package.json"),
    JSON.stringify({
      name: "ipab-packed-cli-check",
      private: true,
      dependencies: { "@ipab/cli": `file:${archive.replaceAll("\\", "/")}` },
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
  for (const template of ["node", "web-app", "bundle-viewer"]) {
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
        template === "bundle-viewer"
          ? join(root, "templates", template)
          : template,
        ...(template === "web-app"
          ? [
              "--param",
              `webAppDependency=file:${join(root, "packages", "web-app").replaceAll("\\", "/")}`,
            ]
          : template === "bundle-viewer"
            ? [
                "--param",
                `bundleViewerDependency=link:${join(root, "packages", "bundle-viewer").replaceAll("\\", "/")}`,
              ]
            : []),
      ],
      root,
    );
    const packagePath = join(project, "package.json");
    const original = await readFile(packagePath, "utf8");
    assert.equal(JSON.parse(original).packageManager, undefined);
    await writeFile(
      join(project, "pnpm-workspace.yaml"),
      JSON.stringify({ packages: ["."], allowBuilds: { esbuild: true } }),
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
    if (template === "bundle-viewer") await verifyInstalledViewer(project);
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
