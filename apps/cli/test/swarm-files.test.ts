import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import type * as FsModule from "node:fs/promises";
import type * as IdentityModule from "../src/identity.js";
import {
  privateDirectory,
  readPrivate,
  withPrivateLock,
  writePrivate,
} from "../src/swarm-files.js";

const ports = vi.hoisted(() => ({
  protect: vi.fn<(path: string, directory?: boolean) => Promise<void>>(),
  secure: vi.fn<(path: string, directory?: boolean) => Promise<void>>(),
  exec: vi.fn<(sql: string) => void>(),
  close: vi.fn<() => void>(),
  inspectError: undefined as Error | undefined,
  unlinkError: undefined as Error | undefined,
}));
vi.mock("../src/identity.js", async () => ({
  ...(await vi.importActual<typeof IdentityModule>("../src/identity.js")),
  protectedPath: ports.protect,
  secureNew: ports.secure,
}));
vi.mock("node:sqlite", () => ({
  DatabaseSync: class {
    exec(sql: string) {
      ports.exec(sql);
    }
    close() {
      ports.close();
    }
  },
}));
vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof FsModule>("node:fs/promises");
  return {
    ...actual,
    lstat: (path: string) => {
      if (ports.inspectError) return Promise.reject(ports.inspectError);
      return actual.lstat(path);
    },
    unlink: (path: string) => {
      if (ports.unlinkError) return Promise.reject(ports.unlinkError);
      return actual.unlink(path);
    },
  };
});
const failure = (code: string) => Object.assign(new Error(code), { code });
describe(
  "protected Swarm files and transaction locks",
  { tags: ["mock"] },
  () => {
    let directory: string;
    beforeEach(async () => {
      vi.resetAllMocks();
      ports.inspectError = undefined;
      ports.unlinkError = undefined;
      ports.protect.mockResolvedValue();
      ports.secure.mockResolvedValue();
      const root = resolve(".test-work");
      await mkdir(root, { recursive: true });
      directory = await mkdtemp(join(root, "swarm-files-"));
    });
    afterEach(async () => {
      ports.inspectError = undefined;
      ports.unlinkError = undefined;
      vi.useRealTimers();
      await rm(directory, { recursive: true, force: true });
    });
    it("creates only absent private directories and rejects permission/ownership failures", async () => {
      const created = await privateDirectory(directory, "credentials");
      expect(await privateDirectory(directory, "credentials")).toBe(created);
      expect(ports.secure).toHaveBeenCalledTimes(1);
      ports.inspectError = failure("EACCES");
      await expect(
        privateDirectory(directory, "blocked"),
      ).rejects.toMatchObject({ code: "EACCES" });
      ports.inspectError = undefined;
      ports.protect.mockRejectedValueOnce(new Error("not account owned"));
      await expect(privateDirectory(directory, "credentials")).rejects.toThrow(
        "account owned",
      );
    });
    it("distinguishes absent credentials from malformed, oversized or unreadable state", async () => {
      ports.protect.mockRejectedValueOnce(failure("ENOENT"));
      expect(await readPrivate(directory, "absent")).toBeUndefined();
      ports.protect.mockRejectedValueOnce(failure("EACCES"));
      await expect(readPrivate(directory, "secret")).rejects.toMatchObject({
        code: "EACCES",
      });
      await writeFile(join(directory, "bad"), "{");
      await expect(readPrivate(directory, "bad")).rejects.toThrow();
      await writeFile(
        join(directory, "large"),
        "x".repeat(2 * 1024 * 1024 + 1),
      );
      await expect(readPrivate(directory, "large")).rejects.toThrow(
        "oversized",
      );
      await writeFile(join(directory, "valid"), '{"request":"exact"}');
      expect(await readPrivate(directory, "valid")).toEqual({
        request: "exact",
      });
    });
    it("atomically replaces state while failed protection or rename preserves the old target and cleans its temporary file", async () => {
      await writePrivate(directory, "record", { epoch: 1 });
      await writePrivate(directory, "record", { epoch: 2 });
      expect(
        JSON.parse(
          await readFile(join(directory, "record"), "utf8"),
        ) as unknown,
      ).toEqual({ epoch: 2 });
      ports.secure.mockRejectedValueOnce(new Error("protection failed"));
      await expect(
        writePrivate(directory, "record", { epoch: 3 }),
      ).rejects.toThrow("protection failed");
      expect(await readdir(directory)).toEqual(["record"]);
      await mkdir(join(directory, "cannot-replace"));
      await expect(
        writePrivate(directory, "cannot-replace", {}),
      ).rejects.toThrow();
      expect(
        (await readdir(directory)).some((name) => name.startsWith(".write-")),
      ).toBe(false);
    });
    it("does not hide a temporary-file cleanup failure", async () => {
      ports.secure.mockRejectedValueOnce(new Error("write failed"));
      ports.unlinkError = failure("EACCES");
      await expect(writePrivate(directory, "record", {})).rejects.toMatchObject(
        { code: "EACCES" },
      );
      ports.unlinkError = undefined;
    });
    it("rolls back and closes an acquired lock even when the operation fails, and treats existing lock files as normal", async () => {
      await expect(
        withPrivateLock(directory, () =>
          Promise.reject(new Error("operation failed")),
        ),
      ).rejects.toThrow("operation failed");
      expect(ports.exec).toHaveBeenCalledWith("ROLLBACK");
      expect(ports.close).toHaveBeenCalledOnce();
      expect(
        await withPrivateLock(directory, () => Promise.resolve("recovered")),
      ).toBe("recovered");
      ports.protect.mockRejectedValueOnce(new Error("untrusted lock"));
      await expect(
        withPrivateLock(directory, () => Promise.resolve()),
      ).rejects.toThrow("untrusted lock");
    });
    it("waits for lock contention but never retries unrelated database failures", async () => {
      ports.exec
        .mockImplementationOnce(() => {})
        .mockImplementationOnce(() => {
          throw new Error("database is locked");
        });
      vi.useFakeTimers();
      const operation = withPrivateLock(directory, () =>
        Promise.resolve("ready"),
      );
      await vi.waitFor(() => {
        expect(ports.exec).toHaveBeenCalledWith("BEGIN IMMEDIATE");
      });
      await vi.advanceTimersByTimeAsync(100);
      expect(await operation).toBe("ready");
      ports.exec.mockImplementation((sql) => {
        if (sql === "BEGIN IMMEDIATE") throw new Error("database corrupt");
      });
      await expect(
        withPrivateLock(directory, () => Promise.resolve()),
      ).rejects.toThrow("database corrupt");
      await expect(
        withPrivateLock(join(directory, "absent-parent"), () =>
          Promise.resolve(),
        ),
      ).rejects.toMatchObject({ code: "ENOENT" });
    });
    it("fails closed after bounded lock contention and closes the connection without rolling back an unacquired lock", async () => {
      vi.useFakeTimers();
      ports.exec.mockImplementation((sql) => {
        if (sql === "BEGIN IMMEDIATE") throw new Error("database is locked");
      });
      const result = withPrivateLock(directory, () => Promise.resolve()).catch(
        (cause: unknown) => cause,
      );
      await vi.waitFor(() => {
        expect(ports.exec).toHaveBeenCalledWith("BEGIN IMMEDIATE");
      });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await result).toBeInstanceOf(Error);
      expect(ports.exec).not.toHaveBeenCalledWith("ROLLBACK");
      expect(ports.close).toHaveBeenCalledOnce();
    });
  },
);
