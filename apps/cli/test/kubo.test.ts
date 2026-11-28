import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
  lstat,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { generateKeyPair, type KeyPair } from "@ipab/bundle/pointer/crypto";
import { uniqueId } from "@ipab/bundle/pointer/scope";
import type * as IdentityModule from "../src/identity.js";
import type * as ChildModule from "node:child_process";
import {
  kuboBinary,
  kuboSource,
  peerId,
  peerProof,
  prepareNode,
  startNode,
  stopNode,
  KUBO_VERSION,
  type KuboNode,
} from "../src/kubo.js";

const ports = vi.hoisted(() => ({
  run: vi.fn<
    (
      file: string,
      args: readonly string[],
      options?: unknown,
    ) => Promise<{ stdout: string; stderr: string }>
  >(),
  fetch: vi.fn<typeof fetch>(),
  spawn: vi.fn(),
  protect: vi.fn<(path: string, directory?: boolean) => Promise<void>>(),
  secure: vi.fn<(path: string, directory?: boolean) => Promise<void>>(),
  platform: "win32",
  architecture: "x64",
  alive: false,
  started: false,
  spawnError: false,
  portMode: "normal",
  nextPort: 61000,
}));
vi.mock("../src/identity.js", async () => ({
  ...(await vi.importActual<typeof IdentityModule>("../src/identity.js")),
  protectedPath: ports.protect,
  secureNew: ports.secure,
}));
vi.mock("node:sqlite", () => ({
  DatabaseSync: class {
    exec() {}
    close() {}
  },
}));
vi.mock("node:child_process", async () => {
  const actual =
      await vi.importActual<typeof ChildModule>("node:child_process"),
    { promisify } = await import("node:util");
  return {
    ...actual,
    execFile: Object.assign(() => {}, { [promisify.custom]: ports.run }),
    spawn: ports.spawn,
  };
});
vi.mock("node:net", async () => {
  const { EventEmitter: ServerEvents } = await import("node:events");
  return {
    createServer: () => {
      class Server extends ServerEvents {
        listen(_port: number, _ip: string, listener: () => void) {
          queueMicrotask(() => {
            if (ports.portMode === "error")
              this.emit("error", new Error("EADDRINUSE"));
            else listener();
          });
        }
        address() {
          return ports.portMode === "missing"
            ? null
            : ports.portMode === "string"
              ? "pipe"
              : { port: ports.nextPort++ };
        }
        close(listener?: (error?: Error) => void) {
          listener?.(
            ports.portMode === "close-error"
              ? new Error("port close failed")
              : undefined,
          );
        }
      }
      return new Server();
    },
  };
});
const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const urlOf = (input: string | URL | Request) =>
  typeof input === "string"
    ? input
    : input instanceof URL
      ? input.href
      : input.url;
describe(
  "managed Kubo failure and isolation boundaries",
  { tags: ["mock"] },
  () => {
    let root: string, scope: string, key: KeyPair;
    let originalProcess: NodeJS.Process;
    let executable: string;
    beforeEach(async () => {
      vi.resetAllMocks();
      ports.platform = "win32";
      ports.architecture = "x64";
      ports.alive = false;
      ports.started = false;
      ports.spawnError = false;
      ports.portMode = "normal";
      ports.nextPort = 61000;
      originalProcess = process;
      vi.stubGlobal(
        "process",
        new Proxy(originalProcess, {
          get(target, property, receiver) {
            if (property === "platform") return ports.platform;
            if (property === "arch") return ports.architecture;
            if (property === "kill")
              return () => {
                if (!ports.alive)
                  throw Object.assign(new Error("not running"), {
                    code: "ESRCH",
                  });
                return true;
              };
            const value: unknown = Reflect.get(target, property, receiver);
            return value;
          },
        }),
      );
      const base = resolve(".test-work");
      await mkdir(base, { recursive: true });
      root = await mkdtemp(join(base, "kubo-mock-"));
      scope = "a".repeat(64);
      key = await generateKeyPair();
      ports.protect.mockImplementation(async (path) => {
        await lstat(path);
      });
      ports.secure.mockResolvedValue();
      ports.run.mockImplementation(async (_file, args, options) => {
        if (args[0] === "init") {
          const env = (options as { env: NodeJS.ProcessEnv }).env;
          await writeFile(
            join(env.IPFS_PATH!, "config"),
            JSON.stringify({
              Identity: { PeerID: peerId(key.publicRaw), PrivKey: "" },
              Addresses: {},
              Bootstrap: ["public"],
              Discovery: { MDNS: { Enabled: true } },
              Routing: { Type: "dht" },
              AutoTLS: { Enabled: true },
              AutoConf: { Enabled: true },
              AutoNAT: { ServiceMode: "enabled" },
              Swarm: {
                AddrFilters: [],
                DisableNatPortMap: false,
                EnableHolePunching: true,
                RelayClient: { Enabled: true },
                RelayService: { Enabled: true },
              },
            }),
          );
        }
        if (args[0] === "-xf") {
          const folder = join(args[3]!, "kubo");
          await mkdir(folder);
          await writeFile(
            join(folder, ports.platform === "win32" ? "ipfs.exe" : "ipfs"),
            "verified executable",
          );
        }
        return {
          stdout:
            args[0] === "-tf"
              ? "kubo/ipfs.exe\nkubo/LICENSE\n"
              : KUBO_VERSION + "\n",
          stderr: "",
        };
      });
      ports.fetch.mockImplementation((input) => {
        const url = urlOf(input);
        if (url.includes("/id")) {
          if (!ports.started) throw new TypeError("connection refused");
          return Promise.resolve(Response.json({ ID: peerId(key.publicRaw) }));
        }
        if (url.includes("/shutdown")) {
          ports.started = false;
          ports.alive = false;
          return Promise.resolve(Response.json({}));
        }
        if (url.includes("/swarm/connect"))
          return Promise.resolve(Response.json({}));
        const filename = `kubo_v${KUBO_VERSION}_${ports.platform === "win32" ? "windows" : ports.platform}-${ports.architecture === "x64" ? "amd64" : "arm64"}.${ports.platform === "win32" ? "zip" : "tar.gz"}`;
        const archive = new TextEncoder().encode("archive");
        return Promise.resolve(
          url.includes("/releases/tags/")
            ? Response.json({
                draft: false,
                prerelease: false,
                assets: [
                  {
                    name: filename,
                    digest: `sha256:${digest(archive)}`,
                    browser_download_url: `https://github.com/ipfs/kubo/releases/download/v${KUBO_VERSION}/${filename}`,
                  },
                ],
              })
            : new Response(archive),
        );
      });
      vi.stubGlobal("fetch", ports.fetch);
      ports.spawn.mockImplementation(() => {
        class Child extends EventEmitter {
          pid = 10001;
          exitCode: number | null = null;
          signalCode: string | null = null;
          unref() {}
          kill() {
            ports.alive = false;
            ports.started = false;
            this.exitCode = 1;
            this.emit("close", 1);
            return true;
          }
        }
        const child = new Child();
        ports.alive = true;
        ports.started = !ports.spawnError;
        if (ports.spawnError)
          queueMicrotask(() => {
            child.emit("error", new Error("spawn failed"));
          });
        return child;
      });
      executable = await cachedProgram();
    });
    afterEach(async () => {
      vi.useRealTimers();
      vi.unstubAllGlobals();
      await rm(root, { recursive: true, force: true });
    });
    async function cachedProgram() {
      const directory = join(root, "kubo-bin");
      await mkdir(directory);
      const binary = join(
          directory,
          ports.platform === "win32" ? "ipfs.exe" : "ipfs",
        ),
        bytes = new TextEncoder().encode("verified executable");
      await writeFile(binary, bytes);
      await writeFile(
        join(directory, "installation.json"),
        JSON.stringify({ version: KUBO_VERSION, hash: digest(bytes) }),
      );
      return binary;
    }
    async function fresh() {
      await rm(join(root, "kubo-bin"), { recursive: true, force: true });
    }
    async function node(): Promise<KuboNode> {
      return prepareNode(root, scope);
    }
    async function mutateRecord(change: Record<string, unknown>) {
      const path = join(root, "swarm-nodes", scope, "node.json"),
        record = JSON.parse(await readFile(path, "utf8")) as Record<
          string,
          unknown
        >;
      await writeFile(path, JSON.stringify({ ...record, ...change }));
    }
    it("rejects changed or inaccessible cached executables without replacing them", async () => {
      expect(await kuboBinary(root)).toBe(executable);
      await writeFile(executable, "tampered");
      await expect(kuboBinary(root)).rejects.toThrow("integrity mismatch");
      ports.protect.mockRejectedValueOnce(
        new Error("account permission denied"),
      );
      await expect(kuboBinary(root)).rejects.toThrow("permission denied");
      expect(ports.fetch).not.toHaveBeenCalled();
    });
    it("installs only a stable officially named digest-verified archive and protects extraction", async () => {
      await fresh();
      expect(await kuboBinary(root)).toBe(executable);
      expect(
        (await readdir(join(root, "kubo-bin"))).some((name) =>
          name.startsWith("extract-"),
        ),
      ).toBe(false);
      ports.platform = "linux";
      await fresh();
      expect(await kuboBinary(root)).toBe(join(root, "kubo-bin", "ipfs"));
    });
    it("rejects unsupported platforms and release metadata failures before downloading", async () => {
      await fresh();
      ports.platform = "aix";
      await expect(kuboBinary(root)).rejects.toThrow("Unsupported");
      ports.platform = "win32";
      ports.architecture = "ia32";
      await expect(kuboBinary(root)).rejects.toThrow("Unsupported");
      ports.architecture = "x64";
      ports.fetch.mockResolvedValueOnce(
        new Response("unavailable", { status: 503 }),
      );
      await expect(kuboBinary(root)).rejects.toThrow("official Kubo release");
      for (const data of [
        { draft: true, prerelease: false, assets: [] },
        { draft: false, prerelease: true, assets: [] },
        { draft: false, prerelease: false, assets: [] },
        {
          draft: false,
          prerelease: false,
          assets: [
            {
              name: `kubo_v${KUBO_VERSION}_windows-amd64.zip`,
              digest: "bad",
              browser_download_url: "https://foreign.example",
            },
          ],
        },
        {
          draft: false,
          prerelease: false,
          assets: [
            {
              name: `kubo_v${KUBO_VERSION}_windows-amd64.zip`,
              digest: `sha256:${"a".repeat(64)}`,
              browser_download_url: "https://foreign.example",
            },
          ],
        },
      ]) {
        ports.fetch.mockResolvedValueOnce(Response.json(data));
        await expect(kuboBinary(root)).rejects.toThrow("archive/digest");
      }
    });
    it("rejects download failure, checksum mismatch, unsafe archive paths and wrong executable version", async () => {
      await fresh();
      const original = ports.fetch.getMockImplementation()!;
      ports.fetch.mockImplementation((input, init) =>
        urlOf(input).includes("/releases/tags/")
          ? original(input, init)
          : Promise.resolve(new Response("failed", { status: 500 })),
      );
      await expect(kuboBinary(root)).rejects.toThrow("download failed");
      ports.fetch.mockImplementation((input, init) =>
        urlOf(input).includes("/releases/tags/")
          ? original(input, init)
          : Promise.resolve(new Response("different bytes")),
      );
      await expect(kuboBinary(root)).rejects.toThrow("checksum mismatch");
      ports.fetch.mockImplementation(original);
      const runner = ports.run.getMockImplementation()!;
      ports.run.mockImplementation((file, args, opts) =>
        args[0] === "-tf"
          ? Promise.resolve({ stdout: "../escape\n", stderr: "" })
          : runner(file, args, opts),
      );
      await expect(kuboBinary(root)).rejects.toThrow("Unsafe");
      ports.run.mockImplementation((file, args, opts) =>
        args[0] === "version"
          ? Promise.resolve({ stdout: "0.0.0", stderr: "" })
          : runner(file, args, opts),
      );
      await expect(kuboBinary(root)).rejects.toThrow("version mismatch");
      expect(
        (await readdir(join(root, "kubo-bin"))).filter((name) =>
          name.startsWith("extract-"),
        ),
      ).toEqual([]);
    });
    it("never creates a new node identity over a missing managed record or accepts malformed ports/tokens", async () => {
      const prepared = await node();
      await expect(prepareNode(root, "bad")).rejects.toThrow("Scope identity");
      for (const data of [
        { peerId: 1 },
        { api: "80@foreign.example" },
        { api: 0 },
        { gateway: 61000 },
        { swarm: 70000 },
        { auth: "bad" },
        { pid: -1 },
        { epoch: 0 },
        { unexpected: true },
      ]) {
        const path = join(root, "swarm-nodes", scope, "node.json"),
          original = await readFile(path, "utf8");
        await mutateRecord(data);
        await expect(node()).rejects.toThrow("managed-node record");
        await writeFile(path, original);
      }
      await writeFile(join(prepared.repo, "swarm.key"), "old private key");
      await rm(join(root, "swarm-nodes", scope, "node.json"));
      await expect(node()).rejects.toThrow("record is missing");
    });
    it("reports port allocation failures without starting a daemon or touching a different repo", async () => {
      for (const mode of [
        "error",
        "missing",
        "string",
        "close-error",
      ] as const) {
        ports.portMode = mode;
        await expect(node()).rejects.toThrow();
        expect(ports.spawn).not.toHaveBeenCalled();
      }
    });
    it("validates PeerID possession and rejects unsupported or mismatched stored node keys", async () => {
      const prepared = await node(),
        path = join(prepared.repo, "config");
      await expect(peerProof(prepared, "proof")).rejects.toThrow("Ed25519");
      const config = JSON.parse(await readFile(path, "utf8")) as Record<
        string,
        unknown
      >;
      const seed = Buffer.from(key.privatePkcs8, "base64url").subarray(-32);
      const privateKey = Buffer.concat([
        Buffer.from([8, 1, 18, 64]),
        seed,
        Buffer.from(key.publicRaw, "base64url"),
      ]).toString("base64");
      await writeFile(
        path,
        JSON.stringify({ ...config, Identity: { PrivKey: privateKey } }),
      );
      expect((await peerProof(prepared, "proof")).publicKey).toBe(
        key.publicRaw,
      );
      await expect(
        peerProof({ ...prepared, peerId: "foreign" }, "proof"),
      ).rejects.toThrow("mismatch");
    });
    it("rejects invalid PSKs, foreign API identities and authorization failures before controlling a node", async () => {
      await expect(startNode(root, scope, "bad", 1, [])).rejects.toThrow(
        "Swarm key",
      );
      ports.started = true;
      for (const response of [
        Response.json({ ID: "foreign" }),
        new Response("unauthorized", { status: 401 }),
        new Response("forbidden", { status: 403 }),
      ]) {
        ports.fetch.mockResolvedValueOnce(response);
        await expect(
          startNode(root, scope, "a".repeat(64), 1, []),
        ).rejects.toThrow();
        expect(ports.spawn).not.toHaveBeenCalled();
      }
    });
    it("starts only its owned repo, reuses an approved epoch and rejects changed PSK files", async () => {
      const started = await startNode(root, scope, "a".repeat(64), 1, []);
      expect(ports.spawn).toHaveBeenCalledOnce();
      expect((ports.spawn.mock.calls[0] as unknown[])[1]).toEqual([
        "daemon",
        "--enable-gc=false",
        "--migrate=false",
      ]);
      await startNode(root, scope, "a".repeat(64), 1, []);
      expect(ports.spawn).toHaveBeenCalledOnce();
      await writeFile(join(started.repo, "swarm.key"), "tampered");
      await expect(
        startNode(root, scope, "a".repeat(64), 1, []),
      ).rejects.toThrow("approved epoch");
    });
    it("stops and waits for its old owned PID before switching epochs, and reports a node that refuses to stop", async () => {
      const started = await startNode(root, scope, "a".repeat(64), 1, []);
      await startNode(root, scope, "b".repeat(64), 2, []);
      expect(ports.spawn).toHaveBeenCalledTimes(2);
      await stopNode(started);
      expect(ports.alive).toBe(false);
      ports.started = true;
      ports.alive = true;
      const original = ports.fetch.getMockImplementation()!;
      ports.fetch.mockImplementation((input, init) =>
        urlOf(input).includes("/shutdown")
          ? Promise.resolve(Response.json({}))
          : original(input, init),
      );
      vi.useFakeTimers();
      const stopping = stopNode({ ...started, pid: 10001 }).catch(
        (cause: unknown) => cause,
      );
      await vi.advanceTimersByTimeAsync(15_000);
      expect(await stopping).toBeInstanceOf(Error);
    });
    it("cleans a spawned process if readiness or spawn fails instead of leaving an untracked background daemon", async () => {
      ports.spawnError = true;
      const result = startNode(root, scope, "a".repeat(64), 1, []).catch(
        (cause: unknown) => cause,
      );
      expect(await result).toBeInstanceOf(Error);
      expect(ports.alive).toBe(false);
    });
    it("tries another address for a PeerID and reports failed/offline dial diagnostics", async () => {
      ports.started = true;
      const original = ports.fetch.getMockImplementation()!;
      ports.fetch.mockImplementation((input, init) =>
        urlOf(input).includes("/swarm/connect")
          ? Promise.resolve(
              Response.json({ Message: "unreachable" }, { status: 500 }),
            )
          : original(input, init),
      );
      const messages: string[] = [];
      await startNode(
        root,
        scope,
        "a".repeat(64),
        1,
        ["/ip4/10.0.0.1/tcp/4001/p2p/Other"],
        (text) => {
          messages.push(text);
        },
      );
      expect(messages.join()).toContain("unreachable");
      ports.fetch.mockImplementation((input, init) =>
        urlOf(input).includes("/swarm/connect")
          ? Promise.reject(new TypeError("offline"))
          : original(input, init),
      );
      await startNode(
        root,
        scope,
        "a".repeat(64),
        1,
        ["/ip4/10.0.0.2/tcp/4001/p2p/Other"],
        (text) => {
          messages.push(text);
        },
      );
      expect(messages.join()).toContain("offline");
    });
    it("provides a bounded cancellable block port and reports unavailable or oversized block responses", async () => {
      const prepared = await node(),
        source = kuboSource(prepared);
      ports.fetch.mockResolvedValueOnce(
        new Response("failed", { status: 500 }),
      );
      await expect(source.block.get(uniqueId())).rejects.toThrow("unavailable");
      ports.fetch.mockResolvedValueOnce(new Response(null));
      await expect(source.block.get(uniqueId())).rejects.toThrow("unavailable");
      ports.fetch.mockResolvedValueOnce(
        new Response(new Uint8Array([1, 2, 3])),
      );
      expect(await source.block.get(uniqueId())).toEqual(
        new Uint8Array([1, 2, 3]),
      );
      ports.fetch.mockResolvedValueOnce(
        new Response(new Uint8Array(2 * 1024 * 1024 + 1)),
      );
      await expect(
        source.block.get(uniqueId(), { signal: new AbortController().signal }),
      ).rejects.toThrow("limit");
    });
    it("rejects an extracted directory in place of the executable before caching an installation", async () => {
      await fresh();
      const runner = ports.run.getMockImplementation()!;
      ports.run.mockImplementation(async (file, args, options) => {
        if (args[0] === "-xf") {
          await mkdir(join(args[3]!, "kubo", "ipfs.exe"), { recursive: true });
          return { stdout: "", stderr: "" };
        }
        return runner(file, args, options);
      });
      await expect(kuboBinary(root)).rejects.toThrow("Invalid Kubo executable");
    });
    it("can restore an initialized but unrecorded repo without rerunning init, yet refuses invalid protected config files", async () => {
      const prepared = await node();
      await rm(join(root, "swarm-nodes", scope, "node.json"));
      ports.run.mockClear();
      expect((await node()).peerId).toBe(prepared.peerId);
      expect(ports.run).not.toHaveBeenCalled();
      ports.protect.mockImplementation(async (path) => {
        await lstat(path);
        if (path.endsWith("config"))
          throw new Error("repo config not account owned");
      });
      await expect(node()).rejects.toThrow("account owned");
    });
    it("handles a stopped node or a successful shutdown without a known PID, and treats an unhealthy API as unavailable", async () => {
      const prepared = await node();
      await stopNode(prepared);
      ports.started = true;
      await stopNode(prepared);
      expect(ports.started).toBe(false);
      ports.fetch.mockResolvedValueOnce(
        new Response("unhealthy", { status: 500 }),
      );
      await stopNode(prepared);
      ports.fetch.mockResolvedValueOnce(new Response("invalid JSON"));
      await stopNode(prepared);
    });
    it("uses the supported ARM64 release asset rather than silently installing another architecture", async () => {
      await fresh();
      ports.architecture = "arm64";
      expect(await kuboBinary(root)).toBe(executable);
      const metadataRequest = ports.fetch.mock.calls.find(([input]) =>
        urlOf(input).includes("/releases/tags/"),
      );
      expect(metadataRequest).toBeDefined();
    });
  },
);
