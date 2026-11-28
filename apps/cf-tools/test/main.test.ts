import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { main } from "../src/main.js";
import { bytes, runNode } from "../src/setup.js";
import { readWorker } from "../src/worker.js";
import { readProtected } from "../../../packages/pointer-worker/src/protected-files.ts";
import type { Files } from "../src/setup.js";
import type * as Setup from "../src/setup.js";
import type * as Worker from "../src/worker.js";

vi.mock("../src/setup.js", async (original) => {
  const actual = await original<typeof Setup>();
  return {
    ...actual,
    runNode: vi.fn(() => Promise.resolve()),
    withInstallation: <T>(
      _files: Files,
      _reinstall: boolean,
      use: (path: string) => Promise<T>,
    ) => use("installed"),
  };
});
vi.mock("../src/worker.js", async (original) => ({
  ...(await original<typeof Worker>()),
  readWorker: vi.fn(() =>
    Promise.resolve({
      config: { main: "worker.mjs", compatibility_date: "2026-01-01" },
      paths: ["worker.mjs"],
    }),
  ),
}));
vi.mock("../../../packages/pointer-worker/src/protected-files.ts", () => ({
  readProtected: vi.fn((path: string) => readFile(path, "utf8")),
  saveProtected: async (path: string, text: string) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
  },
}));

const cid = "bafyreid3qonq3i2rjekgz7mtarpu4zbfmgg4uhtcjtpijdgrrhdke5opzq";
const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

describe("bootstrap execution", { tags: ["mock"] }, () => {
  it("shows help without installing or reading Worker content", async () => {
    const original = process.argv;
    const diagnostic = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      process.argv = ["node", "app", "--help"];
      await main("local");
      await main("deploy");
      expect(readWorker).not.toHaveBeenCalled();
      expect(diagnostic).toHaveBeenCalledWith(
        expect.stringContaining("--deploy"),
      );
    } finally {
      process.argv = original;
    }
  });
  async function fixture(args: string[]) {
    const root = await mkdtemp(join(tmpdir(), "ipab-cf-main-"));
    roots.push(root);
    const outputs = new Map<string, string>();
    const context = {
      appCid: cid,
      resolvePin: vi.fn<() => Promise<string | undefined>>(() =>
        Promise.resolve(cid),
      ),
      readFile: vi.fn(() =>
        Promise.resolve(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(Buffer.from("export default {};"));
              controller.close();
            },
          }),
        ),
      ),
      output: {
        writeFile: async (path: string, stream: ReadableStream<Uint8Array>) => {
          outputs.set(path, Buffer.from(await bytes(stream)).toString());
          return cid;
        },
        link: () => Promise.resolve(),
      },
    };
    vi.stubGlobal("ipab", context);
    process.argv = ["node", "app", ...args];
    return { root, outputs, context };
  }

  const originalArgv = process.argv;
  afterEach(() => {
    process.argv = originalArgv;
  });

  it("materializes code, forces local bindings, supplies protected secrets and preserves state", async () => {
    const { root, outputs } = await fixture([cid]);
    const secrets = join(root, "secrets.json");
    await writeFile(
      secrets,
      JSON.stringify({ POINTER_API_KEY_SHA256: "a".repeat(64) }),
    );
    process.argv.push(
      "--port",
      "9876",
      "--state-dir",
      root,
      "--secrets-file",
      secrets,
    );
    vi.mocked(runNode).mockImplementationOnce(async (_entry, args, cwd) => {
      expect(args).toContain("--local");
      expect(args).toContain("--no-bundle");
      expect(args).toContain(root);
      expect(await readFile(join(cwd, ".dev.vars"), "utf8")).toContain(
        "a".repeat(64),
      );
      const config: unknown = JSON.parse(
        await readFile(join(cwd, "wrangler.json"), "utf8"),
      );
      expect(config).toMatchObject({
        vars: { POINTER_SERVICE: "http://127.0.0.1:9876" },
      });
      expect(await readFile(join(cwd, "worker.mjs"), "utf8")).toContain(
        "export default",
      );
    });
    await main("local");
    expect(readProtected).toHaveBeenCalledWith(secrets);
    expect(outputs.size).toBe(0);
  });

  it("dry-runs by default and writes a typed receipt; remote writes require --deploy", async () => {
    const { root, outputs, context } = await fixture(["worker-pin"]);
    const target = join(root, "target.json");
    await writeFile(
      target,
      JSON.stringify({
        name: "test-pointer",
        account_id: "a".repeat(32),
        vars: { POINTER_SERVICE: "https://pointers.example.com" },
      }),
    );
    process.argv.push("--target", target);
    await main("deploy");
    expect(context.resolvePin).toHaveBeenCalledWith("worker-pin");
    expect(vi.mocked(runNode).mock.calls[0]?.[1]).toContain("--dry-run");
    expect(JSON.parse(outputs.get("result.json")!)).toEqual({
      appCid: cid,
      workerCid: cid,
      name: "test-pointer",
      accountId: "a".repeat(32),
      status: "dry-run",
    });
    expect(JSON.parse(outputs.get(".bundle.yaml")!)).toMatchObject({
      entry: "result.json",
      type: ".bundle-type.yaml",
    });
    expect(JSON.parse(outputs.get(".bundle-type.yaml")!)).toEqual({
      contentType: "application/json",
    });
    process.argv.push("--deploy");
    await main("deploy");
    expect(vi.mocked(runNode).mock.calls[1]?.[1]).not.toContain("--dry-run");
    expect(outputs.get("result.json")).toContain('"status":"deployed"');
  });

  it("does not produce a success receipt on subprocess failure and reports unknown pins", async () => {
    const { context, outputs } = await fixture(["missing"]);
    context.resolvePin.mockResolvedValueOnce(undefined);
    await expect(main("local")).rejects.toThrow("Unknown");
    process.argv = ["node", "app", cid];
    vi.mocked(runNode).mockRejectedValueOnce(new Error("Wrangler failed"));
    await expect(main("local")).rejects.toThrow("Wrangler failed");
    expect(outputs.size).toBe(0);
    expect(readWorker).toHaveBeenCalled();
  });
});
