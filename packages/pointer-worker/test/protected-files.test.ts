import { beforeEach, describe, expect, it, vi } from "vitest";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import {
  requireAccountOnly,
  readProtected,
  saveProtected,
  type FileAccessIO,
} from "../src/protected-files.ts";
import { runtime } from "../src/node-runtime.ts";

vi.mock("node:fs/promises", () => ({
  lstat: vi.fn(),
  mkdir: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
}));
vi.mock("node:child_process", () => ({
  execFile: vi.fn(
    (
      _command: string,
      _args: string[],
      _options: unknown,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      callback(null, "", "");
    },
  ),
}));
const regular = (mode = 0o600, uid = 1000) => ({
  mode,
  uid,
  isFile: () => true,
  isDirectory: () => false,
  isSymbolicLink: () => false,
});
describe("account-only secret files", { tags: ["mock"] }, () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(lstat).mockResolvedValue(
      regular() as Awaited<ReturnType<typeof lstat>>,
    );
    vi.mocked(readFile).mockResolvedValue("protected");
    vi.mocked(writeFile).mockResolvedValue();
    vi.mocked(mkdir).mockResolvedValue(undefined);
  });
  it("requires owner-only Unix permissions and the correct UID; rejects links and special paths", async () => {
    const acl = vi.fn<FileAccessIO["acl"]>().mockResolvedValue();
    const io: FileAccessIO = {
      platform: "linux",
      uid: 1000,
      acl,
      inspect: () => Promise.resolve(regular()),
    };
    await expect(requireAccountOnly("secret", io)).resolves.toBeUndefined();
    for (const info of [
      regular(0o644),
      regular(0o600, 2000),
      { ...regular(), isSymbolicLink: () => true },
      { ...regular(), isFile: () => false },
    ]) {
      await expect(
        requireAccountOnly("secret", {
          ...io,
          inspect: () => Promise.resolve(info),
        }),
      ).rejects.toThrow();
    }
    expect(acl).not.toHaveBeenCalled();
  });
  it("checks Windows ACLs and propagates fail-closed ACL errors", async () => {
    const acl = vi.fn<FileAccessIO["acl"]>().mockResolvedValue();
    const io: FileAccessIO = {
      platform: "win32",
      uid: undefined,
      acl,
      inspect: () => Promise.resolve(regular()),
    };
    await requireAccountOnly("secret", io);
    expect(acl).toHaveBeenCalledWith("secret", false);
    acl.mockRejectedValue(new Error("broad ACL"));
    await expect(requireAccountOnly("secret", io)).rejects.toThrow("broad ACL");
  });
  it("reads only after validation and exclusively creates output under a protected directory", async () => {
    const platform = Object.getOwnPropertyDescriptor(
      runtime.process,
      "platform",
    )!;
    Object.defineProperty(runtime.process, "platform", {
      configurable: true,
      value: "win32",
    });
    try {
      expect(await readProtected("config.json")).toBe("protected");
      expect(execFile).toHaveBeenCalledWith(
        "powershell.exe",
        expect.arrayContaining(["-EncodedCommand"]),
        expect.any(Object),
        expect.any(Function),
      );
      expect(vi.mocked(execFile).mock.calls[0]![2]).toMatchObject({
        env: { IPAB_SECRET_PATH: "config.json" },
      });
      await saveProtected(".keys\\owner.json", "private");
      expect(writeFile).toHaveBeenCalledWith(".keys\\owner.json", "private", {
        mode: 0o600,
        flag: "wx",
      });
      expect(execFile).toHaveBeenCalledTimes(3);
      vi.mocked(mkdir).mockResolvedValue(".keys");
      await saveProtected(".keys\\new.json", "private");
      expect(execFile).toHaveBeenCalledTimes(6);
    } finally {
      Object.defineProperty(runtime.process, "platform", platform);
    }
  });
  it("does not read a malformed secret path", async () => {
    vi.mocked(lstat).mockResolvedValue({
      ...regular(),
      isSymbolicLink: () => true,
    } as Awaited<ReturnType<typeof lstat>>);
    await expect(readProtected("link.json")).rejects.toThrow("regular file");
    expect(readFile).not.toHaveBeenCalled();
  });
});
