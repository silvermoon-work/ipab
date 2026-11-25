import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  fullJobs,
  deliverables,
  nativePublication,
  publishLifecycle,
  registryPackage,
  releaseVersion,
  repository,
  requireDependencies,
  requireFullReleaseJobs,
  requireFullReleaseRun,
  selectRelease,
} from "./release.mjs";

const sha = "a".repeat(40);
const item = {
  pkg: { name: "@ipab/bundle", version: "0.1.0-rc.0", private: false },
  delivery: { tagPrefix: "@ipab/bundle@" },
};

test("only permits the exact lifecycle and passes native pnpm options without bypassing hooks", () => {
  const pkg = {
    ...item.pkg,
    publishConfig: {
      registry: "https://registry.npmjs.org/",
      access: "public",
    },
    scripts: { prepublishOnly: publishLifecycle },
  };
  for (const dryRun of [true, false]) {
    const plan = nativePublication(pkg, {
      channel: "rc",
      dryRun,
      registry: "https://registry.npmjs.org/",
    });
    assert.deepEqual(plan.args, ["publish", "--no-git-checks"]);
    assert.deepEqual(plan.env, {
      PACKAGE_INPUT: pkg.name,
      PNPM_CONFIG_REGISTRY: "https://registry.npmjs.org/",
      PNPM_CONFIG_ACCESS: "public",
      PNPM_CONFIG_TAG: "rc",
      PNPM_CONFIG_PROVENANCE: "true",
      PNPM_CONFIG_DRY_RUN: String(dryRun),
    });
  }
  for (const prepublishOnly of [
    undefined,
    "publish-gate check",
    "publish-gate check --workflow ci.yaml",
    `${publishLifecycle} --unexpected`,
    `${publishLifecycle}; echo bypass`,
  ])
    assert.throws(() =>
      nativePublication(
        { ...pkg, scripts: { prepublishOnly } },
        {
          channel: "rc",
          dryRun: true,
          registry: "https://registry.npmjs.org/",
        },
      ),
    );
  for (const publishConfig of [
    undefined,
    { access: "public" },
    { registry: "https://example.invalid/", access: "public" },
    { registry: "https://registry.npmjs.org/", access: "restricted" },
  ])
    assert.throws(() =>
      nativePublication(
        { ...pkg, publishConfig },
        {
          channel: "rc",
          dryRun: true,
          registry: "https://registry.npmjs.org/",
        },
      ),
    );
});

test("all deliverables consume the pinned published stable gate and native pnpm runs its rejecting lifecycle", async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const workspace = JSON.parse(
    await readFile(join(root, "package.json"), "utf8"),
  );
  const name = "@silvermoon-work/devtool.publish-gate";
  assert.equal(workspace.devDependencies[name], "0.2.0");
  const installed = JSON.parse(
    await readFile(join(root, "node_modules", name, "package.json"), "utf8"),
  );
  assert.equal(installed.version, workspace.devDependencies[name]);
  const packages = await deliverables(root);
  assert.equal(packages.length, 5);
  for (const { pkg } of packages)
    assert.equal(pkg.scripts.prepublishOnly, publishLifecycle);
  const bin = join(root, "node_modules", name, installed.bin["publish-gate"]);
  const help = spawnSync(process.execPath, [bin, "check", "--help"], {
    encoding: "utf8",
    shell: false,
  });
  if (help.error) throw help.error;
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--workflow <filename>/);
  const pnpm = process.env.npm_execpath;
  assert.ok(pnpm && /[/\\]pnpm(?:\.[cm]?js|\.exe)?$/.test(pnpm));
  const work = await mkdtemp(join(tmpdir(), "ipab-gate-smoke-"));
  try {
    await writeFile(
      join(work, "package.json"),
      JSON.stringify({
        name: "ipab-gate-smoke",
        version: "0.0.0",
        private: false,
        scripts: { prepublishOnly: publishLifecycle },
      }),
    );
    const native = pnpm.endsWith(".exe");
    const result = spawnSync(
      native ? pnpm : process.execPath,
      [...(native ? [] : [pnpm]), "publish", "--dry-run", "--no-git-checks"],
      {
        cwd: work,
        env: {
          ...process.env,
          GITHUB_ACTIONS: "false",
          PATH: `${join(root, "node_modules", ".bin")}${delimiter}${process.env.PATH}`,
        },
        encoding: "utf8",
        shell: false,
        timeout: 30_000,
      },
    );
    if (result.error) throw result.error;
    assert.equal(result.status, 1, result.stderr);
    assert.match(
      `${result.stdout}\n${result.stderr}`,
      /publish-gate check --workflow ci.yaml --workflow release-validation.yaml/,
    );
    assert.match(result.stderr, /prepublishOnly hook in GitHub Actions/);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test("maps exactly one tag to its declared package/version and keeps dispatch dry-run", () => {
  assert.equal(
    selectRelease([item], {
      event: "push",
      ref: "refs/tags/@ipab/bundle@0.1.0-rc.0",
    }).dryRun,
    false,
  );
  assert.equal(
    selectRelease([item], {
      event: "workflow_dispatch",
      ref: "refs/heads/main",
      name: item.pkg.name,
      version: item.pkg.version,
    }).dryRun,
    true,
  );
  for (const ref of [
    "refs/heads/main",
    "refs/tags/v0.1.0-rc.0",
    "refs/tags/@ipab/bundle@0.1.0",
    "refs/tags/@ipab/cli@0.1.0-rc.0",
  ])
    assert.throws(() => selectRelease([item], { event: "push", ref }));
  assert.throws(() =>
    selectRelease([item, item], {
      event: "push",
      ref: "refs/tags/@ipab/bundle@0.1.0-rc.0",
    }),
  );
  assert.throws(() =>
    selectRelease([{ ...item, pkg: { ...item.pkg, private: true } }], {
      event: "push",
      ref: "refs/tags/@ipab/bundle@0.1.0-rc.0",
    }),
  );
  assert.throws(() =>
    selectRelease([item], {
      event: "workflow_dispatch",
      ref: "refs/heads/topic",
      name: item.pkg.name,
      version: item.pkg.version,
    }),
  );
  assert.throws(() => selectRelease([item], { event: undefined }));
});

test("enforces absent exact versions and continuous RC sequence with separate dist-tags", () => {
  assert.equal(releaseVersion("0.1.0-rc.0"), "rc");
  assert.equal(
    releaseVersion("0.1.0-rc.2", {
      "0.1.0-rc.0": {},
      "0.1.0-rc.1": {},
    }),
    "rc",
  );
  assert.equal(releaseVersion("0.1.0"), "latest");
  for (const version of [
    "latest",
    "^0.1.0",
    "v0.1.0",
    "0.1.0-beta.0",
    "0.1.0-rc.01",
    "0.1.0+build",
  ])
    assert.throws(() => releaseVersion(version));
  assert.throws(() => releaseVersion("0.1.0-rc.0", { "0.1.0-rc.0": {} }));
  assert.throws(() => releaseVersion("0.1.0-rc.1"));
  assert.throws(() => releaseVersion("0.1.0-rc.2", { "0.1.0-rc.1": {} }));
});

const run = {
  head_sha: sha,
  head_branch: "main",
  event: "workflow_dispatch",
  path: ".github/workflows/release-validation.yaml",
  repository: { full_name: repository },
  run_number: 1,
  status: "completed",
  conclusion: "success",
};
test("rejects stale, cross-SHA or partial full release evidence", () => {
  assert.equal(requireFullReleaseRun([run], sha), run);
  for (const change of [
    { head_sha: "b".repeat(40) },
    { head_branch: "topic" },
    { event: "push" },
    { path: ".github/workflows/ci.yaml" },
    { repository: { full_name: "other/repo" } },
    { status: "in_progress" },
    { conclusion: "failure" },
  ])
    assert.throws(() => requireFullReleaseRun([{ ...run, ...change }], sha));
  assert.throws(() =>
    requireFullReleaseRun(
      [run, { ...run, run_number: 2, conclusion: "failure" }],
      sha,
    ),
  );
  const jobs = fullJobs.map((name) => ({
    name,
    status: "completed",
    conclusion: "success",
  }));
  assert.doesNotThrow(() => requireFullReleaseJobs(jobs));
  for (const job of jobs) {
    assert.throws(() =>
      requireFullReleaseJobs(jobs.filter((value) => value !== job)),
    );
    assert.throws(() => requireFullReleaseJobs([...jobs, job]));
    for (const conclusion of ["skipped", "failure", "cancelled"])
      assert.throws(() =>
        requireFullReleaseJobs(
          jobs.map((value) =>
            value === job ? { ...value, conclusion } : value,
          ),
        ),
      );
  }
});

test("registry failures are not absence; runtime and peer versions must actually exist", async () => {
  const metadata = async () => ({
    name: "@ipab/bundle",
    versions: { "0.1.0-rc.0": {} },
  });
  await assert.doesNotReject(() =>
    requireDependencies(
      {
        dependencies: { "@ipab/bundle": "0.1.0-rc.0" },
      },
      metadata,
    ),
  );
  for (const dependencies of [
    { "@ipab/bundle": "workspace:*" },
    { "@ipab/bundle": "^0.1.0" },
    { "@ipab/bundle": "0.1.0" },
  ])
    await assert.rejects(() => requireDependencies({ dependencies }, metadata));
  await assert.rejects(() =>
    requireDependencies(
      {
        dependencies: { external: "^1.0.0" },
        peerDependencies: { external: "^2.0.0" },
      },
      async () => ({ versions: { "1.1.0": {}, "2.0.0": {} } }),
    ),
  );
  for (const status of [404, 401, 429, 500])
    await assert.rejects(
      () =>
        registryPackage(
          "https://example.invalid/",
          "@ipab/bundle",
          async () => new Response("error", { status }),
        ),
      /Registry request failed/,
    );
  await assert.rejects(
    () =>
      registryPackage("https://example.invalid/", "@ipab/bundle", async () =>
        Response.json({ name: "wrong", versions: {} }),
      ),
    /Invalid registry/,
  );
  await assert.rejects(
    () =>
      registryPackage("https://example.invalid/", "@ipab/bundle", async () => {
        throw new Error("network unavailable");
      }),
    /network unavailable/,
  );
});
