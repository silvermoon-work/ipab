import { afterEach, describe, expect, it, vi } from "vitest";
import { lstat, readFile } from "node:fs/promises";
import { pnpmEntry } from "../src/setup.js";

vi.mock("node:fs/promises", () => ({
  lstat: vi.fn(),
  readFile: vi.fn(),
}));
const version = vi.hoisted(() => ({ value: "11.28.12" }));
vi.mock("node:child_process", async () => {
  const { promisify } = await import("node:util");
  return {
    spawn: vi.fn(),
    execFile: Object.assign(
      vi.fn(
        (
          _file: string,
          _args: string[],
          _options: unknown,
          callback: (
            error: Error | null,
            stdout: string,
            stderr: string,
          ) => void,
        ) => {
          callback(null, version.value, "");
        },
      ),
      {
        [promisify.custom]: () =>
          Promise.resolve({ stdout: version.value, stderr: "" }),
      },
    ),
  };
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  version.value = "11.28.12";
});
describe("pnpm discovery", { tags: ["mock"] }, () => {
  function installed() {
    vi.mocked(lstat).mockResolvedValue({ isFile: () => true } as Awaited<
      ReturnType<typeof lstat>
    >);
    vi.mocked(readFile).mockResolvedValue('{"name":"pnpm"}');
  }
  it("honors an explicit installed CLI and rejects shims, wrong versions and invalid packages", async () => {
    installed();
    vi.stubEnv("IPAB_PNPM_CLI", "pnpm.mjs");
    await expect(pnpmEntry()).resolves.toContain("pnpm.mjs");
    version.value = "10.22.0";
    await expect(pnpmEntry()).rejects.toThrow("requires pnpm 11.28.12");
    version.value = "11.28.12";
    vi.mocked(readFile).mockResolvedValue('{"name":"corepack"}');
    await expect(pnpmEntry()).rejects.toThrow("installed pnpm");
    vi.stubEnv("IPAB_PNPM_CLI", "pnpm.cmd");
    await expect(pnpmEntry()).rejects.toThrow("Corepack");
  });
  it("searches installed locations but reports missing or inaccessible tools without downloading", async () => {
    installed();
    vi.stubEnv("IPAB_PNPM_CLI", "");
    vi.stubEnv("npm_execpath", "");
    vi.stubEnv("PATH", "tools");
    vi.mocked(lstat).mockRejectedValueOnce(
      Object.assign(new Error("missing"), { code: "ENOENT" }),
    );
    await expect(pnpmEntry()).resolves.toContain("pnpm.");
    vi.mocked(lstat).mockRejectedValue(
      Object.assign(new Error("missing"), { code: "ENOTDIR" }),
    );
    await expect(pnpmEntry()).rejects.toThrow("CLI not found");
    vi.mocked(lstat).mockRejectedValue(
      Object.assign(new Error("denied"), { code: "EACCES" }),
    );
    await expect(pnpmEntry()).rejects.toThrow("denied");
  });
});
