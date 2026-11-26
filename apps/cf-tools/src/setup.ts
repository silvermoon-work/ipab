import { spawn, execFile } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  rename,
  rm,
  writeFile,
  readFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { CID } from "multiformats/cid";
import { DatabaseSync } from "node:sqlite";
import payload from "../payload/package.json" with { type: "json" };

export interface Files {
  appCid: string;
  readFile(cid: string, path: string): Promise<ReadableStream<Uint8Array>>;
}

export function nodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

export async function bytes(
  stream: ReadableStream<Uint8Array>,
  maximum = 16 * 1024 * 1024,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.length;
      if (size > maximum) throw new Error("Bundle file exceeds byte budget.");
      chunks.push(next.value);
    }
  } catch (error) {
    await reader.cancel(error);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

export async function pnpmEntry(): Promise<string> {
  const expected = payload.packageManager.slice("pnpm@".length);
  const override = process.env.IPAB_PNPM_CLI;
  const directories = [
    process.env.PNPM_HOME,
    dirname(process.execPath),
    ...(process.env.PATH ?? "").split(delimiter),
  ].filter((path): path is string => Boolean(path));
  const candidates = [
    ...(override
      ? [resolve(override)]
      : [
          ...(process.env.npm_execpath ? [process.env.npm_execpath] : []),
          ...directories.flatMap((path) => [
            join(path, "pnpm.exe"),
            ...["pnpm.mjs", "pnpm.cjs"].flatMap((file) => [
              join(path, "node_modules", "pnpm", "bin", file),
              join(path, "..", "lib", "node_modules", "pnpm", "bin", file),
              join(
                path,
                ".tools",
                "pnpm",
                expected,
                "node_modules",
                "pnpm",
                "bin",
                file,
              ),
            ]),
          ]),
        ]),
  ];
  for (const candidate of candidates) {
    const native = /pnpm\.exe$/u.test(candidate);
    if (!native && !/pnpm\.(?:mjs|cjs)$/u.test(candidate)) {
      if (override)
        throw new Error(
          "IPAB_PNPM_CLI must name an installed pnpm.mjs/pnpm.cjs or official pnpm.exe, not a Corepack shim.",
        );
      continue;
    }
    try {
      if (!(await lstat(candidate)).isFile()) continue;
      const manifest: unknown = JSON.parse(
        await readFile(
          join(dirname(candidate), ...(native ? [] : [".."]), "package.json"),
          "utf8",
        ),
      );
      if (
        !manifest ||
        typeof manifest !== "object" ||
        !("name" in manifest) ||
        manifest.name !== (native ? "@pnpm/exe" : "pnpm")
      )
        throw new Error("pnpm CLI must belong to an installed pnpm package.");
      const { stdout } = await promisify(execFile)(
        native ? candidate : process.execPath,
        [
          ...(native ? [] : [candidate]),
          "--config.manage-package-manager-versions=false",
          "--version",
        ],
        { env: { ...process.env, COREPACK_ENABLE_NETWORK: "0" } },
      );
      if (stdout.trim() !== expected)
        throw new Error(
          `App requires pnpm ${expected}; found ${stdout.trim()}. Set IPAB_PNPM_CLI to the exact installed version.`,
        );
      return resolve(candidate);
    } catch (error) {
      if (override) throw error;
      if (!nodeError(error, "ENOENT") && !nodeError(error, "ENOTDIR"))
        throw error;
    }
  }
  throw new Error(
    `pnpm ${expected} CLI not found. Install it explicitly or set IPAB_PNPM_CLI to its pnpm.mjs/pnpm.cjs or official pnpm.exe. Automatic downloads are disabled.`,
  );
}

export async function runNode(
  entry: string,
  args: string[],
  cwd: string,
): Promise<void> {
  const guard = join(resolve(cwd), ".ipab-parent-guard.cjs");
  await writeFile(
    guard,
    `
const parentPid = process.ppid;
process.once("disconnect", () => {
  try {
    process.kill(parentPid, 0);
    return;
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
  if (process.platform === "win32") {
    require("node:child_process").execFileSync(
      require("node:path").join(process.env.SystemRoot || "C:\\\\Windows", "System32", "taskkill.exe"),
      ["/PID", String(process.pid), "/T", "/F"]
    );
  } else {
    process.kill(-process.pid, "SIGKILL");
  }
});
process.channel?.unref();
`,
  );
  try {
    await new Promise<void>((accept, reject) => {
      const child = spawn(
        process.execPath,
        /pnpm\.exe$/u.test(entry)
          ? [
              "--require",
              guard,
              "-e",
              `
const child = require("node:child_process").spawn(process.argv[1], process.argv.slice(2), { stdio: "inherit", shell: false });
child.once("error", error => { console.error(error.message); process.exitCode = 1; });
child.once("close", code => { process.exitCode = code ?? 1; });
`,
              "--",
              entry,
              ...args,
            ]
          : ["--require", guard, entry, ...args],
        {
          cwd,
          env: {
            ...process.env,
            NPM_CONFIG_ENGINE_STRICT: "true",
            WRANGLER_SEND_METRICS: "false",
          },
          stdio: ["inherit", 2, 2, "ipc"],
          shell: false,
          detached: process.platform !== "win32",
        },
      );
      let cancelled = false;
      let stopping: Promise<void> | undefined;
      const stop = () => {
        cancelled = true;
        if (!child.pid || stopping) return;
        const pid = child.pid;
        stopping = (async () => {
          if (process.platform === "win32") {
            await promisify(execFile)(
              join(
                process.env.SystemRoot ?? "C:\\Windows",
                "System32",
                "taskkill.exe",
              ),
              ["/PID", String(pid), "/T", "/F"],
            );
          } else {
            try {
              process.kill(-pid, "SIGTERM");
            } catch (error) {
              if (!nodeError(error, "ESRCH")) throw error;
            }
          }
        })();
        void stopping.catch((error: unknown) => {
          console.error("Unable to stop App subprocess:", error);
        });
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      process.once("disconnect", stop);
      child.once("error", reject);
      child.once("close", (code, signal) => {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
        process.off("disconnect", stop);
        void (async () => {
          await stopping;
          if (cancelled || code !== 0) {
            process.exitCode = cancelled ? 130 : (code ?? 1);
            throw new Error(
              `App subprocess failed (${signal ?? code ?? "unknown"}).`,
            );
          }
          accept();
        })().catch(reject);
      });
    });
  } finally {
    await rm(guard, { force: true });
  }
}

export async function withInstallation<T>(
  files: Files,
  reinstall: boolean,
  use: (directory: string) => Promise<T>,
  install = runNode,
): Promise<T> {
  const cid = CID.parse(files.appCid).toV1().toString();
  const root = resolve(
    process.env.IPAB_APP_INSTALL_ROOT ??
      join(homedir(), ".ipab", "app-installs"),
    cid,
    `${process.platform}-${process.arch}-${process.version}`,
  );
  await mkdir(root, { recursive: true, mode: 0o700 });
  const lock = join(root, "installation-lock.sqlite");
  const database = new DatabaseSync(lock);
  try {
    database.exec("PRAGMA busy_timeout=0; BEGIN");
    database.prepare("SELECT name FROM sqlite_schema").all();
  } catch (error) {
    database.close();
    if (error instanceof Error && "errcode" in error && error.errcode === 5)
      throw new Error(
        `App installation is busy: another process is using ${root}. Stop it before retrying.`,
        { cause: error },
      );
    throw error;
  }
  const directory = join(root, "package");
  try {
    let ready = false;
    try {
      ready = (await lstat(join(directory, ".ready"))).isFile();
    } catch (error) {
      if (!nodeError(error, "ENOENT")) throw error;
    }
    if (!ready || reinstall) {
      try {
        database.exec("ROLLBACK; BEGIN EXCLUSIVE");
      } catch (error) {
        if (error instanceof Error && "errcode" in error && error.errcode === 5)
          throw new Error(
            "App installation is busy: stop running instances before installing or reinstalling.",
            { cause: error },
          );
        throw error;
      }
      const stage = await mkdtemp(join(root, ".setup-"));
      try {
        for (const file of [
          "package.json",
          "pnpm-lock.yaml",
          "pnpm-workspace.yaml",
        ])
          await writeFile(
            join(stage, file),
            await bytes(
              await files.readFile(files.appCid, `resources/payload/${file}`),
            ),
          );
        console.error(
          "Installing App dependencies with pnpm and the active registry.",
        );
        await install(
          await pnpmEntry(),
          [
            "--config.manage-package-manager-versions=false",
            "install",
            "--frozen-lockfile",
            "--prod",
          ],
          stage,
        );
        await writeFile(join(stage, ".ready"), "ready\n");
        const previous = join(root, "previous");
        let moved = false;
        try {
          await rename(directory, previous);
          moved = true;
        } catch (error) {
          if (!nodeError(error, "ENOENT")) throw error;
        }
        try {
          await rename(stage, directory);
        } catch (error) {
          if (moved) await rename(previous, directory);
          throw error;
        }
        if (moved) await rm(previous, { recursive: true });
      } finally {
        await rm(stage, { recursive: true, force: true });
      }
      database.exec("COMMIT; BEGIN");
      database.prepare("SELECT name FROM sqlite_schema").all();
    }
    return await use(directory);
  } finally {
    database.close();
  }
}
