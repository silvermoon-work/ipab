import { spawnSync } from "node:child_process";
import { requireCiJobs, requireCiRun } from "./lib/ci-evidence.mjs";

function command(tool, args) {
  const result = spawnSync(tool, args, {
    encoding: "utf8",
    shell: false,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${tool} failed: ${result.stderr}`);
  return result.stdout.trim();
}

const sha = process.env.TARGET_SHA;
const repository = process.env.GITHUB_REPOSITORY;
if (!sha || !/^[0-9a-f]{40}$/.test(sha) || !repository)
  throw new Error("Set TARGET_SHA to a full commit SHA and GITHUB_REPOSITORY.");
if (command("git", ["rev-parse", "HEAD"]) !== sha)
  throw new Error("The checked-out commit must equal TARGET_SHA.");
command("git", ["merge-base", "--is-ancestor", sha, "origin/main"]);

function pages(path, key) {
  const response = JSON.parse(
    command("gh", ["api", "--paginate", "--slurp", path]),
  );
  return response.flatMap((page) => page[key]);
}

const run = requireCiRun(
  pages(
    `repos/${repository}/actions/workflows/ci.yaml/runs?event=push&head_sha=${sha}&per_page=100`,
    "workflow_runs",
  ),
  sha,
  repository,
);
requireCiJobs(
  pages(
    `repos/${repository}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`,
    "jobs",
  ),
);
console.log(`Verified exact-SHA main-push CI: ${run.html_url}`);
