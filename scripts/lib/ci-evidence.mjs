export function requireCiRun(runs, sha, repository) {
  if (!/^[0-9a-f]{40}$/.test(sha))
    throw new Error("TARGET_SHA must be a full lowercase commit SHA.");
  const run = runs
    .filter(
      (run) =>
        run.head_sha === sha &&
        run.head_branch === "main" &&
        run.event === "push" &&
        run.path === ".github/workflows/ci.yaml" &&
        run.repository.full_name === repository,
    )
    .sort((a, b) => b.run_number - a.run_number)[0];
  if (!run || run.status !== "completed" || run.conclusion !== "success")
    throw new Error("The latest exact-SHA main-push CI must have succeeded.");
  return run;
}

export function requireCiJobs(jobs) {
  const required = [
    "Quality default",
    "Node.js 22.15.0",
    "Node.js 24.11.1",
    "CI verification (v2)",
  ];
  for (const name of required) {
    const matches = jobs.filter((job) => job.name === name);
    if (
      matches.length !== 1 ||
      matches[0].status !== "completed" ||
      matches[0].conclusion !== "success"
    )
      throw new Error(`Missing or unsuccessful exact-SHA CI job: ${name}`);
  }
  if (
    jobs.some(
      (job) => job.status !== "completed" || job.conclusion !== "success",
    )
  )
    throw new Error("Every main-push CI job must have succeeded.");
}
