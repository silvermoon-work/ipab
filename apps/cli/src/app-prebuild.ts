import { execFile, spawn } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { StringDecoder } from "node:string_decoder";
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
    (build.includeSource !== undefined &&
      typeof build.includeSource !== "boolean") ||
    Object.keys(build).some(
      (key) => !["strategy", "typecheck", "includeSource"].includes(key),
    )
  )
    throw new HostError(
      "App build accepts only strategy, typecheck and boolean includeSource.",
    );
  if (build.strategy === undefined && build.typecheck === undefined)
    return undefined;
  if (
    build.strategy !== "ipab-prebuild" ||
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
  let chain: unknown;
  try {
    chain = inherited ? JSON.parse(inherited) : [];
  } catch (cause) {
    const error = new HostError("Invalid IPAB_BUILD_CHAIN.");
    error.cause = cause;
    throw error;
  }
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
  const inherited = process.env.npm_execpath;
  const runnerName = (entry: string) => {
    const file = basename(entry);
    if (["npm-cli.js", "npm"].includes(file)) return "npm";
    if (["pnpm.cjs", "pnpm.mjs", "pnpm.js", "pnpm.exe", "pnpm"].includes(file))
      return "pnpm";
    return undefined;
  };
  const name =
    typeof declaration === "string"
      ? declaration.startsWith("pnpm@")
        ? "pnpm"
        : "npm"
      : (inherited && runnerName(inherited)) || "npm";
  const suffixes = name === "npm" ? ["npm-cli.js"] : ["pnpm.mjs", "pnpm.cjs"];
  const candidates = [
    ...(inherited && runnerName(inherited) === name ? [inherited] : []),
    ...[dirname(process.execPath), ...(process.env.PATH ?? "").split(delimiter)]
      .filter(Boolean)
      .flatMap((directory) => [
        ...suffixes.map((suffix) =>
          join(directory, "node_modules", name, "bin", suffix),
        ),
        join(directory, process.platform === "win32" ? `${name}.exe` : name),
      ]),
  ];
  for (const candidate of candidates) {
    try {
      const entry = await realpath(candidate);
      if (runnerName(entry) !== name) continue;
      if ((await lstat(entry)).isFile()) {
        const native = !/\.(?:js|cjs|mjs)$/.test(entry);
        if (!native) {
          const owner = object(
            JSON.parse(
              await readFile(
                join(dirname(entry), "..", "package.json"),
                "utf8",
              ),
            ) as unknown,
            "Package manager",
          );
          if (owner.name !== name) continue;
        }
        if (typeof declaration === "string") {
          const expected = declaration.split("@")[1]!.split("+")[0];
          const versionArgs = [
            ...(name === "pnpm"
              ? ["--config.manage-package-manager-versions=false"]
              : []),
            "--version",
          ];
          const { stdout } = await promisify(execFile)(
            native ? entry : process.execPath,
            native ? versionArgs : [entry, ...versionArgs],
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
    `Could not locate ${name}'s CLI. Corepack shims are not executed. Run ipab through ${name} exec, or explicitly install the project's declared package manager.`,
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
      : [
          "--config.manage-package-manager-versions=false",
          "--config.enable-pre-post-scripts=false",
          "run",
          "ipab-prebuild",
        ];
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
    let failure: Error | undefined;
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
      void stopping.catch((error: unknown) => {
        failure =
          error instanceof Error
            ? error
            : new Error("Could not stop ipab-prebuild.", { cause: error });
      });
    };
    const fail = (error: unknown) => {
      failure ??=
        error instanceof Error
          ? error
          : new Error("ipab-prebuild diagnostic failed.", { cause: error });
      abort();
    };
    const diagnostic = (text: string) => {
      if (!text || failure) return;
      try {
        if (options.diagnostic) options.diagnostic(text.trimEnd());
        else process.stderr.write(text);
      } catch (error) {
        fail(error);
      }
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    for (const stream of [child.stdout, child.stderr]) {
      const decoder = new StringDecoder("utf8");
      stream.on("data", (bytes: Buffer) => {
        diagnostic(decoder.write(bytes));
      });
      stream.once("end", () => {
        diagnostic(decoder.end());
      });
      stream.once("error", fail);
    }
    child.once("error", fail);
    child.once("close", (code, signal) => {
      options.signal?.removeEventListener("abort", abort);
      void (async () => {
        await stopping;
        if (failure) throw failure;
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
