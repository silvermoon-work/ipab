import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  deliverables,
  nativePublication,
  registryPackage,
  releaseVersion,
  repository,
  requireDependencies,
  requireFullReleaseJobs,
  requireFullReleaseRun,
  selectRelease,
} from "./lib/release.mjs";
import { requireCiJobs, requireCiRun } from "./lib/ci-evidence.mjs";

function command(tool, args, options = {}) {
  const result = spawnSync(tool, args, {
    encoding: "utf8",
    shell: false,
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${tool} failed: ${result.stderr ?? result.status}`);
  return result.stdout?.trim() ?? "";
}

const root = fileURLToPath(new URL("../", import.meta.url));
const target = selectRelease(await deliverables(root), {
  event: process.env.GITHUB_EVENT_NAME,
  ref: process.env.GITHUB_REF,
  name: process.env.TARGET_PACKAGE,
  version: process.env.TARGET_VERSION,
});
if (
  process.env.GITHUB_REPOSITORY !== repository ||
  process.env.GITHUB_WORKFLOW_REF?.split("@")[0] !==
    `${repository}/.github/workflows/publish-npm.yaml`
)
  throw new Error(
    "Publishing is restricted to this repository's publish-npm.yaml.",
  );
const sha = process.env.TARGET_SHA ?? process.env.GITHUB_SHA;
if (
  !/^[0-9a-f]{40}$/.test(sha ?? "") ||
  process.env.GITHUB_WORKFLOW_SHA !== sha ||
  command("git", ["rev-parse", "HEAD"]) !== sha ||
  command("git", ["rev-parse", `${process.env.GITHUB_REF}^{commit}`]) !== sha
)
  throw new Error("Checkout, selected ref and exact release SHA must agree.");
command("git", ["merge-base", "--is-ancestor", sha, "origin/main"]);
if (command("git", ["status", "--porcelain"]))
  throw new Error("Release worktree must be clean.");
const npmVersion = command("npm", ["--version"]);
const [major, minor, patch] = npmVersion.split(".").map(Number);
if (
  process.platform !== "linux" ||
  !Number.isInteger(major) ||
  major < 11 ||
  (major === 11 && (minor < 5 || (minor === 5 && patch < 1)))
)
  throw new Error(
    "Trusted Publishing requires Linux Actions and npm >=11.5.1.",
  );
if (!target.dryRun && (process.env.NODE_AUTH_TOKEN || process.env.NPM_TOKEN))
  throw new Error(
    "Stored npm tokens are not permitted; use Trusted Publishing.",
  );

function pages(path, key) {
  return JSON.parse(
    command("gh", ["api", "--paginate", "--slurp", path]),
  ).flatMap((page) => page[key]);
}
const daily = requireCiRun(
  pages(
    `repos/${repository}/actions/workflows/ci.yaml/runs?event=push&head_sha=${sha}&per_page=100`,
    "workflow_runs",
  ),
  sha,
  repository,
);
requireCiJobs(
  pages(
    `repos/${repository}/actions/runs/${daily.id}/attempts/${daily.run_attempt}/jobs?per_page=100`,
    "jobs",
  ),
);
const full = requireFullReleaseRun(
  pages(
    `repos/${repository}/actions/workflows/release-validation.yaml/runs?event=workflow_dispatch&head_sha=${sha}&per_page=100`,
    "workflow_runs",
  ),
  sha,
);
requireFullReleaseJobs(
  pages(
    `repos/${repository}/actions/runs/${full.id}/attempts/${full.run_attempt}/jobs?per_page=100`,
    "jobs",
  ),
);
const registry = command("npm", ["config", "get", "registry"]);
if (new URL(registry).protocol !== "https:")
  throw new Error("Release registry must use HTTPS.");
console.log(`Registry: ${registry}`);
const metadata = new Map();
async function versions(name) {
  if (!metadata.has(name))
    metadata.set(name, await registryPackage(registry, name));
  return metadata.get(name);
}
const distTag = releaseVersion(
  target.version,
  (await versions(target.pkg.name)).versions,
);
const pnpm = process.env.npm_execpath;
if (!pnpm || !/[/\\]pnpm(?:\.[cm]?js|\.exe)?$/.test(pnpm))
  throw new Error("Run this gate with pnpm publish-npm.");
function runPnpm(args, cwd = root, env = process.env) {
  const native = pnpm.endsWith(".exe");
  command(
    native ? pnpm : process.execPath,
    [...(native ? [] : [pnpm]), ...args],
    { cwd, env, stdio: "inherit" },
  );
}
runPnpm([
  "exec",
  "turbo",
  "run",
  "lint-package",
  `--filter=${target.pkg.name}`,
]);
const work = await mkdtemp(join(tmpdir(), "ipab-release-"));
try {
  const archive = join(work, "package.tgz");
  runPnpm(["pack", "--out", archive], target.directory);
  command("tar", ["-xzf", archive, "-C", work]);
  const packed = JSON.parse(
    await readFile(join(work, "package", "package.json"), "utf8"),
  );
  if (
    packed.name !== target.pkg.name ||
    packed.version !== target.version ||
    packed.private !== false
  )
    throw new Error(
      "Packed manifest does not match the authorized public package.",
    );
  await requireDependencies(packed, versions);
  releaseVersion(
    target.version,
    (await registryPackage(registry, packed.name)).versions,
  );
  console.log(
    `${target.dryRun ? "Dry run" : "Publishing"}: ${packed.name}@${packed.version} (${sha}, dist-tag ${distTag})`,
  );
  const publication = nativePublication(target.pkg, {
    channel: distTag,
    dryRun: target.dryRun,
    registry,
  });
  runPnpm(publication.args, target.directory, {
    ...process.env,
    ...publication.env,
  });
} finally {
  await rm(work, { recursive: true, force: true });
}
