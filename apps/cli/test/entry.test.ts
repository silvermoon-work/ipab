import { afterEach, describe, expect, it, vi } from "vitest";
import { symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fixture } from "./helpers.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("executable entry contracts", () => {
  it.skipIf(process.platform === "win32")(
    "runs the built CLI directly through a symlink without a Node wrapper",
    async () => {
      const work = await fixture();
      try {
        const command = join(work.root, "ipab");
        await symlink(resolve("dist", "main.js"), command);
        const { stdout, stderr } = await promisify(execFile)(command, [
          "--help",
        ]);
        expect(stdout).toContain("ipab");
        expect(stderr).toMatch(
          /^(?:\(node:\d+\) ExperimentalWarning: SQLite is an experimental feature and might change at any time\n\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)\n)?$/,
        );
      } finally {
        await work.cleanup();
      }
    },
  );

  it("bootstrap supplies context separately and preserves actual application argv", async () => {
    const work = await fixture();
    const argv = process.argv;
    const send = Object.getOwnPropertyDescriptor(process, "send");
    const channel = Object.getOwnPropertyDescriptor(process, "channel");
    const messages = new Set(process.listeners("message"));
    const disconnect = new Set(process.listeners("disconnect"));
    try {
      process.argv = [process.execPath, "bootstrap"];
      await expect(import("../src/child.js")).rejects.toThrow(
        "dedicated context channel",
      );
      vi.resetModules();
      const entry = join(work.root, "app.cjs");
      await writeFile(
        entry,
        "globalThis.__ipabTest = { argv: process.argv.slice(2), context: typeof ipab.readFile, entry: process.argv[1] };",
      );
      process.argv = [
        process.execPath,
        "bootstrap",
        entry,
        "--help",
        "--",
        "a b",
      ];
      const sendFrame = vi.fn(
        (
          frame: { id: number; operation: string },
          callback: (error: Error | null) => void,
        ) => {
          process.emit(
            "message",
            {
              version: 1,
              id: frame.id,
              result: frame.operation === "identity" ? "app-identity" : null,
            },
            undefined,
          );
          callback(null);
        },
      );
      Object.defineProperty(process, "send", {
        configurable: true,
        writable: true,
        value: sendFrame,
      });
      Object.defineProperty(process, "channel", {
        configurable: true,
        writable: true,
        value: { ref: vi.fn(), unref: vi.fn() },
      });
      await import("../src/child.js");
      expect((globalThis as Record<string, unknown>).__ipabTest).toEqual({
        argv: ["--help", "--", "a b"],
        context: "function",
        entry,
      });
      await globalThis.ipab.output.link("file", "identity");
      expect(sendFrame).toHaveBeenCalledWith(
        expect.objectContaining({ operation: "link" }),
        expect.any(Function),
      );
      process.emit("disconnect");
    } finally {
      process.argv = argv;
      if (send) Object.defineProperty(process, "send", send);
      else Reflect.deleteProperty(process, "send");
      if (channel) Object.defineProperty(process, "channel", channel);
      else Reflect.deleteProperty(process, "channel");
      for (const listener of process.listeners("message"))
        if (!messages.has(listener)) process.off("message", listener);
      for (const listener of process.listeners("disconnect"))
        if (!disconnect.has(listener)) process.off("disconnect", listener);
      Reflect.deleteProperty(globalThis, "__ipabTest");
      await work.cleanup();
    }
  });

  it("main propagates the CLI status without inventing success", async () => {
    const code = process.exitCode;
    const argv = process.argv;
    const run = vi.fn().mockResolvedValue(7);
    vi.doMock("../src/cli.js", () => ({ runCli: run }));
    try {
      process.argv = [process.execPath, "main", "exec", "identity", "--help"];
      await import("../src/main.js");
      expect(run).toHaveBeenCalledWith(["exec", "identity", "--help"]);
      expect(process.exitCode).toBe(7);
    } finally {
      process.argv = argv;
      process.exitCode = code;
      vi.doUnmock("../src/cli.js");
    }
  });

  it("process IO sends primary output and diagnostics to distinct streams; confirmation closes its reader", async () => {
    const question = vi
      .fn()
      .mockResolvedValueOnce("yes")
      .mockRejectedValueOnce(new Error("input failed"));
    const close = vi.fn();
    vi.doMock("node:readline/promises", () => ({
      createInterface: () => ({ question, close }),
    }));
    vi.resetModules();
    try {
      const { processIO } = await import("../src/cli.js");
      const stdout = vi
        .spyOn(process.stdout, "write")
        .mockImplementation(() => true);
      const stderr = vi
        .spyOn(process.stderr, "write")
        .mockImplementation(() => true);
      processIO.out("value");
      processIO.err("diagnostic");
      expect(stdout).toHaveBeenCalledWith("value\n");
      expect(stderr).toHaveBeenCalledWith("diagnostic\n");
      expect(await processIO.confirm("delete?")).toBe(true);
      await expect(processIO.confirm("delete?")).rejects.toThrow(
        "input failed",
      );
      expect(close).toHaveBeenCalledTimes(2);
    } finally {
      vi.doUnmock("node:readline/promises");
    }
  });
});
