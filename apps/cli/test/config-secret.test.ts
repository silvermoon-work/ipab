import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, existsSync, lstatSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { secureConfigurationStorage } from "../src/config-secret.js";

vi.mock("node:fs", () => ({
  chmodSync: vi.fn(),
  existsSync: vi.fn(),
  lstatSync: vi.fn(),
}));
vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
const originalUid = Object.getOwnPropertyDescriptor(process, "getuid");
const stat = (mode = 0o600, uid = 1000) => ({
  mode,
  uid,
  isFile: () => true,
  isDirectory: () => false,
  isSymbolicLink: () => false,
});
describe("SQLite config secret protection", { tags: ["mock"] }, () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(lstatSync).mockReturnValue(
      stat() as ReturnType<typeof lstatSync>,
    );
  });
  afterEach(() => {
    Object.defineProperty(process, "platform", originalPlatform);
    if (originalUid) Object.defineProperty(process, "getuid", originalUid);
    else Reflect.deleteProperty(process, "getuid");
  });
  it("protects and validates Unix state directory plus SQLite/WAL/SHM files", () => {
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: "linux",
    });
    Object.defineProperty(process, "getuid", {
      configurable: true,
      value: () => 1000,
    });
    vi.mocked(lstatSync).mockReturnValueOnce({
      ...stat(0o755),
      isDirectory: () => true,
    } as ReturnType<typeof lstatSync>);
    secureConfigurationStorage("private-state", true);
    expect(chmodSync).toHaveBeenNthCalledWith(1, "private-state", 0o700);
    expect(chmodSync).toHaveBeenCalledTimes(4);
    secureConfigurationStorage("private-state", false);
    vi.mocked(lstatSync).mockReturnValue(
      stat(0o644) as ReturnType<typeof lstatSync>,
    );
    expect(() => {
      secureConfigurationStorage("private-state", false);
    }).toThrow("account-only");
    vi.mocked(lstatSync).mockReturnValue(
      stat(0o600, 2000) as ReturnType<typeof lstatSync>,
    );
    expect(() => {
      secureConfigurationStorage("private-state", true);
    }).toThrow("account-only");
    vi.mocked(lstatSync).mockReturnValue({
      ...stat(),
      isSymbolicLink: () => true,
    } as ReturnType<typeof lstatSync>);
    expect(() => {
      secureConfigurationStorage("private-state", true);
    }).toThrow("account-only");
    vi.mocked(existsSync).mockReturnValue(false);
    expect(() => {
      secureConfigurationStorage("private-state", false);
    }).not.toThrow();
  });
  it("uses encoded Windows ACL commands with path in env and propagates ACL failures without secret text", () => {
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: "win32",
    });
    secureConfigurationStorage("private-state", true);
    expect(execFileSync).toHaveBeenCalledTimes(1);
    expect(vi.mocked(execFileSync).mock.calls[0]?.[2]).toMatchObject({
      env: { IPAB_CONFIG_PROTECT: "true" },
    });
    const options = vi.mocked(execFileSync).mock.calls[0]?.[2];
    expect(options).toMatchObject({
      env: {
        IPAB_CONFIG_PATHS: JSON.stringify([
          "private-state",
          ...["state.sqlite", "state.sqlite-wal", "state.sqlite-shm"].map(
            (name) => join("private-state", name),
          ),
        ]),
      },
    });
    secureConfigurationStorage("private-state", false);
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error("private-internal");
    });
    expect(() => {
      secureConfigurationStorage("private-state", false);
    }).toThrow("account-only");
  });
});
