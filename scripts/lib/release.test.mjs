import assert from "node:assert/strict";
import { test } from "node:test";
import {
  fullJobs,
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
