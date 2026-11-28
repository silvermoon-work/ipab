import { afterEach, describe, expect, it, vi } from "vitest";
import { rm, mkdir, symlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve, join } from "node:path";
import { runCli } from "../src/cli.js";
import type { Identity } from "../src/identity.js";
import type * as KuboModule from "../src/kubo.js";
import type * as IdentityModule from "../src/identity.js";

const ports = vi.hoisted(() => ({
  binary: vi.fn<(stateDir: string) => Promise<string>>(),
  identity:
    vi.fn<
      (env: NodeJS.ProcessEnv, initialize?: boolean) => Promise<Identity>
    >(),
  prepare: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
}));
vi.mock("../src/kubo.js", async () => ({
  ...(await vi.importActual<typeof KuboModule>("../src/kubo.js")),
  kuboBinary: ports.binary,
  prepareNode: ports.prepare,
  startNode: ports.start,
  stopNode: ports.stop,
}));
vi.mock("../src/identity.js", async () => ({
  ...(await vi.importActual<typeof IdentityModule>("../src/identity.js")),
  accountIdentity: ports.identity,
  secureNew: () => Promise.resolve(),
}));
describe("device setup", { tags: ["mock"] }, () => {
  const directories: string[] = [];
  afterEach(async () => {
    for (const directory of directories.splice(0))
      await rm(directory, { recursive: true, force: true });
    vi.clearAllMocks();
  });
  it("requires confirmation before any installation or identity access", async () => {
    let error = "";
    const code = await runCli(
      ["setup"],
      {
        tty: false,
        out: () => {},
        err: (text) => {
          error = text;
        },
        confirm: () => Promise.resolve(false),
      },
      {},
    );
    expect(code).toBe(1);
    expect(error).toContain("confirmation");
    expect(ports.binary).not.toHaveBeenCalled();
    expect(ports.identity).not.toHaveBeenCalled();
  });
  it("is repeatable, prepares the existing identity and never accesses a daemon or Store", async () => {
    const stateDir = resolve(".test-work", `setup-${randomUUID()}`);
    directories.push(stateDir);
    const env = { HOME: resolve(stateDir, "home") };
    const binary = resolve(stateDir, "ipfs.exe");
    ports.binary.mockResolvedValue(binary);
    ports.identity.mockResolvedValue({
      publicKey: "A".repeat(43),
      privateKey: "PRIVATE-NOT-OUTPUT",
    });
    const output: string[] = [];
    const io = {
      tty: false,
      out: (text: string) => {
        output.push(text);
      },
      err: () => {},
      confirm: () => Promise.resolve(false),
    };
    for (let i = 0; i < 2; i++)
      expect(
        await runCli(
          ["--json", "--state-dir", stateDir, "setup", "--yes"],
          io,
          env,
        ),
      ).toBe(0);
    expect(output[0]).toBe(output[1]);
    expect(output[0]).toContain(binary.replace(/\\/g, "\\\\"));
    expect(output.join()).not.toContain("PRIVATE-NOT-OUTPUT");
    expect(ports.binary).toHaveBeenCalledWith(stateDir);
    expect(ports.identity).toHaveBeenCalledWith(env, true);
    expect(ports.prepare).not.toHaveBeenCalled();
    expect(ports.start).not.toHaveBeenCalled();
    expect(ports.stop).not.toHaveBeenCalled();
  });
  it("propagates checksum/install failures without initializing a replacement identity", async () => {
    const stateDir = resolve(".test-work", `setup-${randomUUID()}`);
    directories.push(stateDir);
    ports.binary.mockRejectedValue(new Error("Kubo archive checksum mismatch"));
    let error = "";
    const code = await runCli(
      ["--state-dir", stateDir, "setup", "--yes"],
      {
        tty: false,
        out: () => {},
        err: (text) => {
          error = text;
        },
        confirm: () => Promise.resolve(false),
      },
      {},
    );
    expect(code).toBe(1);
    expect(error).toContain("checksum mismatch");
    expect(ports.identity).not.toHaveBeenCalled();
  });
  it("refuses a symlinked state directory before accessing installation or account keys", async () => {
    const root = resolve(".test-work", `setup-${randomUUID()}`);
    directories.push(root);
    const target = join(root, "target"),
      state = join(root, "state");
    await mkdir(target, { recursive: true });
    await symlink(target, state, "junction");
    let error = "";
    expect(
      await runCli(
        ["--state-dir", state, "setup", "--yes"],
        {
          tty: false,
          out: () => {},
          err: (text) => {
            error = text;
          },
          confirm: () => Promise.resolve(false),
        },
        {},
      ),
    ).toBe(1);
    expect(error).toContain("regular directory");
    expect(ports.binary).not.toHaveBeenCalled();
    expect(ports.identity).not.toHaveBeenCalled();
  });
});
