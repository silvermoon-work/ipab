import { afterEach, describe, expect, it, vi } from "vitest";
import { spawn, execFile } from "node:child_process";
import type * as ChildProcesses from "node:child_process";
import { runNode } from "../src/setup.js";
import type * as FileSystem from "node:fs/promises";

vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof FileSystem>()),
  writeFile: vi.fn(() => Promise.resolve()),
  rm: vi.fn(() => Promise.resolve()),
}));

const scenario = vi.hoisted<{
  code: number | null;
  signal: NodeJS.Signals | null;
  cancel: boolean;
  fail: boolean;
  pid: number | undefined;
}>(() => ({
  code: 0,
  signal: null,
  cancel: false,
  fail: false,
  pid: 100_007,
}));
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof ChildProcesses>();
  return {
    ...actual,
    spawn: vi.fn(() => {
      const child = new actual.ChildProcess();
      Object.defineProperty(child, "pid", { value: scenario.pid });
      queueMicrotask(() => {
        if (scenario.cancel) {
          process.listeners("SIGINT").at(-1)?.("SIGINT");
          process.listeners("SIGINT").at(-1)?.("SIGINT");
        }
        if (scenario.fail) child.emit("error", new Error("spawn failed"));
        child.emit("close", scenario.code, scenario.signal);
      });
      return child;
    }),
    execFile: vi.fn(
      (
        _file: string,
        _args: string[],
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        callback(null, "", "");
      },
    ),
  };
});
const exitCode = process.exitCode;
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
afterEach(() => {
  process.exitCode = exitCode;
  scenario.code = 0;
  scenario.signal = null;
  scenario.cancel = false;
  scenario.fail = false;
  scenario.pid = 100_007;
  Object.defineProperty(process, "platform", platform);
  vi.clearAllMocks();
});

describe("App subprocess lifecycle", { tags: ["mock"] }, () => {
  it("uses the current Node, stderr diagnostics and no shell; removes lifecycle listeners", async () => {
    const before = process.listenerCount("SIGINT");
    await runNode("entry.js", ["dev", "--local"], "working");
    expect(spawn).toHaveBeenCalledWith(
      process.execPath,
      [
        "--require",
        expect.stringContaining(".ipab-parent-guard.cjs"),
        "entry.js",
        "dev",
        "--local",
      ],
      expect.objectContaining({
        cwd: "working",
        shell: false,
        stdio: ["inherit", 2, 2, "ipc"],
      }),
    );
    expect(process.listenerCount("SIGINT")).toBe(before);
  });
  it("reports nonzero exits, signals and spawn failures rather than succeeding", async () => {
    scenario.code = 7;
    await expect(runNode("entry", [], ".")).rejects.toThrow("7");
    expect(process.exitCode).toBe(7);
    scenario.signal = "SIGTERM";
    await expect(runNode("entry", [], ".")).rejects.toThrow("SIGTERM");
    scenario.fail = true;
    await expect(runNode("entry", [], ".")).rejects.toThrow("spawn failed");
    scenario.fail = false;
    scenario.code = null;
    scenario.signal = null;
    await expect(runNode("entry", [], ".")).rejects.toThrow("unknown");
  });
  it("terminates the subprocess tree on cancellation and waits for its close", async () => {
    scenario.cancel = true;
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    try {
      await expect(runNode("entry", [], ".")).rejects.toThrow("failed");
      expect(process.exitCode).toBe(130);
      if (process.platform === "win32")
        expect(execFile).toHaveBeenCalledWith(
          expect.stringContaining("taskkill.exe"),
          ["/PID", "100007", "/T", "/F"],
          expect.any(Function),
        );
      else expect(kill).toHaveBeenCalledWith(-100_007, "SIGTERM");
    } finally {
      kill.mockRestore();
    }
  });
  it("handles disappeared Unix process groups and surfaces termination failures", async () => {
    Object.defineProperty(process, "platform", { ...platform, value: "linux" });
    scenario.cancel = true;
    const kill = vi.spyOn(process, "kill");
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      kill.mockImplementation(() => {
        throw Object.assign(new Error("gone"), { code: "ESRCH" });
      });
      await expect(runNode("entry", [], ".")).rejects.toThrow("failed");
      kill.mockImplementation(() => {
        throw Object.assign(new Error("denied"), { code: "EACCES" });
      });
      await expect(runNode("entry", [], ".")).rejects.toThrow("denied");
      expect(diagnostic).toHaveBeenCalled();
      scenario.pid = undefined;
      await expect(runNode("entry", [], ".")).rejects.toThrow("failed");
    } finally {
      kill.mockRestore();
      diagnostic.mockRestore();
    }
  });
});
