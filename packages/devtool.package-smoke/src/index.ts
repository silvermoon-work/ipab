import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export interface SmokeOptions {
  root: string;
  verify: string;
  pnpm: string;
  allowBuilds?: readonly string[];
  timeout?: number;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function execute(
  command: string,
  args: string[],
  cwd: string,
  timeout: number,
  capture = false,
) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    shell: false,
    stdio: capture ? "pipe" : ["ignore", "inherit", "inherit"],
    timeout,
    env: {
      ...process.env,
      COREPACK_ENABLE_NETWORK: "0",
      COREPACK_ENABLE_AUTO_PIN: "0",
    },
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `${command} ${args.join(" ")} failed (${result.status}): ${capture ? result.stderr : ""}`,
    );
  return capture ? result.stdout : "";
}

export async function packageSmoke(options: SmokeOptions): Promise<number> {
  const root = resolve(options.root);
  const timeout = options.timeout ?? 300_000;
  if (!Number.isSafeInteger(timeout) || timeout <= 0)
    throw new Error("Timeout must be a positive integer in milliseconds.");
  if (
    !isAbsolute(options.pnpm) ||
    !/[/\\]pnpm(?:\.[cm]?js|\.exe)?$/.test(options.pnpm)
  )
    throw new Error("Use the active pnpm executable supplied by npm_execpath.");
  if (!options.verify.endsWith(".mjs"))
    throw new Error("--verify must be a standalone .mjs file.");
  const verify = resolve(root, options.verify);
  const bytes = await readFile(verify);
  const manifest = object(
    JSON.parse(await readFile(join(root, "package.json"), "utf8")) as unknown,
    "Workspace manifest",
  );
  const native = options.pnpm.endsWith(".exe");
  const pnpm = (args: string[], cwd = root, capture = false) =>
    execute(
      native ? options.pnpm : process.execPath,
      [...(native ? [] : [options.pnpm]), ...args],
      cwd,
      timeout,
      capture,
    );
  const version = pnpm(["--version"], root, true).trim();
  if (manifest.packageManager !== `pnpm@${version}`)
    throw new Error(
      "Workspace packageManager must match the active exact pnpm version.",
    );
  const listed: unknown = JSON.parse(
    pnpm(
      [
        "list",
        "--recursive",
        "--include-workspace-root",
        "--depth",
        "-1",
        "--json",
      ],
      root,
      true,
    ),
  );
  if (!Array.isArray(listed))
    throw new Error("pnpm list must return a workspace array.");
  const packages: { name: string; path: string }[] = [];
  for (const value of listed) {
    const item = object(value, "Workspace member");
    if (typeof item.path !== "string" || !isAbsolute(item.path))
      throw new Error("Workspace member requires an absolute path.");
    const pkg = object(
      JSON.parse(
        await readFile(join(item.path, "package.json"), "utf8"),
      ) as unknown,
      "Package manifest",
    );
    if (pkg.private === true) continue;
    if (
      typeof pkg.name !== "string" ||
      !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(pkg.name) ||
      typeof pkg.version !== "string" ||
      !pkg.version.trim()
    )
      throw new Error(
        "Non-private package must have a valid name and version.",
      );
    if (packages.some((entry) => entry.name === pkg.name))
      throw new Error(`Duplicate package name: ${pkg.name}`);
    packages.push({ name: pkg.name, path: item.path });
  }
  if (!packages.length)
    throw new Error("No non-private packages to smoke-test.");
  const allowBuilds: Record<string, true> = {};
  for (const name of options.allowBuilds ?? []) {
    if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name))
      throw new Error("Build permission requires an exact package name.");
    allowBuilds[name] = true;
  }
  const work = await mkdtemp(join(tmpdir(), "package-smoke-"));
  try {
    const overrides: Record<string, string> = {};
    for (const [index, pkg] of packages.entries()) {
      const archive = join(work, `package-${index}.tgz`);
      pnpm(["pack", "--out", archive], pkg.path);
      overrides[pkg.name] = `file:${archive.replaceAll("\\", "/")}`;
    }
    const consumer = join(work, "consumer");
    await mkdir(consumer);
    await writeFile(
      join(consumer, "package.json"),
      JSON.stringify({
        name: "package-smoke-consumer",
        private: true,
        type: "module",
        dependencies: overrides,
      }),
    );
    await writeFile(
      join(consumer, "pnpm-workspace.yaml"),
      JSON.stringify({
        packages: ["."],
        overrides,
        allowBuilds,
      }),
    );
    pnpm(["install"], consumer);
    await writeFile(join(consumer, "verify.mjs"), bytes);
    await writeFile(
      join(consumer, "smoke-packages.json"),
      JSON.stringify(packages.map(({ name }) => name)),
    );
    execute(
      process.execPath,
      [join(consumer, "verify.mjs")],
      consumer,
      timeout,
    );
    return packages.length;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
