import { describe, expect, it, vi } from "vitest";
import { chmod } from "node:fs/promises";
import { execFile } from "node:child_process";
import {
  protectAccountOnly,
  requireAccountOnlyMany,
  type FileAccessIO,
} from "../src/pointer/protected-files.js";

vi.mock("../src/pointer/node-runtime.js", () => ({
  runtime: { process: { platform: "win32", env: {}, getuid: () => 1000 } },
}));
vi.mock("node:fs/promises", () => ({
  chmod: vi.fn().mockResolvedValue(undefined),
  lstat: vi.fn().mockResolvedValue({
    mode: 0o600,
    uid: 1000,
    isFile: () => true,
    isDirectory: () => false,
    isSymbolicLink: () => false,
  }),
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
const file = {
  mode: 0o600,
  uid: 1000,
  isFile: () => true,
  isDirectory: () => false,
  isSymbolicLink: () => false,
};
describe("shared account-only batch permissions", { tags: ["mock"] }, () => {
  it("validates every path and batches Windows ACL checks without accepting a bad path", async () => {
    const acl = vi.fn<FileAccessIO["acl"]>().mockResolvedValue();
    const aclMany = vi
      .fn<(paths: string[]) => Promise<void>>()
      .mockResolvedValue();
    const io: FileAccessIO = {
      platform: "win32",
      uid: undefined,
      inspect: () => Promise.resolve(file),
      acl,
      aclMany,
    };
    await requireAccountOnlyMany(["parent", "key"], io);
    expect(aclMany).toHaveBeenCalledWith(["parent", "key"]);
    await requireAccountOnlyMany(["parent", "key"], {
      platform: "win32",
      uid: undefined,
      inspect: () => Promise.resolve(file),
      acl,
    });
    expect(acl).toHaveBeenCalledTimes(2);
    await expect(
      requireAccountOnlyMany(["key"], {
        ...io,
        inspect: () => Promise.resolve({ ...file, isSymbolicLink: () => true }),
      }),
    ).rejects.toThrow("regular");
    await expect(
      requireAccountOnlyMany(["key"], { ...io, platform: "linux", uid: 2000 }),
    ).rejects.toThrow("current OS account");
  });
  it("protects Unix files/directories and Windows paths without changing foreign-owned paths", async () => {
    const acl = vi.fn<FileAccessIO["acl"]>().mockResolvedValue();
    const io: FileAccessIO = {
      platform: "linux",
      uid: 1000,
      inspect: () => Promise.resolve(file),
      acl,
    };
    await protectAccountOnly("key", io);
    expect(chmod).toHaveBeenCalledWith("key", 0o600);
    await protectAccountOnly("directory", {
      ...io,
      inspect: () =>
        Promise.resolve({
          ...file,
          mode: 0o700,
          isFile: () => false,
          isDirectory: () => true,
        }),
    });
    expect(chmod).toHaveBeenCalledWith("directory", 0o700);
    await expect(
      protectAccountOnly("key", { ...io, uid: 2000 }),
    ).rejects.toThrow("belong");
    await expect(
      protectAccountOnly("link", {
        ...io,
        inspect: () => Promise.resolve({ ...file, isSymbolicLink: () => true }),
      }),
    ).rejects.toThrow("regular");
    await protectAccountOnly("key", { ...io, platform: "win32" });
    expect(acl).toHaveBeenCalledWith("key", true);
  });
  it("passes default batched ACL paths through the environment, not shell interpolation", async () => {
    await requireAccountOnlyMany(["parent", "key"]);
    expect(execFile).toHaveBeenCalledWith(
      "powershell.exe",
      expect.arrayContaining(["-EncodedCommand"]),
      expect.any(Object),
      expect.any(Function),
    );
    expect(vi.mocked(execFile).mock.calls.at(-1)?.[2]).toMatchObject({
      env: { IPAB_SECRET_PATHS: '["parent","key"]' },
    });
  });
});
