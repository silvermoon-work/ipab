import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { parseDocument } from "yaml";
import semver from "semver";

export const repository = "silvermoon-work/ipab";
export const fullJobs = [
  "Exact-SHA daily CI evidence",
  "Full release / default",
  "Full release / Node.js 22.15.0",
  "Full release / Node.js 24.11.1",
  "Release verification (v2)",
];

export async function deliverables(root) {
  const result = [];
  for (const parent of ["apps", "packages"]) {
    for (const entry of await readdir(join(root, parent), {
      withFileTypes: true,
    })) {
      if (!entry.isDirectory()) continue;
      const directory = join(root, parent, entry.name);
      const pkg = JSON.parse(
        await readFile(join(directory, "package.json"), "utf8"),
      );
      if (pkg.private === true) continue;
      const doc = parseDocument(
        await readFile(join(directory, "deliverable.yaml"), "utf8"),
        { uniqueKeys: true },
      );
      if (doc.errors.length) throw doc.errors[0];
      const delivery = doc.toJS();
      if (
        !delivery ||
        Object.keys(delivery).sort().join(",") !== "access,package,tagPrefix" ||
        delivery.package !== pkg.name ||
        delivery.tagPrefix !== `${pkg.name}@` ||
        delivery.access !== "public" ||
        pkg.publishConfig?.access !== "public"
      )
        throw new Error(`Invalid delivery declaration: ${directory}`);
      if (result.some((item) => item.pkg.name === pkg.name))
        throw new Error(`Duplicate package/tag mapping: ${pkg.name}`);
      result.push({ directory, pkg, delivery });
    }
  }
  return result;
}

export function releaseVersion(version, versions = {}) {
  if (
    semver.valid(version) !== version ||
    !/^\d+\.\d+\.\d+(?:-rc\.(?:0|[1-9]\d*))?$/.test(version)
  )
    throw new Error("Release version must be exact x.y.z or x.y.z-rc.n.");
  if (Object.hasOwn(versions, version))
    throw new Error(`Version already exists: ${version}`);
  const prerelease = semver.prerelease(version);
  if (!prerelease) return "latest";
  const base = version.split("-")[0];
  const previous = Object.keys(versions)
    .filter((value) => value.startsWith(`${base}-rc.`))
    .map((value) => {
      if (!/^\d+\.\d+\.\d+-rc\.(?:0|[1-9]\d*)$/.test(value))
        throw new Error(`Unexpected RC version: ${value}`);
      return Number(value.slice(value.lastIndexOf(".") + 1));
    })
    .sort((a, b) => a - b);
  if (
    previous.some((value, index) => value !== index) ||
    prerelease[1] !== previous.length
  )
    throw new Error(
      `RC versions for ${base} must start at rc.0 and be continuous.`,
    );
  return "rc";
}

export function selectRelease(items, { event, ref, name, version }) {
  let selected;
  if (event === "push") {
    if (!ref?.startsWith("refs/tags/"))
      throw new Error("Publishing requires an exact package-version tag.");
    const tag = ref.slice("refs/tags/".length);
    const matches = items.filter((item) =>
      tag.startsWith(item.delivery.tagPrefix),
    );
    if (matches.length !== 1)
      throw new Error("Release tag must map to exactly one declared package.");
    selected = matches[0];
    version = tag.slice(selected.delivery.tagPrefix.length);
  } else if (event === "workflow_dispatch") {
    if (ref !== "refs/heads/main")
      throw new Error("Dry-run dispatch must use main.");
    selected = items.find((item) => item.pkg.name === name);
  } else {
    throw new Error(
      "Use tag push or main workflow_dispatch; no local publication.",
    );
  }
  if (!selected || selected.pkg.private !== false)
    throw new Error("Release target must be an explicitly public deliverable.");
  if (
    !selected.pkg.name.startsWith("@ipab/") ||
    selected.pkg.version !== version
  )
    throw new Error(
      "Release package identity/version must match its manifest.",
    );
  releaseVersion(version);
  return { ...selected, version, dryRun: event === "workflow_dispatch" };
}

export function requireFullReleaseRun(runs, sha) {
  const run = runs
    .filter(
      (run) =>
        run.head_sha === sha &&
        run.head_branch === "main" &&
        run.event === "workflow_dispatch" &&
        run.path === ".github/workflows/release-validation.yaml" &&
        run.repository.full_name === repository,
    )
    .sort((a, b) => b.run_number - a.run_number)[0];
  if (!run || run.status !== "completed" || run.conclusion !== "success")
    throw new Error(
      "Missing successful exact-SHA full main release validation.",
    );
  return run;
}

export function requireFullReleaseJobs(jobs) {
  for (const name of fullJobs) {
    const matches = jobs.filter((job) => job.name === name);
    if (
      matches.length !== 1 ||
      matches[0].status !== "completed" ||
      matches[0].conclusion !== "success"
    )
      throw new Error(`Missing/unsuccessful full release job: ${name}`);
  }
  if (
    jobs.some(
      (job) => job.status !== "completed" || job.conclusion !== "success",
    )
  )
    throw new Error("Every full release job must have succeeded.");
}

export async function registryPackage(registry, name, request = fetch) {
  const url = new URL(
    encodeURIComponent(name),
    registry.endsWith("/") ? registry : `${registry}/`,
  );
  const response = await request(url, {
    signal: AbortSignal.timeout(30_000),
    headers: { Accept: "application/json" },
  });
  if (!response.ok)
    throw new Error(
      `Registry request failed for ${name}: HTTP ${response.status}`,
    );
  const metadata = await response.json();
  if (
    metadata.name !== name ||
    !metadata.versions ||
    typeof metadata.versions !== "object" ||
    Array.isArray(metadata.versions)
  )
    throw new Error(`Invalid registry version metadata for ${name}.`);
  return metadata;
}

export async function requireDependencies(pkg, metadata) {
  const requirements = new Map();
  for (const field of [
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
  ]) {
    for (const [name, range] of Object.entries(pkg[field] ?? {})) {
      if (!semver.validRange(range))
        throw new Error(`Unresolved/non-registry dependency: ${name}@${range}`);
      if (name.startsWith("@ipab/") && semver.valid(range) !== range)
        throw new Error(
          `Internal dependency must use an exact version: ${name}@${range}`,
        );
      const ranges = requirements.get(name) ?? [];
      ranges.push(range);
      requirements.set(name, ranges);
    }
  }
  for (const [name, ranges] of requirements) {
    const available = await metadata(name);
    if (
      !Object.keys(available.versions).some((version) =>
        ranges.every((range) => semver.satisfies(version, range)),
      )
    )
      throw new Error(
        `Unavailable runtime/peer dependency: ${name}@${ranges.join(" & ")}`,
      );
  }
}
