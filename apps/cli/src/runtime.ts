import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile, unlink, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { IpfsStore } from "@ipab/ipfs-store";
import { HostError, message } from "./errors.js";
import { Ownership, saveHistory } from "./history.js";
import { ContextServer } from "./ipc.js";
import { loadApp, OutputSpace } from "./space.js";
import type { RunRecord, State } from "./state.js";
import { ExecutionLogs } from "./logs.js";

export interface Invocation {
  origin: "exec" | "open";
  appCid: string;
  argv: string[];
}
export interface ExecutionOptions {
  history: boolean;
  retain: boolean;
  diagnostic: (text: string) => void;
  log?: boolean;
  signal?: AbortSignal;
  inputSchema?: string;
}

export async function execute(
  state: State,
  store: IpfsStore,
  invocation: Invocation,
  options: ExecutionOptions,
): Promise<{ exitCode: number; record: RunRecord }> {
  if (options.log && !options.history)
    throw new HostError("Execution logging requires history.enabled=true.");
  const id = randomUUID();
  const session = `ipab-output:${state.identity}:${id}`;
  const record: RunRecord = {
    id,
    ...invocation,
    startedAt: new Date().toISOString(),
    endedAt: "",
    status: "failed",
    outputCid: null,
    appExitCode: null,
    error: null,
    retention: { owned: false, state: "none" },
  };
  const owner = await Ownership.create(state, store, `run:${id}`, session);
  const controller = new AbortController();
  const output = new OutputSpace(store, owner, session, controller.signal);
  let child: ChildProcess | undefined;
  let server: ContextServer | undefined;
  let timer: NodeJS.Timeout | undefined;
  let logs: ExecutionLogs | undefined;
  let forwarding: Promise<void>[] = [];
  let logFailure: unknown;
  let exitCode = 1;
  let cancellation = 0;
  let phase = "validation";
  const directory = join(state.directory, "runtime", id);
  const entry = join(directory, "app.cjs");
  let directoryCreated = false;
  let entryCreated = false;
  const stop = (error: Error, code = 1) => {
    controller.abort(error);
    if (code !== 1) cancellation = code;
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill(code === 130 ? "SIGINT" : "SIGTERM");
      timer ??= setTimeout(() => {
        child?.kill("SIGKILL");
      }, 2000);
      timer.unref();
    }
  };
  const interrupt = () => {
    stop(
      new HostError("Execution cancelled.", 130, "CANCELLED", "execution"),
      130,
    );
  };
  const terminate = () => {
    stop(
      new HostError("Execution cancelled.", 143, "CANCELLED", "execution"),
      143,
    );
  };
  const abort = () => {
    stop(
      new HostError("Execution cancelled.", 130, "CANCELLED", "execution"),
      130,
    );
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    if (options.signal?.aborted) abort();
    controller.signal.throwIfAborted();
    const app = await loadApp(
      invocation.appCid,
      store,
      owner,
      controller.signal,
    );
    if (
      invocation.origin === "open" &&
      !app.supportedSchemas.has(options.inputSchema ?? "")
    )
      throw new HostError(
        `Registered App ${invocation.appCid} does not declare support for Schema ${options.inputSchema ?? "(missing)"}. Rebuild the App with this complete definition in ipab.yaml supportedSchemas and update its pin/register association, or use ipab exec explicitly.`,
        1,
        "APP_SCHEMA_UNSUPPORTED",
        "validation",
      );
    phase = "startup";
    await mkdir(directory, { recursive: true });
    directoryCreated = true;
    await writeFile(entry, app.source, { flag: "wx", mode: 0o600 });
    entryCreated = true;
    controller.signal.throwIfAborted();
    if (options.log) {
      record.log = "incomplete";
      logs = await ExecutionLogs.create(state.directory, id);
    }
    child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL("../dist/child.js", import.meta.url)),
        entry,
        ...invocation.argv,
      ],
      {
        stdio: [
          "inherit",
          logs ? "pipe" : "inherit",
          logs ? "pipe" : "inherit",
          "ipc",
        ],
        serialization: "advanced",
        shell: false,
      },
    );
    if (logs) {
      forwarding = [
        logs.forward(child.stdout!, process.stdout, "stdout"),
        logs.forward(child.stderr!, process.stderr, "stderr"),
      ].map((task) =>
        task.catch((error: unknown) => {
          logFailure ??= error;
          stop(new HostError(`Execution logging failed: ${message(error)}`));
        }),
      );
    }
    server = new ContextServer(
      child,
      store,
      owner,
      output,
      (error) => {
        stop(error);
      },
      invocation.appCid,
      (name) => state.resolvePin(name),
    );
    const result = await new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve, reject) => {
      child!.once("error", reject);
      child!.once("close", (code, signal) => {
        resolve({ code, signal });
      });
    });
    record.appExitCode = result.code;
    await Promise.all(forwarding);
    if (logs) {
      await logs.close();
      logs = undefined;
      if (logFailure)
        throw new HostError(
          `Execution logging failed: ${message(logFailure)}`,
          1,
          "LOG_FAILED",
          "logging",
        );
      record.log = "complete";
    }
    phase = "execution";
    await server.close();
    server = undefined;
    if (controller.signal.aborted && !cancellation)
      controller.signal.throwIfAborted();
    if (cancellation || result.signal) {
      cancellation ||= result.signal === "SIGINT" ? 130 : 143;
      throw new HostError(
        "Execution cancelled.",
        cancellation,
        "CANCELLED",
        "execution",
      );
    }
    controller.signal.throwIfAborted();
    if (result.code !== 0)
      throw new HostError(
        `App exited with code ${result.code}.`,
        result.code ?? 1,
        "APP_EXIT",
        "execution",
      );
    phase = "commit";
    record.outputCid = await output.finalize();
    record.status = "succeeded";
    exitCode = 0;
  } catch (error) {
    const failure =
      error instanceof HostError
        ? error
        : new HostError(message(error), 1, "EXECUTION_FAILED", phase);
    record.status = cancellation ? "cancelled" : "failed";
    record.error = {
      phase: failure.phase === "state" ? phase : failure.phase,
      code: failure.code,
      message: message(failure),
    };
    exitCode =
      cancellation ||
      (record.appExitCode && record.appExitCode !== 0
        ? record.appExitCode
        : failure.exitCode);
    options.diagnostic(`Error: ${message(failure)}`);
  } finally {
    if (timer) clearTimeout(timer);
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
    options.signal?.removeEventListener("abort", abort);
    const cleanupError = (error: unknown, errorPhase: string) => {
      options.diagnostic(
        `Error: ${errorPhase} failed: ${message(error)} Ownership remains recoverable.`,
      );
      record.status = record.status === "cancelled" ? "cancelled" : "failed";
      record.error = {
        phase: errorPhase,
        code: "CLEANUP_FAILED",
        message: message(error),
      };
      if (exitCode === 0) exitCode = 1;
    };
    await Promise.all(forwarding);
    try {
      await logs?.close();
    } catch (error) {
      cleanupError(error, "logging");
    }
    try {
      await server?.close();
    } catch (error) {
      cleanupError(error, "cleanup");
    }
    try {
      if (entryCreated) await unlink(entry);
      if (directoryCreated) await rmdir(directory);
    } catch (error) {
      cleanupError(error, "cleanup");
    }
    record.endedAt = new Date().toISOString();
    try {
      if (options.history)
        await saveHistory(state, store, record, options.retain);
      else if (record.outputCid && options.retain)
        options.diagnostic(
          "History is disabled: output has no history-owned retention and may be reclaimed by its backend.",
        );
    } catch (error) {
      cleanupError(error, "history");
    }
    try {
      await owner.release();
    } catch (error) {
      cleanupError(error, "cleanup");
    }
    if (options.history) {
      // Do not resurrect a record concurrently removed after its committed publication.
      try {
        state.transaction(() => {
          if (state.db.prepare("SELECT id FROM runs WHERE id=?").get(id)) {
            const current = state.run(id);
            if (current.retention.state === "releasing")
              record.retention = current.retention;
            state.saveRun(record);
          }
        });
      } catch (error) {
        cleanupError(error, "history");
      }
      options.diagnostic(`Execution: ${id}`);
    }
    if (record.outputCid) options.diagnostic(`Output: ${record.outputCid}`);
  }
  return { exitCode, record };
}
