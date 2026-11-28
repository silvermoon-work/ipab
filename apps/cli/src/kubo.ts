import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
} from "node:crypto";
import {
  chmod,
  lstat,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "node:net";
import { networkInterfaces } from "node:os";
import { base58btc } from "multiformats/bases/base58";
import { boundedText, uniqueId } from "@ipab/bundle/pointer/scope";
import { protectedPath, secureNew } from "./identity.js";
import {
  privateDirectory,
  readPrivate,
  withPrivateLock,
  writePrivate,
} from "./swarm-files.js";
import { HostError, object } from "./errors.js";
import { nodeError } from "./authoring.js";

export const KUBO_VERSION = "0.43.2";
const run = promisify(execFile);
const hash = (data: Uint8Array) =>
  createHash("sha256").update(data).digest("hex");
interface Installation {
  version: string;
  hash: string;
}
export interface NodeRecord {
  scope: string;
  peerId: string;
  api: number;
  gateway: number;
  swarm: number;
  auth: string;
  epoch?: number;
  pid?: number;
}
export interface KuboNode {
  repo: string;
  peerId: string;
  api: string;
  gateway: string;
  addresses: string[];
  auth: string;
  pid?: number;
}
function nodeRecord(value: unknown, scope: string): NodeRecord {
  const record = object(value, "protected managed-node record");
  const { peerId, api, gateway, swarm, auth, pid, epoch } = record;
  if (
    Object.keys(record).some(
      (key) =>
        ![
          "scope",
          "peerId",
          "api",
          "gateway",
          "swarm",
          "auth",
          "pid",
          "epoch",
        ].includes(key),
    ) ||
    record.scope !== scope ||
    typeof peerId !== "string" ||
    !/^[A-Za-z0-9]{32,128}$/.test(peerId) ||
    typeof api !== "number" ||
    typeof gateway !== "number" ||
    typeof swarm !== "number" ||
    ![api, gateway, swarm].every(
      (port) => Number.isSafeInteger(port) && port > 0 && port <= 65535,
    ) ||
    new Set([record.api, record.gateway, record.swarm]).size !== 3 ||
    typeof auth !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(auth) ||
    (pid !== undefined &&
      (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0)) ||
    (epoch !== undefined &&
      (typeof epoch !== "number" || !Number.isSafeInteger(epoch) || epoch < 1))
  )
    throw new HostError(
      "Invalid protected managed-node record; old node formats are unsupported.",
    );
  return {
    scope,
    peerId,
    api,
    gateway,
    swarm,
    auth,
    ...(pid !== undefined ? { pid } : {}),
    ...(epoch !== undefined ? { epoch } : {}),
  };
}
export async function kuboBinary(stateDir: string): Promise<string> {
  const directory = await privateDirectory(stateDir, "kubo-bin");
  return withPrivateLock(directory, async () => {
    const executable = join(
      directory,
      process.platform === "win32" ? "ipfs.exe" : "ipfs",
    );
    const installed = await readPrivate<Installation>(
      directory,
      "installation.json",
    );
    if (installed) {
      await protectedPath(executable);
      if (
        installed.version !== KUBO_VERSION ||
        installed.hash !== hash(await readFile(executable))
      )
        throw new HostError(
          "Kubo installation integrity mismatch; do not use this binary.",
        );
      return executable;
    }
    const platforms: Partial<Record<NodeJS.Platform, string>> = {
      win32: "windows",
      darwin: "darwin",
      linux: "linux",
    };
    const platform = platforms[process.platform];
    if (!platform || !["x64", "arm64"].includes(process.arch))
      throw new HostError("Unsupported Kubo platform.");
    const arch = process.arch === "x64" ? "amd64" : "arm64";
    const filename = `kubo_v${KUBO_VERSION}_${platform}-${arch}.${platform === "windows" ? "zip" : "tar.gz"}`;
    // Official release metadata supplies the immutable archive digest; HTTPS is the trust boundary.
    const release = await fetch(
      `https://api.github.com/repos/ipfs/kubo/releases/tags/v${KUBO_VERSION}`,
      {
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
        headers: { accept: "application/vnd.github+json" },
      },
    );
    if (!release.ok)
      throw new HostError(
        `Could not verify official Kubo release (HTTP ${release.status}).`,
      );
    const metadata = JSON.parse(await boundedText(release)) as {
      draft: boolean;
      prerelease: boolean;
      assets: { name: string; digest: string; browser_download_url: string }[];
    };
    const asset = metadata.assets.find((item) => item.name === filename);
    if (
      metadata.draft ||
      metadata.prerelease ||
      !asset ||
      !/^sha256:[a-f0-9]{64}$/.test(asset.digest) ||
      asset.browser_download_url !==
        `https://github.com/ipfs/kubo/releases/download/v${KUBO_VERSION}/${filename}`
    )
      throw new HostError("Official stable Kubo archive/digest unavailable.");
    const archive = join(
      directory,
      `${uniqueId()}.${platform === "windows" ? "zip" : "tar.gz"}`,
    );
    const stage = await privateDirectory(directory, `extract-${uniqueId()}`);
    try {
      const response = await fetch(asset.browser_download_url, {
        signal: AbortSignal.timeout(180_000),
      });
      if (!response.ok || !response.body)
        throw new HostError("Kubo download failed.");
      const handle = await open(archive, "wx", 0o600);
      let total = 0;
      const digest = createHash("sha256");
      try {
        await secureNew(archive);
        const stream: ReadableStream<Uint8Array> = response.body;
        for await (const chunk of stream) {
          total += chunk.length;
          if (total > 150 * 1024 * 1024)
            throw new HostError("Kubo archive exceeds limit.");
          digest.update(chunk);
          await handle.write(chunk);
        }
        await handle.sync();
      } finally {
        await handle.close();
      }
      if (`sha256:${digest.digest("hex")}` !== asset.digest)
        throw new HostError("Kubo archive checksum mismatch.");
      const listing = await run("tar", ["-tf", archive], {
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      });
      if (
        listing.stdout
          .split(/\r?\n/)
          .filter(Boolean)
          .some(
            (path) =>
              !/^kubo\/[A-Za-z0-9._/-]+$/.test(path) ||
              path.split("/").includes(".."),
          )
      )
        throw new HostError("Unsafe Kubo archive layout.");
      await run("tar", ["-xf", archive, "-C", stage], {
        timeout: 30_000,
        windowsHide: true,
      });
      const extracted = join(
        stage,
        "kubo",
        process.platform === "win32" ? "ipfs.exe" : "ipfs",
      );
      if (
        !(await lstat(extracted)).isFile() ||
        (await lstat(extracted)).isSymbolicLink()
      )
        throw new HostError("Invalid Kubo executable.");
      await secureNew(extracted);
      if (process.platform !== "win32") await chmod(extracted, 0o700);
      const version = await run(extracted, ["version", "--number"], {
        timeout: 10_000,
        windowsHide: true,
      });
      if (version.stdout.trim() !== KUBO_VERSION)
        throw new HostError("Kubo executable version mismatch.");
      await rename(extracted, executable);
      await writePrivate(directory, "installation.json", {
        version: KUBO_VERSION,
        hash: hash(await readFile(executable)),
      });
      return executable;
    } finally {
      await rm(stage, { recursive: true, force: true });
      await rm(archive, { force: true });
    }
  });
}
async function freePort(): Promise<number> {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new HostError("No free port."));
        return;
      }
      server.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
}
export async function prepareNode(
  stateDir: string,
  scope: string,
): Promise<KuboNode> {
  if (!/^[a-f0-9]{64}$/.test(scope))
    throw new HostError("Invalid service-bound local Scope identity.");
  const binary = await kuboBinary(stateDir);
  return prepareWithBinary(stateDir, scope, binary);
}
async function prepareWithBinary(
  stateDir: string,
  scope: string,
  binary: string,
): Promise<KuboNode> {
  const parent = await privateDirectory(stateDir, "swarm-nodes");
  const directory = await privateDirectory(parent, scope);
  return withPrivateLock(directory, async () => {
    const repo = await privateDirectory(directory, "repo");
    let record = await readPrivate<NodeRecord>(directory, "node.json");
    if (record === undefined) {
      try {
        await lstat(join(repo, "swarm.key"));
        throw new HostError(
          "Managed node record is missing; restore it before using the existing protected repo.",
        );
      } catch (cause) {
        if (!nodeError(cause, "ENOENT")) throw cause;
      }
      const env = { ...process.env, IPFS_PATH: repo, LIBP2P_FORCE_PNET: "1" };
      try {
        await lstat(join(repo, "config"));
      } catch (cause) {
        if (!nodeError(cause, "ENOENT")) throw cause;
        await run(binary, ["init", "--profile=server"], {
          env,
          timeout: 30_000,
          windowsHide: true,
        });
      }
      const config = JSON.parse(
        await readFile(join(repo, "config"), "utf8"),
      ) as {
        Identity: { PeerID: string; PrivKey: string };
        Addresses: Record<string, unknown>;
        Bootstrap: string[];
        Discovery: { MDNS: { Enabled: boolean } };
        Routing: { Type: string };
        AutoTLS?: { Enabled: boolean };
        AutoConf?: { Enabled: boolean };
        API?: {
          Authorizations?: Record<
            string,
            { AuthSecret: string; AllowedPaths: string[] }
          >;
        };
        AutoNAT?: { ServiceMode: string };
        Swarm: {
          AddrFilters: string[];
          DisableNatPortMap: boolean;
          EnableHolePunching: boolean;
          RelayClient: { Enabled: boolean };
          RelayService: { Enabled: boolean };
        };
      };
      record = {
        scope,
        peerId: config.Identity.PeerID,
        api: await freePort(),
        gateway: await freePort(),
        swarm: await freePort(),
        auth: uniqueId(),
      };
      config.Addresses = {
        API: `/ip4/127.0.0.1/tcp/${record.api}`,
        Gateway: `/ip4/127.0.0.1/tcp/${record.gateway}`,
        Swarm: [`/ip4/0.0.0.0/tcp/${record.swarm}`],
      };
      config.Bootstrap = [];
      config.Swarm.AddrFilters = [];
      config.Swarm.DisableNatPortMap = true;
      config.Swarm.EnableHolePunching = false;
      config.Swarm.RelayClient.Enabled = false;
      config.Swarm.RelayService.Enabled = false;
      config.API = {
        ...config.API,
        Authorizations: {
          IPAB: {
            AuthSecret: `bearer:${record.auth}`,
            AllowedPaths: ["/api/v0"],
          },
        },
      };
      if (config.AutoNAT) config.AutoNAT.ServiceMode = "disabled";
      config.Discovery.MDNS.Enabled = false;
      config.Routing.Type = "none";
      if (config.AutoTLS) config.AutoTLS.Enabled = false;
      if (config.AutoConf) config.AutoConf.Enabled = false;
      await writeFile(join(repo, "config"), JSON.stringify(config), {
        mode: 0o600,
      });
      await secureNew(join(repo, "config"));
      await writePrivate(directory, "node.json", record);
    }
    await protectedPath(join(repo, "config"));
    record = nodeRecord(record, scope);
    const local = Object.values(networkInterfaces())
      .flatMap((items) => items ?? [])
      .filter(
        (item) =>
          item.family === "IPv4" &&
          /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(
            item.address,
          ),
      )
      .map((item) => item.address)
      .slice(0, 15);
    return {
      repo,
      peerId: record.peerId,
      api: `http://127.0.0.1:${record.api}`,
      gateway: `http://127.0.0.1:${record.gateway}`,
      auth: record.auth,
      ...(record.pid !== undefined ? { pid: record.pid } : {}),
      addresses: [...new Set([...local, "127.0.0.1"])].map(
        (ip) => `/ip4/${ip}/tcp/${record.swarm}/p2p/${record.peerId}`,
      ),
    };
  });
}
export async function peerProof(
  node: KuboNode,
  message: string,
): Promise<{ publicKey: string; signature: string }> {
  await protectedPath(join(node.repo, "config"));
  const config = JSON.parse(
    await readFile(join(node.repo, "config"), "utf8"),
  ) as { Identity: { PrivKey: string } };
  const protobuf = Buffer.from(config.Identity.PrivKey, "base64");
  if (
    protobuf.length !== 68 ||
    !protobuf.subarray(0, 4).equals(Buffer.from([8, 1, 18, 64]))
  )
    throw new HostError("Only new Ed25519 Kubo identities are supported.");
  const privateKey = createPrivateKey({
    key: Buffer.concat([
      Buffer.from("302e020100300506032b657004220420", "hex"),
      protobuf.subarray(4, 36),
    ]),
    type: "pkcs8",
    format: "der",
  });
  const raw = createPublicKey(privateKey)
    .export({ format: "der", type: "spki" })
    .subarray(-32);
  if (peerId(raw.toString("base64url")) !== node.peerId)
    throw new HostError("Kubo identity mismatch.");
  return {
    publicKey: raw.toString("base64url"),
    signature: sign(null, Buffer.from(message), privateKey).toString(
      "base64url",
    ),
  };
}
export function peerId(raw: string): string {
  return base58btc
    .encode(
      Buffer.concat([
        Buffer.from([0, 36, 8, 1, 18, 32]),
        Buffer.from(raw, "base64url"),
      ]),
    )
    .slice(1);
}
async function rpc(
  node: KuboNode,
  command: string,
  signal?: AbortSignal,
  timeout = 5000,
): Promise<Response> {
  return fetch(`${node.api}/api/v0/${command}`, {
    method: "POST",
    headers: { authorization: `Bearer ${node.auth}` },
    redirect: "error",
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(timeout)])
      : AbortSignal.timeout(timeout),
  });
}
async function ready(node: KuboNode): Promise<boolean> {
  try {
    const response = await rpc(node, "id");
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel();
      throw new HostError(
        "Owned Kubo API authorization failed; refusing control.",
      );
    }
    if (!response.ok) {
      await response.body?.cancel();
      return false;
    }
    const identity = JSON.parse(await boundedText(response)) as { ID: string };
    if (identity.ID !== node.peerId)
      throw new HostError(
        "Selected Kubo port belongs to another node; refusing control.",
      );
    return true;
  } catch (cause) {
    if (cause instanceof HostError) throw cause;
    return false;
  }
}
export async function stopNode(node: KuboNode): Promise<void> {
  if (!(await ready(node))) return;
  await (await rpc(node, "shutdown")).body?.cancel();
  for (let i = 0; i < 100; i++) {
    const responsive = await ready(node);
    let alive = false;
    if (node.pid !== undefined) {
      try {
        process.kill(node.pid, 0);
        alive = true;
      } catch (cause) {
        if (!nodeError(cause, "ESRCH")) throw cause;
      }
    }
    if (!responsive && !alive) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new HostError("Owned Kubo node did not stop.");
}
export async function startNode(
  stateDir: string,
  scope: string,
  key: string,
  epoch: number,
  addresses: readonly string[],
  diagnostic?: (text: string) => void,
): Promise<KuboNode> {
  if (!/^[a-f0-9]{64}$/.test(scope))
    throw new HostError("Invalid service-bound local Scope identity.");
  if (!/^[a-f0-9]{64}$/.test(key)) throw new HostError("Invalid Swarm key.");
  const binary = await kuboBinary(stateDir);
  const node = await prepareWithBinary(stateDir, scope, binary);
  const directory = join(stateDir, "swarm-nodes", scope);
  return withPrivateLock(directory, async () => {
    const record = (await readPrivate<NodeRecord>(directory, "node.json"))!;
    if (record.epoch !== undefined && record.epoch !== epoch)
      await stopNode(node);
    const keyPath = join(node.repo, "swarm.key");
    if (record.epoch === epoch) {
      await protectedPath(keyPath);
      if (
        (await readFile(keyPath, "utf8")) !==
        `/key/swarm/psk/1.0.0/\n/base16/\n${key}\n`
      )
        throw new HostError("Swarm key file does not match approved epoch.");
    } else {
      await writeFile(keyPath, `/key/swarm/psk/1.0.0/\n/base16/\n${key}\n`, {
        mode: 0o600,
      });
      await secureNew(keyPath);
    }
    if (!(await ready(node))) {
      const logfile = join(directory, "daemon.log");
      const log = await open(logfile, "a", 0o600);
      await secureNew(logfile);
      const child = spawn(
        binary,
        ["daemon", "--enable-gc=false", "--migrate=false"],
        {
          env: { ...process.env, IPFS_PATH: node.repo, LIBP2P_FORCE_PNET: "1" },
          detached: true,
          windowsHide: true,
          stdio: ["ignore", log.fd, log.fd],
        },
      );
      let failure: Error | undefined;
      child.once("error", (error) => {
        failure = error;
      });
      const closed = new Promise<void>((resolve) => {
        child.once("close", () => {
          resolve();
        });
      });
      child.unref();
      await log.close();
      try {
        if (child.pid !== undefined) {
          record.pid = child.pid;
          node.pid = child.pid;
          record.epoch = epoch;
          await writePrivate(directory, "node.json", record);
        }
        for (let i = 0; ; i++) {
          if (failure) throw failure;
          if (await ready(node)) break;
          if (i >= 150 || child.exitCode !== null)
            throw new HostError(
              "Owned Kubo startup failed; inspect protected daemon.log.",
            );
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      } catch (cause) {
        child.kill();
        await Promise.race([
          closed,
          new Promise<void>((resolve) => setTimeout(resolve, 5000)),
        ]);
        if (child.exitCode === null && child.signalCode === null)
          child.kill("SIGKILL");
        await closed;
        throw cause;
      }
    }
    record.epoch = epoch;
    await writePrivate(directory, "node.json", record);
    const groups = new Map<string, string[]>();
    for (const address of addresses) {
      validateAddress(address);
      const target = address.split("/").at(-1)!;
      if (target === node.peerId) continue;
      const group = groups.get(target) ?? [];
      if (group.length < 16 && !group.includes(address)) group.push(address);
      groups.set(target, group);
    }
    const budget = AbortSignal.timeout(10_000);
    await Promise.all(
      [...groups.values()].map(async (group) => {
        const connected = new AbortController();
        await Promise.all(
          group.map(async (address) => {
            try {
              const response = await rpc(
                node,
                `swarm/connect?arg=${encodeURIComponent(address)}`,
                AbortSignal.any([budget, connected.signal]),
              );
              const ok = response.ok;
              if (!ok) {
                const reason = JSON.parse(await boundedText(response)) as {
                  Message?: string;
                };
                diagnostic?.(
                  `Swarm peer dial failed at ${address}: ${reason.Message?.slice(0, 512) ?? `HTTP ${response.status}`}`,
                );
              }
              await response.body?.cancel();
              if (ok) connected.abort();
            } catch (cause) {
              if (!connected.signal.aborted)
                diagnostic?.(
                  `Swarm peer dial unavailable at ${address}: ${cause instanceof Error ? cause.message : "network error"}`,
                );
              // An offline address must not hide a reachable address of the same PeerID.
              // Content reads still report actual network failure, not authorization failure.
            }
          }),
        );
      }),
    );
    return node;
  });
}
export function validateAddress(address: string, expectedPeer?: string): void {
  const match =
    /^\/ip4\/(\d+\.\d+\.\d+\.\d+)\/tcp\/([1-9]\d{0,4})\/p2p\/([A-Za-z0-9]+)$/.exec(
      address,
    );
  if (
    !match ||
    Number(match[2]) > 65535 ||
    match[1]!.split(".").some((n) => Number(n) > 255) ||
    (expectedPeer && match[3] !== expectedPeer)
  )
    throw new HostError(
      "LAN/VPN profile requires IPv4 TCP multiaddr bound to its PeerID.",
    );
}
export function kuboSource(node: KuboNode) {
  return {
    block: {
      async get(
        cid: string,
        options: { signal?: AbortSignal } = {},
      ): Promise<Uint8Array> {
        const response = await rpc(
          node,
          `block/get?arg=${encodeURIComponent(cid)}`,
          options.signal,
          30_000,
        );
        if (!response.ok || !response.body)
          throw new HostError(
            `Swarm block unavailable (HTTP ${response.status}).`,
          );
        const stream: ReadableStream<Uint8Array> = response.body;
        const reader = stream.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          for (;;) {
            const part = await reader.read();
            if (part.done) break;
            size += part.value.length;
            if (size > 2 * 1024 * 1024) {
              await reader.cancel();
              throw new HostError("Kubo block exceeds limit.");
            }
            chunks.push(part.value);
          }
        } finally {
          reader.releaseLock();
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.length;
        }
        return bytes;
      },
    },
  };
}
