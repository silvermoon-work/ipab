import { test, expect, vi } from "vitest";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import {
  copyFile,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  lstat,
  rm,
  writeFile,
} from "node:fs/promises";
import { protectAccountOnly } from "@ipab/bundle/pointer/protected-files";
import { join, resolve } from "node:path";
import { runCli } from "@ipab/cli";
import { appSchema } from "@ipab/cli/devtools";
import { encodeBundleCar, memoryTree } from "@ipab/bundle-builder";
import { CID } from "multiformats/cid";
import { ContentError, IpfsStore } from "@ipab/ipfs-store";
import {
  ownedNodes,
  shutdownOwned,
  nodeRuntime,
  type OwnedNode,
} from "./owned-nodes.ts";
import { createScopeService, API_KEY } from "./helpers.ts";

interface Result {
  code: number;
  out: string;
  err: string;
}
const runtime = { process: nodeRuntime() };
test(
  "real isolated Kubo onboarding, uncached two-way content, multi-private-net isolation and resumable removal",
  { tags: ["release-e2e"], timeout: 360_000 },
  async ({ signal, onTestFinished }) => {
    const base = resolve(".test-work");
    await mkdir(base, { recursive: true });
    const work = await mkdtemp(join(base, "onboarding-"));
    const states: string[] = [];
    let rejectHeadAllocation = false;
    const server = createServer((incoming, outgoing) => {
      void (async () => {
        const chunks: Uint8Array[] = [];
        let size = 0;
        for await (const chunk of incoming) {
          const bytes = Uint8Array.from(chunk as Uint8Array);
          size += bytes.length;
          if (size > 131072) throw new Error("oversized test request");
          chunks.push(bytes);
        }
        const body = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          body.set(chunk, offset);
          offset += chunk.length;
        }
        const headers = new Headers();
        for (const [k, value] of Object.entries(incoming.headers))
          if (typeof value === "string") headers.set(k, value);
        const url = `${origin}${incoming.url}`;
        const reject =
          rejectHeadAllocation &&
          incoming.method === "POST" &&
          /^\/v1\/[A-Za-z0-9_-]{43}$/.test(incoming.url ?? "") &&
          new TextDecoder().decode(body).includes('"root"');
        const response = reject
          ? Response.json(
              {
                error: {
                  code: "injected",
                  message: "interrupted after freeze",
                },
              },
              { status: 503 },
            )
          : await service.fetch(url, {
              method: incoming.method ?? "GET",
              headers,
              ...(size ? { body } : {}),
            });
        outgoing.writeHead(
          response.status,
          Object.fromEntries(response.headers),
        );
        outgoing.end(new Uint8Array(await response.arrayBuffer()));
      })().catch((cause: unknown) => {
        outgoing.writeHead(500);
        outgoing.end(String(cause));
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("no test port");
    const origin = `http://127.0.0.1:${address.port}`;
    const service = await createScopeService({ service: origin });
    const homes = {
      a: join(work, "a"),
      b: join(work, "b"),
      c: join(work, "c"),
    };
    for (const home of Object.values(homes)) {
      await mkdir(home);
      const state = join(home, "state");
      await mkdir(state);
      states.push(state);
      await writeFile(
        join(home, "content.json"),
        JSON.stringify({ backend: "local", dataDir: join(home, "content") }),
      );
    }
    let activeOperation: Promise<number> | undefined;
    const cli = async (
      who: "a" | "b" | "c",
      args: string[],
      expected = 0,
    ): Promise<Result> => {
      signal.throwIfAborted();
      vi.stubEnv("TASK_CONTENT_CONFIG", join(homes[who], "content.json"));
      let out = "",
        err = "";
      activeOperation = runCli(
        ["--json", ...args],
        {
          tty: false,
          out: (text) => {
            out += text + "\n";
          },
          err: (text) => {
            err += text + "\n";
          },
          confirm: () => Promise.resolve(true),
          readSecret: () => Promise.resolve(API_KEY),
        },
        {
          ...runtime.process.env,
          HOME: homes[who],
          USERPROFILE: homes[who],
          IPAB_STATE_DIR: join(homes[who], "state"),
        },
      );
      const code = await activeOperation;
      activeOperation = undefined;
      signal.throwIfAborted();
      expect(code, `${who}: ${args.join(" ")}\n${out}\n${err}`).toBe(expected);
      return { code, out, err };
    };
    const json = <T>(result: Result): T =>
      JSON.parse(result.out.trim().split("\n").at(-1)!) as T;
    const apiSecrets = new Map<number, string>();
    const discoveredStates = new Set<string>(),
      trackedNodes = new Map<string, OwnedNode>();
    const childCli = (
      who: "a" | "b" | "c",
      args: string[],
      jsonMode = true,
    ): Promise<Result> =>
      new Promise((resolve, reject) => {
        const child = spawn(
          runtime.process.execPath,
          [
            resolvePath("apps", "cli", "dist", "main.js"),
            ...(jsonMode ? ["--json"] : []),
            ...args,
          ],
          {
            env: {
              ...runtime.process.env,
              HOME: homes[who],
              USERPROFILE: homes[who],
              IPAB_STATE_DIR: join(homes[who], "state"),
              TASK_CONTENT_CONFIG: join(homes[who], "content.json"),
            },
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
            signal: AbortSignal.any([signal, AbortSignal.timeout(240_000)]),
          },
        );
        let out = "",
          err = "";
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (text: string) => {
          out += text;
        });
        child.stderr.on("data", (text: string) => {
          err += text;
        });
        child.once("error", reject);
        child.once("close", (code) => {
          resolve({ code: code ?? 1, out, err });
        });
      });
    const nodeRecords = async (state: string) => {
      const records = await ownedNodes(state, !discoveredStates.has(state));
      if (records.length) discoveredStates.add(state);
      for (const record of records) {
        apiSecrets.set(record.api, record.auth);
        trackedNodes.set(record.repo, record);
      }
      return records;
    };
    const rpc = (port: number, command: string) =>
      fetch(`http://127.0.0.1:${port}/api/v0/${command}`, {
        method: "POST",
        headers: { authorization: `Bearer ${apiSecrets.get(port) ?? ""}` },
        signal: AbortSignal.timeout(15_000),
      });
    const hasLocalBlock = async (
      port: number,
      cid: string,
    ): Promise<boolean> => {
      const response = await rpc(port, "refs/local");
      if (!response.ok)
        throw new Error(
          "Could not inspect this test node's local block inventory.",
        );
      // Blockstore inventory may reconstruct raw CIDs; codec is not part of its storage key.
      const expected = CID.parse(cid).multihash.bytes;
      return (await response.text())
        .split(/\r?\n/)
        .filter(Boolean)
        .some((line) => {
          const value = JSON.parse(line) as { Ref: string };
          const actual = CID.parse(value.Ref).multihash.bytes;
          return (
            actual.length === expected.length &&
            actual.every((byte, index) => byte === expected[index])
          );
        });
    };
    const makeContent = async (who: "a" | "b" | "c", label: string) => {
      const data = `${label}-${crypto.randomUUID()}`;
      const car = await encodeBundleCar(
        memoryTree(
          new Map([
            [
              ".bundle.yaml",
              new TextEncoder().encode(
                "title: Test\nentry: data.txt\ntype: .bundle-type.yaml\n",
              ),
            ],
            [
              ".bundle-type.yaml",
              new TextEncoder().encode("contentType: text/plain\n"),
            ],
            ["data.txt", new TextEncoder().encode(data)],
          ]),
        ),
      );
      const path = join(homes[who], `${label}.car`);
      try {
        await writeFile(path, car.stream);
      } finally {
        await car.close();
      }
      const result = await cli(who, ["bundle", "import", path]);
      return { cid: json<{ cid: string }>(result).cid, data };
    };
    const storeHasBlock = async (
      who: "a" | "b" | "c",
      cid: string,
    ): Promise<boolean> => {
      try {
        const file = await lstat(
          join(
            homes[who],
            "content",
            "blocks",
            CID.parse(cid).toV1().toString(),
          ),
        );
        if (!file.isFile() || file.isSymbolicLink())
          throw new Error("Invalid local Store block file.");
      } catch (cause) {
        if (
          cause instanceof Error &&
          "code" in cause &&
          cause.code === "ENOENT"
        )
          return false;
        throw cause;
      }
      const store = new IpfsStore({
        backend: "local",
        dataDir: join(homes[who], "content"),
      });
      try {
        await store.block.get(cid);
        return true;
      } catch (cause) {
        if (cause instanceof ContentError && cause.code === "missing_block")
          return false;
        throw cause;
      } finally {
        await store.close();
      }
    };
    const makeApp = async (label: string) => {
      const source = await makeContent("b", `${label}-source`);
      const marker = `${label}-${crypto.randomUUID()}`;
      const car = await encodeBundleCar(
        memoryTree(
          new Map([
            [
              ".bundle.yaml",
              new TextEncoder().encode(
                "title: Rotation App\nentry: app.json\ntype: .bundle-type.yaml\n",
              ),
            ],
            [
              ".bundle-type.yaml",
              new TextEncoder().encode(JSON.stringify(appSchema)),
            ],
            [
              "app.json",
              new TextEncoder().encode(
                JSON.stringify({
                  name: label,
                  version: "1.0.0",
                  entry: "resources/app.cjs",
                  source: { cid: source.cid },
                }),
              ),
            ],
            [
              "resources/app.cjs",
              new TextEncoder().encode(
                `process.stdout.write(${JSON.stringify(marker + "\n")});\n`,
              ),
            ],
          ]),
        ),
      );
      const path = join(homes.b, `${label}.car`);
      try {
        await writeFile(path, car.stream);
      } finally {
        await car.close();
      }
      const result = await cli("b", ["bundle", "import", path]);
      return { cid: json<{ cid: string }>(result).cid, source, marker };
    };
    let primaryFailure: Error | undefined;
    const cleanupErrors: unknown[] = [];
    let cleanupPromise: Promise<void> | undefined;
    const cleanup = () =>
      (cleanupPromise ??= (async () => {
        rejectHeadAllocation = false;
        vi.unstubAllEnvs();
        for (const state of states) {
          try {
            await nodeRecords(state);
          } catch (cause) {
            cleanupErrors.push(cause);
          }
        }
        for (const node of trackedNodes.values()) {
          try {
            await shutdownOwned(node);
            console.log(
              `Owned PID ${node.pid ?? "(not started)"} stopped: ${node.peerId}`,
            );
          } catch (cause) {
            cleanupErrors.push(cause);
          }
        }
        server.closeAllConnections();
        await new Promise<void>((resolve) => {
          server.close(() => {
            resolve();
          });
        });
        if (!cleanupErrors.length) {
          try {
            await rm(work, { recursive: true, force: true });
          } catch (cause) {
            cleanupErrors.push(cause);
          }
        }
      })());
    onTestFinished(async () => {
      if (activeOperation) await activeOperation;
      await cleanup();
      if (cleanupErrors.length)
        throw new AggregateError(
          cleanupErrors,
          `Owned-node cleanup failed: ${work}`,
        );
    }, 60_000);
    try {
      const programCache = runtime.process.env.IPAB_TEST_KUBO_PROGRAM_CACHE;
      if (programCache) {
        const directory = join(states[0]!, "kubo-bin");
        await mkdir(directory);
        await protectAccountOnly(directory);
        const executable =
          runtime.process.platform === "win32" ? "ipfs.exe" : "ipfs";
        for (const file of [executable, "installation.json"]) {
          await copyFile(join(programCache, file), join(directory, file));
          await protectAccountOnly(join(directory, file));
        }
        if (runtime.process.platform !== "win32")
          await chmod(join(directory, executable), 0o700);
        console.log(
          "Reusing only the prior checksum-installed program; setup verifies its executable hash. New identities, stores and repos remain isolated.",
        );
      }
      const setup = json<{ publicKey: string; fingerprint: string }>(
        await cli("a", ["setup", "--yes"]),
      );
      await cli("a", ["config", "set", "pointers.service", origin]);
      await cli("a", ["config", "set", "pointers.apiKey", "-"]);
      const creation = await childCli("a", [
        "swarm",
        "create",
        "--alias",
        "work",
        "--name",
        "Team",
      ]);
      expect(creation.code, creation.err).toBe(0);
      const url = json<{ configUrl: string }>(creation).configUrl;
      const ownerStatus = json<{
        ownerFingerprint: string;
        owner: string;
        peerId: string;
      }>(await cli("a", ["swarm", "status", "work"]));
      expect(ownerStatus.ownerFingerprint).toBe(setup.fingerprint);
      console.log("Device setup and CLI-owned detached node ready.");
      // Reuse only the installed executable on this physical test device, not
      // identity, repo, PSK, Store blocks, ports or daemon state.
      const executable =
        runtime.process.platform === "win32" ? "ipfs.exe" : "ipfs";
      for (const state of states.slice(1)) {
        const binary = join(state, "kubo-bin");
        await mkdir(binary);
        await protectAccountOnly(binary);
        for (const filename of [executable, "installation.json"]) {
          await copyFile(
            join(states[0]!, "kubo-bin", filename),
            join(binary, filename),
          );
          await protectAccountOnly(join(binary, filename));
        }
        if (runtime.process.platform !== "win32")
          await chmod(join(binary, executable), 0o700);
      }
      const requestFile = join(work, "request.json");
      await cli("b", [
        "swarm",
        "request",
        url,
        "--owner-fingerprint",
        ownerStatus.ownerFingerprint,
        "--alias",
        "work",
        "--name",
        "B",
        "--output",
        requestFile,
      ]);
      const exactRequest = await readFile(requestFile, "utf8");
      await cli("b", [
        "swarm",
        "export",
        "work",
        "--output",
        join(work, "request-again.json"),
      ]);
      expect(await readFile(join(work, "request-again.json"), "utf8")).toBe(
        exactRequest,
      );
      await cli("b", ["swarm", "status", "work"], 1);
      const approval = await cli("a", [
        "swarm",
        "approve",
        requestFile,
        "--yes",
      ]);
      const summaryRequest = JSON.parse(exactRequest) as {
        name: string;
        member: string;
        peerId: string;
        requestedAt: string;
      };
      for (const value of [
        summaryRequest.name,
        summaryRequest.member,
        summaryRequest.peerId,
        summaryRequest.requestedAt,
      ])
        expect(approval.err).toContain(value);
      const repeated = await cli("a", [
        "swarm",
        "approve",
        requestFile,
        "--yes",
      ]);
      expect(repeated.err).toContain("Previously approved Request");
      const first = await makeContent("a", "a-fresh");
      await cli("a", [
        "--swarm",
        "work",
        "publish",
        first.cid,
        "--name",
        "notes/a",
        "--snapshot",
      ]);
      const memberStatus = json<{ peerId: string }>(
        await cli("b", ["swarm", "status", "work"]),
      );
      await cli("b", ["swarm", "update", "work", "--name", "NotOwner"], 1);
      await cli("a", ["swarm", "update", "work", "--name", "Renamed"]);
      await cli("b", ["swarm", "profile", "work", "--name", "Team"]);
      expect(memberStatus.peerId).not.toBe(ownerStatus.peerId);
      const nodesA = await nodeRecords(states[0]!),
        nodesB = await nodeRecords(states[1]!);
      const a = nodesA[0]!,
        b = nodesB[0]!;
      expect(
        (await fetch(`http://127.0.0.1:${a.api}/api/v0/id`, { method: "POST" }))
          .ok,
      ).toBe(false);
      expect(await hasLocalBlock(b.api, first.cid)).toBe(false);
      expect(await storeHasBlock("b", first.cid)).toBe(false);
      const outputA = join(homes.b, "from-a");
      await cli("b", [
        "get",
        "--force",
        "ipab://work/notes/a",
        "--output",
        outputA,
      ]);
      expect(await readFile(join(outputA, "data.txt"), "utf8")).toBe(
        first.data,
      );
      expect(await hasLocalBlock(b.api, first.cid)).toBe(true);
      expect(await storeHasBlock("b", first.cid)).toBe(true);
      console.log(`A->B uncached Store/Kubo transfer PASS: ${first.cid}`);
      const second = await makeContent("b", "b-fresh");
      await cli("b", [
        "--swarm",
        "work",
        "publish",
        second.cid,
        "--name",
        "notes/b",
        "--snapshot",
      ]);
      expect(await hasLocalBlock(a.api, second.cid)).toBe(false);
      expect(await storeHasBlock("a", second.cid)).toBe(false);
      const outputB = join(homes.a, "from-b");
      await cli("a", [
        "get",
        "--force",
        "ipab://work/notes/b",
        "--output",
        outputB,
      ]);
      expect(await readFile(join(outputB, "data.txt"), "utf8")).toBe(
        second.data,
      );
      expect(await hasLocalBlock(a.api, second.cid)).toBe(true);
      expect(await storeHasBlock("a", second.cid)).toBe(true);
      console.log(`B->A uncached Store/Kubo transfer PASS: ${second.cid}`);
      // A real CLI child exits while its already-owned daemon remains responsive.
      const childResult = await new Promise<number | null>(
        (resolve, reject) => {
          const child = spawn(
            runtime.process.execPath,
            [
              resolvePath("apps", "cli", "dist", "main.js"),
              "--json",
              "swarm",
              "status",
              "work",
            ],
            {
              env: {
                ...runtime.process.env,
                HOME: homes.a,
                USERPROFILE: homes.a,
                IPAB_STATE_DIR: states[0]!,
                TASK_CONTENT_CONFIG: join(homes.a, "content.json"),
              },
              stdio: "ignore",
              windowsHide: true,
            },
          );
          child.once("error", reject);
          child.once("close", resolve);
        },
      );
      expect(childResult).toBe(0);
      expect((await rpc(a.api, "id")).ok).toBe(true);
      const requestC = join(work, "request-c.json");
      await cli("c", [
        "swarm",
        "request",
        url,
        "--owner-fingerprint",
        ownerStatus.ownerFingerprint,
        "--alias",
        "work",
        "--name",
        "C",
        "--output",
        requestC,
      ]);
      await cli("a", ["swarm", "approve", requestC, "--yes"]);
      await cli("c", ["swarm", "status", "work"]);
      const c = (await nodeRecords(states[2]!))[0]!;
      await shutdownOwned(c);
      const secondUrl = json<{ configUrl: string }>(
        await cli("a", ["swarm", "create", "--alias", "other"]),
      ).configUrl;
      expect(secondUrl).not.toBe(url);
      const all = await nodeRecords(states[0]!);
      expect(all).toHaveLength(2);
      expect(new Set(all.map((n) => n.api)).size).toBe(2);
      expect(new Set(all.map((n) => n.peerId)).size).toBe(2);
      const other = all.find((n) => n.peerId !== a.peerId)!;
      const keyA = await readFile(join(a.repo, "swarm.key"), "utf8"),
        keyOther = await readFile(join(other.repo, "swarm.key"), "utf8");
      expect(keyA).not.toBe(keyOther);
      expect(
        await readFile(
          join(states[0]!, "kubo-bin", "installation.json"),
          "utf8",
        ),
      ).toContain("0.43.2");
      const connect = await rpc(
        other.api,
        `swarm/connect?arg=${encodeURIComponent(`/ip4/127.0.0.1/tcp/${a.swarm}/p2p/${a.peerId}`)}`,
      ).then(
        (response) => response.ok,
        () => false,
      );
      expect(connect).toBe(false);
      const last = await makeContent("b", "last-before-freeze");
      await cli("b", [
        "--swarm",
        "work",
        "publish",
        last.cid,
        "--name",
        "notes/final",
        "--snapshot",
      ]);
      expect(await hasLocalBlock(a.api, last.cid)).toBe(false);
      const appOld = await makeApp("app-old");
      const oldArtifact = json<{ cid: string }>(
        await cli("b", [
          "--swarm",
          "work",
          "publish",
          appOld.cid,
          "--name",
          "apps/final",
        ]),
      ).cid;
      const appLast = await makeApp("app-final");
      await cli("b", [
        "--swarm",
        "work",
        "publish",
        appLast.cid,
        "--name",
        "apps/final",
        "--expect",
        oldArtifact,
      ]);
      for (const cid of [
        appOld.cid,
        appOld.source.cid,
        appLast.cid,
        appLast.source.cid,
      ]) {
        expect(await hasLocalBlock(a.api, cid)).toBe(false);
        expect(await storeHasBlock("a", cid)).toBe(false);
      }
      const before = JSON.parse(await (await fetch(url)).text()) as {
        value: {
          headId: string;
          scopeId: string;
          members: { publicKey: string; profileId: string }[];
        };
      };
      rejectHeadAllocation = true;
      const request = JSON.parse(exactRequest) as { member: string };
      await cli(
        "a",
        ["--swarm", "work", "swarm", "exclude", request.member, "--yes"],
        1,
      );
      const oldHeadUrl = `${origin}/v1/${before.value.scopeId}/${before.value.headId}`;
      const frozen = JSON.parse(await (await fetch(oldHeadUrl)).text()) as {
        status: string;
        value: { root: string };
      };
      expect(frozen.status).toBe("frozen");
      console.log("Old HEAD frozen; allocation interruption persisted.");
      rejectHeadAllocation = false;
      await cli("a", ["swarm", "resume", "work"]);
      expect((await fetch(oldHeadUrl)).status).toBe(410);
      const final = json<{ epoch: number; root: string }>(
        await cli("a", ["swarm", "status", "work"]),
      );
      expect(final.epoch).toBe(2);
      expect(final.root).toBe(frozen.value.root);
      console.log(
        "Owner resume reached epoch 2 with identical final publication.",
      );
      const departedProfile = before.value.members.find(
        (member) => member.publicKey === request.member,
      )!.profileId;
      expect(
        (await fetch(`${origin}/v1/${before.value.scopeId}/${departedProfile}`))
          .status,
      ).toBe(410);
      const finalDirectory = join(homes.a, "final-before-freeze");
      await cli("a", [
        "get",
        "--force",
        "ipab://work/notes/final",
        "--output",
        finalDirectory,
      ]);
      expect(await readFile(join(finalDirectory, "data.txt"), "utf8")).toBe(
        last.data,
      );
      const appDirectory = join(homes.a, "app-after-rotation");
      await cli("a", [
        "get",
        "--force",
        "ipab://work/apps/final",
        "--output",
        appDirectory,
      ]);
      const execution = await childCli(
        "a",
        ["--swarm", "work", "exec", "--force", "ipab://work/apps/final"],
        false,
      );
      expect(execution.code, execution.err).toBe(0);
      expect(execution.out).toContain(appLast.marker);
      console.log(
        "Non-snapshot Artifact/App executable recovered after old network retirement.",
      );
      for (const item of [appOld, appLast]) {
        const directory = join(homes.a, `${item.marker}-source`);
        await cli("a", [
          "--swarm",
          "work",
          "get",
          item.source.cid,
          "--output",
          directory,
        ]);
        expect(await readFile(join(directory, "data.txt"), "utf8")).toBe(
          item.source.data,
        );
      }
      const third = await makeContent("a", "after-rotation");
      await cli("a", [
        "--swarm",
        "work",
        "publish",
        third.cid,
        "--name",
        "notes/new",
        "--snapshot",
      ]);
      await cli("b", ["--swarm", "work", "search", "new", "--force"], 1);
      const returnedC = json<{ epoch: number; peerId: string }>(
        await cli("c", ["swarm", "status", "work"]),
      );
      expect(returnedC.epoch).toBe(2);
      expect(returnedC.peerId).toBe(c.peerId);
      const remainingExecution = await childCli(
        "c",
        ["--swarm", "work", "exec", "--force", "ipab://work/apps/final"],
        false,
      );
      expect(remainingExecution.code, remainingExecution.err).toBe(0);
      expect(remainingExecution.out).toContain(appLast.marker);
      console.log(
        "Offline remaining member resumed with new package, key and App execution.",
      );
      const fromC = await makeContent("c", "remaining-member");
      await cli("c", [
        "--swarm",
        "work",
        "publish",
        fromC.cid,
        "--name",
        "notes/c",
        "--snapshot",
      ]);
      // Explicit reapproval of the same old non-expiring Request is allowed.
      await cli("a", ["swarm", "approve", requestFile, "--yes", "--again"]);
      await cli("b", ["swarm", "status", "work"]);
      expect((await nodeRecords(states[1]!))[0]!.epoch).toBe(2);
      console.log(
        `Kubo ${"0.43.2"}: A->B ${first.cid}, B->A ${second.cid}; both receiver refs/local inventory misses verified before fetch; separate 2 Scope repos/PeerIDs/keys/ports; CLI child exit retained daemon; uncached last pre-freeze publication preserved; interruption resumed to epoch 2, old HEAD/profile 410, old Request reapproved.`,
      );
    } catch (cause) {
      primaryFailure =
        cause instanceof Error
          ? cause
          : new Error("Onboarding test failed", { cause });
    } finally {
      await cleanup();
    }
    if (cleanupErrors.length)
      throw new AggregateError(
        primaryFailure === undefined
          ? cleanupErrors
          : [primaryFailure, ...cleanupErrors],
        `Owned-node cleanup failed; preserving isolated evidence at ${work}`,
      );
    if (primaryFailure !== undefined) throw primaryFailure;
  },
);
function resolvePath(...parts: string[]): string {
  return resolve("..", "..", ...parts);
}
