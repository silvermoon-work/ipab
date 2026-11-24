import { execFile, spawn } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { HostError, object } from "./errors.js";
import { nodeError, type AuthoringOptions } from "./authoring.js";
import { relativePath } from "./space.js";

export interface ProjectBuild {
  strategy: "ipab-prebuild";
  typecheck: { config: string; entry: string }[];
}

export function projectBuild(value: unknown): ProjectBuild | undefined {
  if (value === undefined) return undefined;
  const build = object(value, "App build");
  if (
    build.strategy !== "ipab-prebuild" ||
    Object.keys(build).some(
      (key) => !["strategy", "typecheck"].includes(key),
    ) ||
    !Array.isArray(build.typecheck) ||
    !build.typecheck.length
  )
    throw new HostError(
      "App build requires strategy ipab-prebuild and a non-empty typecheck array.",
    );
  const typecheck = build.typecheck.map((value: unknown) => {
    const item = object(value, "App typecheck");
    if (
      typeof item.config !== "string" ||
      typeof item.entry !== "string" ||
      Object.keys(item).some((key) => !["config", "entry"].includes(key))
    )
      throw new HostError("Each typecheck requires config and source entry.");
    const config = relativePath(item.config);
    const entry = relativePath(item.entry);
    if (
      !config.endsWith(".json") ||
      !entry.startsWith("src/") ||
      !/\.(ts|tsx)$/.test(entry)
    )
      throw new HostError(
        "Typecheck requires a JSON config and src/ TS entry.",
      );
    return { config, entry };
  });
  return { strategy: "ipab-prebuild", typecheck };
}

export async function buildChain(root: string): Promise<string[]> {
  const identity = await realpath(root);
  const key = process.platform === "win32" ? identity.toLowerCase() : identity;
  const inherited = process.env.IPAB_BUILD_CHAIN;
  const chain: unknown = inherited ? JSON.parse(inherited) : [];
  if (!Array.isArray(chain) || chain.some((item) => typeof item !== "string"))
    throw new HostError("Invalid IPAB_BUILD_CHAIN.");
  if (chain.includes(key))
    throw new HostError(
      "Recursive ipab build detected. ipab-prebuild must not invoke this project's build again.",
    );
  return [...(chain as string[]), key];
}

async function packageManager(pkg: Record<string, unknown>): Promise<{
  name: "npm" | "pnpm";
  entry: string;
  native: boolean;
}> {
  const declaration = pkg.packageManager;
  if (
    declaration !== undefined &&
    (typeof declaration !== "string" ||
      !/^(npm|pnpm)@\d+\.\d+\.\d+(?:\+sha\d+\.[a-f0-9]+)?$/.test(declaration))
  )
    throw new HostError(
      "ipab-prebuild supports exact npm or pnpm packageManager declarations.",
    );
  const name =
    typeof declaration === "string" && declaration.startsWith("pnpm@")
      ? "pnpm"
      : "npm";
  const suffix = name === "npm" ? "npm-cli.js" : "pnpm.cjs";
  const inherited = process.env.npm_execpath;
  const candidates = [
    ...(inherited &&
    (inherited.endsWith(suffix) ||
      (name === "pnpm" && basename(inherited) === "pnpm.exe"))
      ? [inherited]
      : []),
    ...[dirname(process.execPath), ...(process.env.PATH ?? "").split(delimiter)]
      .filter(Boolean)
      .map((directory) => join(directory, "node_modules", name, "bin", suffix)),
  ];
  for (const entry of candidates) {
    try {
      if ((await lstat(entry)).isFile()) {
        const native = entry.endsWith(".exe");
        if (typeof declaration === "string") {
          const expected = declaration.split("@")[1]!.split("+")[0];
          const { stdout } = await promisify(execFile)(
            native ? entry : process.execPath,
            native ? ["--version"] : [entry, "--version"],
          );
          if (stdout.trim() !== expected)
            throw new HostError(
              `Project requires ${declaration}; active ${name} is ${stdout.trim()}.`,
            );
        }
        return { name, entry, native };
      }
    } catch (error) {
      if (!nodeError(error, "ENOENT") && !nodeError(error, "ENOTDIR"))
        throw error;
    }
  }
  throw new HostError(
    `Could not locate ${name}'s JavaScript CLI. Run ipab through ${name} exec, or explicitly install the project's declared package manager.`,
  );
}

export async function runPrebuild(
  root: string,
  output: string,
  pkg: Record<string, unknown>,
  chain: string[],
  options: AuthoringOptions,
): Promise<void> {
  const scripts = object(pkg.scripts, "package scripts");
  if (
    typeof scripts["ipab-prebuild"] !== "string" ||
    !scripts["ipab-prebuild"].trim()
  )
    throw new HostError("Project requires a non-empty scripts.ipab-prebuild.");
  const manager = await packageManager(pkg);
  const args =
    manager.name === "npm"
      ? ["run", "--ignore-scripts", "ipab-prebuild"]
      : ["--config.enable-pre-post-scripts=false", "run", "ipab-prebuild"];
  options.signal?.throwIfAborted();
  await new Promise<void>((accept, reject) => {
    const child = spawn(
      manager.native ? manager.entry : process.execPath,
      manager.native ? args : [manager.entry, ...args],
      {
        cwd: root,
        env: {
          ...process.env,
          IPAB_BUILD_DIR: resolve(output),
          IPAB_BUILD_CHAIN: JSON.stringify(chain),
        },
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
        detached: process.platform !== "win32",
      },
    );
    const diagnostic = (bytes: Buffer) => {
      if (options.diagnostic) options.diagnostic(bytes.toString().trimEnd());
      else process.stderr.write(bytes);
    };
    let stopping: Promise<void> | undefined;
    const abort = () => {
      if (!child.pid || stopping) return;
      const pid = child.pid;
      stopping = (async () => {
        if (process.platform === "win32") {
          try {
            await promisify(execFile)(
              join(
                process.env.SystemRoot ?? "C:\\Windows",
                "System32",
                "taskkill.exe",
              ),
              ["/PID", String(pid), "/T", "/F"],
            );
          } catch (error) {
            if (child.exitCode === null && child.signalCode === null)
              throw error;
          }
        } else {
          try {
            process.kill(-pid, "SIGKILL");
          } catch (error) {
            if (!nodeError(error, "ESRCH")) throw error;
          }
        }
      })();
      void stopping.catch(reject);
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    child.stdout.on("data", diagnostic);
    child.stderr.on("data", diagnostic);
    child.once("error", reject);
    child.once("close", (code, signal) => {
      options.signal?.removeEventListener("abort", abort);
      void (async () => {
        await stopping;
        options.signal?.throwIfAborted();
        if (code === 0) accept();
        else
          reject(
            new HostError(
              `ipab-prebuild failed (${signal ?? String(code)}); no CAR was generated.`,
            ),
          );
      })().catch(reject);
    });
  });
}
