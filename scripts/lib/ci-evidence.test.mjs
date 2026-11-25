import assert from "node:assert/strict";
import { test } from "node:test";
import { requireCiJobs, requireCiRun } from "./ci-evidence.mjs";

const sha = "a".repeat(40);
const repository = "silvermoon-work/ipab";
const run = {
  id: 123,
  run_number: 1,
  run_attempt: 2,
  head_sha: sha,
  head_branch: "main",
  event: "push",
  path: ".github/workflows/ci.yaml",
  repository: { full_name: repository },
  status: "completed",
  conclusion: "success",
};
const jobs = [
  "Quality default",
  "Node.js 22.15.0",
  "Node.js 24.11.1",
  "CI verification (v2)",
].map((name) => ({ name, status: "completed", conclusion: "success" }));

test("accepts only exact-SHA main-push evidence from this workflow and repository", () => {
  assert.equal(requireCiRun([run], sha, repository), run);
  for (const change of [
    { head_sha: "b".repeat(40) },
    { head_branch: "topic" },
    { event: "pull_request" },
    { event: "workflow_dispatch" },
    { path: ".github/workflows/release-validation.yaml" },
    { repository: { full_name: "other/ipab" } },
    { status: "in_progress" },
    { conclusion: "failure" },
  ])
    assert.throws(() => requireCiRun([{ ...run, ...change }], sha, repository));
  assert.throws(() => requireCiRun([], sha, repository));
  assert.throws(() => requireCiRun([run], "main", repository));
});

test("does not accept stale success after a newer failed or unfinished run", () => {
  for (const change of [
    { conclusion: "failure" },
    { status: "in_progress", conclusion: null },
  ])
    assert.throws(() =>
      requireCiRun(
        [run, { ...run, run_number: 2, ...change }],
        sha,
        repository,
      ),
    );
});

test("requires every matrix job and the new daily aggregate exactly once", () => {
  assert.doesNotThrow(() => requireCiJobs(jobs));
  for (const job of jobs) {
    assert.throws(() => requireCiJobs(jobs.filter((item) => item !== job)));
    assert.throws(() => requireCiJobs([...jobs, job]));
    for (const conclusion of ["skipped", "cancelled", "failure", null])
      assert.throws(() =>
        requireCiJobs(
          jobs.map((item) => (item === job ? { ...item, conclusion } : item)),
        ),
      );
  }
  assert.throws(() =>
    requireCiJobs(
      jobs.map((job) =>
        job.name === "CI verification (v2)"
          ? { ...job, name: "Release verification (v1)" }
          : job,
      ),
    ),
  );
  assert.throws(() =>
    requireCiJobs([
      ...jobs,
      { name: "extra", status: "completed", conclusion: "failure" },
    ]),
  );
});
