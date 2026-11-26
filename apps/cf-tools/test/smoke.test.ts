import { describe, expect, it } from "vitest";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

const execute = promisify(execFile);
const cli = fileURLToPath(new URL("../../cli/dist/main.js", import.meta.url));
const root = fileURLToPath(new URL("../../../", import.meta.url));

async function port(): Promise<number> {
  const server = createServer();
  await new Promise<void>((accept) => {
    server.listen(0, "127.0.0.1", accept);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test port.");
  await new Promise<void>((accept, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else accept();
    });
  });
  return address.port;
}

async function waitForReleasedPort(listen: number): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const server = createServer();
    try {
      await new Promise<void>((accept, reject) => {
        server.once("error", reject);
        server.listen(listen, "127.0.0.1", accept);
      });
      await new Promise<void>((accept) => {
        server.close(() => {
          accept();
        });
      });
      return;
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "EADDRINUSE"
      )
        throw error;
      await delay(100);
    }
  }
  throw new Error("Worker subprocess survived App termination.");
}

async function stopApp(cliPid: number): Promise<void> {
  const { stdout } = await execute("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `Get-CimInstance Win32_Process -Filter "ParentProcessId = ${cliPid}" | Select-Object -ExpandProperty ProcessId`,
  ]);
  const appPid = stdout.trim();
  if (!/^\d+$/u.test(appPid))
    throw new Error("Could not identify App subprocess.");
  // Kill only the bootstrap; its Wrangler descendants must stop themselves.
  await execute("taskkill.exe", ["/PID", appPid, "/F"]);
}

describe("Worker Bundle execution", { tags: ["release-e2e"] }, () => {
  it("self-installs, starts the actual local Worker and dry-runs the same CID", async () => {
    const temp = await mkdtemp(join(tmpdir(), "ipab-cf-smoke-"));
    const state = join(temp, "state");
    const env = {
      ...process.env,
      IPAB_APP_INSTALL_ROOT: join(temp, "installs"),
      TEMP: temp,
      TMP: temp,
      TMPDIR: temp,
    };
    const run = (args: string[]) =>
      execute(process.execPath, [cli, "--state-dir", state, ...args], {
        env,
        timeout: 180_000,
        maxBuffer: 4 * 1024 * 1024,
      });
    try {
      for (const file of [
        join(root, "packages", "pointer-worker", "dist", "worker.car"),
        join(root, "apps", "cf-tools", "dist", "cf-local.car"),
        join(root, "apps", "cf-tools", "dist", "cf-deploy.car"),
      ])
        await run(["bundle", "import", file]);
      const worker = (
        await readFile(
          join(root, "packages", "pointer-worker", "dist", "worker.cid"),
          "utf8",
        )
      ).trim();
      const local = (
        await readFile(
          join(root, "apps", "cf-tools", "dist", "cf-local.cid"),
          "utf8",
        )
      ).trim();
      const deploy = (
        await readFile(
          join(root, "apps", "cf-tools", "dist", "cf-deploy.cid"),
          "utf8",
        )
      ).trim();
      const listen = await port();
      const child = spawn(
        process.execPath,
        [
          cli,
          "--state-dir",
          state,
          "exec",
          local,
          worker,
          "--port",
          String(listen),
          "--state-dir",
          join(temp, "worker-state"),
        ],
        { env, stdio: ["ignore", "pipe", "pipe"] },
      );
      let logs = "";
      try {
        await new Promise<void>((accept, reject) => {
          const timeout = setTimeout(() => {
            reject(new Error(`Local startup timed out:\n${logs}`));
          }, 180_000);
          const receive = (chunk: Buffer) => {
            logs += chunk.toString();
            if (logs.includes(`Ready on http://127.0.0.1:${listen}`)) {
              clearTimeout(timeout);
              accept();
            }
          };
          child.stdout.on("data", receive);
          child.stderr.on("data", receive);
          child.once("error", (error) => {
            clearTimeout(timeout);
            reject(error);
          });
          child.once("exit", (code) => {
            clearTimeout(timeout);
            reject(new Error(`Local App exited ${code}:\n${logs}`));
          });
        });
        const response = await fetch(`http://127.0.0.1:${listen}/_health`);
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ ok: true, protocol: 2 });
      } finally {
        if (child.pid && child.exitCode === null) {
          const closed = new Promise<void>((accept) => {
            child.once("close", () => {
              accept();
            });
          });
          if (process.platform === "win32") {
            await stopApp(child.pid);
          } else child.kill("SIGTERM");
          await closed;
          await waitForReleasedPort(listen);
        }
      }
      const target = join(temp, "target.json");
      await writeFile(
        target,
        JSON.stringify({
          name: "ipab-pointer-smoke",
          account_id: "a".repeat(32),
          vars: {
            POINTER_SERVICE: "https://pointers.example.com",
            ALLOWED_ORIGIN: "",
          },
        }),
      );
      const result = await run(["exec", deploy, worker, "--target", target]);
      expect(result.stderr).toContain("--dry-run: exiting now");
      expect(result.stderr).toContain("PointerObject");
      expect(result.stderr).toContain("RegistryObject");
      expect(result.stderr).toContain("Output:");
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  }, 420_000);
});
