import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as childProcess from "node:child_process";
import { packageSmoke } from "../src/index.js";
import { main } from "../src/cli.js";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));
let root: string;
let members: unknown;
let failure: "pack" | "install" | "verify" | "error" | undefined;
let native = true;
let consumer: string | undefined;
const spawn = vi.mocked(childProcess.spawnSync);
const pnpm = join(tmpdir(), "pnpm.exe");

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "package-smoke-test-"));
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ private: true, packageManager: "pnpm@11.28.12" }),
  );
  await writeFile(join(root, "verify.mjs"), "export {};\n");
  const member = join(root, "member");
  await mkdir(member);
  await writeFile(
    join(member, "package.json"),
    JSON.stringify({ name: "@test/library", version: "1.0.0", private: false }),
  );
  members = [{ path: root }, { path: member }];
  failure = undefined;
  consumer = undefined;
  native = true;
  spawn.mockImplementation((_command, args, options) => {
    const values = args ?? [];
    const actual = native ? values : values.slice(1);
    if (actual.includes("install")) consumer = String(options?.cwd);
    if (failure === "error") throw new Error("Process could not start.");
    const failed =
      failure === "pack"
        ? actual.includes("pack")
        : failure === "install"
          ? actual.includes("install")
          : failure === "verify"
            ? values.some((value) => value.endsWith("verify.mjs"))
            : false;
    return {
      pid: 1,
      output: [],
      signal: null,
      status: failed ? 7 : 0,
      stdout: actual.includes("--version")
        ? "11.28.12\n"
        : actual.includes("list")
          ? JSON.stringify(members)
          : "",
      stderr: failed ? "fixture failure" : "",
    };
  });
  vi.stubEnv("npm_execpath", pnpm);
  vi.spyOn(process, "cwd").mockReturnValue(root);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

it(
  "uses active pnpm, skips private packages, installs tarballs and cleans the independent consumer",
  { tags: ["mock"] },
  async () => {
    expect(
      await packageSmoke({
        root,
        verify: "verify.mjs",
        pnpm,
        allowBuilds: ["esbuild"],
      }),
    ).toBe(1);
    const install = spawn.mock.calls.find((call) =>
      call[1]?.includes("install"),
    );
    expect(install?.[2]).toMatchObject({ shell: false, timeout: 300_000 });
    expect(install?.[2]?.env?.COREPACK_ENABLE_NETWORK).toBe("0");
    expect(consumer).not.toContain(root);
    await expect(
      readFile(join(consumer!, "package.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(spawn.mock.calls.some((call) => call[1]?.includes("publish"))).toBe(
      false,
    );
  },
);
it(
  "supports Node-based pnpm without replacing it with another package manager",
  { tags: ["mock"] },
  async () => {
    native = false;
    expect(
      await packageSmoke({
        root,
        verify: "verify.mjs",
        pnpm: join(tmpdir(), "pnpm.cjs"),
        timeout: 10_000,
      }),
    ).toBe(1);
    expect(spawn.mock.calls[0]?.[0]).toBe(process.execPath);
  },
);
it.each(["pack", "install", "verify"] as const)(
  "stops on %s failure without claiming success",
  { tags: ["mock"] },
  async (stage) => {
    failure = stage;
    await expect(
      packageSmoke({ root, verify: "verify.mjs", pnpm }),
    ).rejects.toThrow("failed (7)");
    if (consumer)
      await expect(
        readFile(join(consumer, "package.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
  },
);
it("propagates subprocess launch errors", { tags: ["mock"] }, async () => {
  spawn.mockImplementationOnce(() => ({
    pid: 0,
    output: [],
    status: null,
    signal: null,
    stdout: "",
    stderr: "",
    error: new Error("could not spawn"),
  }));
  await expect(
    packageSmoke({ root, verify: "verify.mjs", pnpm }),
  ).rejects.toThrow("could not spawn");
});
it.each([
  { timeout: 0 },
  { pnpm: "npm" },
  { verify: "file.ts" },
  { allowBuilds: ["esbuild@latest"] },
])(
  "rejects invalid invocation options %j",
  { tags: ["mock"] },
  async (change) => {
    await expect(
      packageSmoke({ root, verify: "verify.mjs", pnpm, ...change }),
    ).rejects.toThrow();
  },
);
it.each([null, {}, [{ path: "relative" }]])(
  "rejects malformed workspace listing %j",
  { tags: ["mock"] },
  async (listing) => {
    members = listing;
    await expect(
      packageSmoke({ root, verify: "verify.mjs", pnpm }),
    ).rejects.toThrow();
  },
);
it(
  "rejects a workspace containing only private packages",
  { tags: ["mock"] },
  async () => {
    members = [{ path: root }];
    await expect(
      packageSmoke({ root, verify: "verify.mjs", pnpm }),
    ).rejects.toThrow("No non-private");
  },
);
it(
  "rejects package manager mismatch, duplicate identities and invalid manifests",
  { tags: ["mock"] },
  async () => {
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ private: true, packageManager: "pnpm@1.0.0" }),
    );
    await expect(
      packageSmoke({ root, verify: "verify.mjs", pnpm }),
    ).rejects.toThrow("packageManager");
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ private: true, packageManager: "pnpm@11.28.12" }),
    );
    members = [{ path: join(root, "member") }, { path: join(root, "member") }];
    await expect(
      packageSmoke({ root, verify: "verify.mjs", pnpm }),
    ).rejects.toThrow("Duplicate");
    await writeFile(
      join(root, "member", "package.json"),
      JSON.stringify({ name: "../bad", version: "1.0.0" }),
    );
    await expect(
      packageSmoke({ root, verify: "verify.mjs", pnpm }),
    ).rejects.toThrow("valid name");
    await writeFile(join(root, "package.json"), "null");
    await expect(
      packageSmoke({ root, verify: "verify.mjs", pnpm }),
    ).rejects.toThrow("object");
  },
);
it(
  "shows help without subprocesses and accepts a real verification option",
  { tags: ["mock"] },
  async () => {
    expect(await main([])).toBe(0);
    expect(await main(["--help"])).toBe(0);
    expect(await main(["-h"])).toBe(0);
    expect(spawn).not.toHaveBeenCalled();
    expect(await main(["--version"])).toBe(0);
    expect(
      await main(["--verify", "verify.mjs", "--allow-build", "esbuild"]),
    ).toBe(0);
  },
);
it("the bin entry actually invokes the CLI", { tags: ["mock"] }, async () => {
  const argv = process.argv;
  const exitCode = process.exitCode;
  try {
    process.argv = [process.execPath, "package-smoke", "--help"];
    await import("../src/bin.js");
    expect(console.log).toHaveBeenCalled();
    expect(process.exitCode).toBe(0);
  } finally {
    process.argv = argv;
    process.exitCode = exitCode;
  }
});
it.each([
  ["--verify"],
  ["--unknown", "value"],
  ["--allow-build", "esbuild"],
  ["--verify", "verify.mjs", "--verify", "other.mjs"],
  ["--verify", "--helpful"],
])(
  "reports invalid CLI arguments %j",
  { tags: ["mock"] },
  async (...args: string[]) => {
    expect(await main(args)).toBe(1);
    expect(console.error).toHaveBeenCalled();
  },
);
it(
  "reports unavailable pnpm context and execution failures",
  { tags: ["mock"] },
  async () => {
    vi.stubEnv("npm_execpath", "");
    expect(await main(["--verify", "verify.mjs"])).toBe(1);
    vi.stubEnv("npm_execpath", pnpm);
    failure = "install";
    expect(await main(["--verify", "verify.mjs"])).toBe(1);
  },
);
