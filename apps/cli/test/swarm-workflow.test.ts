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
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { IpfsStore } from "@ipab/ipfs-store";
import {
  generateKeyPair,
  signEd25519,
  type KeyPair,
} from "@ipab/bundle/pointer/crypto";
import { uniqueId, valueCid, type Variable } from "@ipab/bundle/pointer/scope";
import type * as IdentityModule from "../src/identity.js";
import type * as KuboModule from "../src/kubo.js";
import type * as ProviderModule from "../src/content-provider.js";
import type { Identity } from "../src/identity.js";
import type { KuboNode } from "../src/kubo.js";
import { State } from "../src/state.js";
import {
  addSwarm,
  approveMembership,
  createSwarm,
  exportRequest,
  frozenPublicationClosure,
  jsonBundle,
  pointer,
  publish,
  removeMember,
  requestMembership,
  resolveReference,
  resumeRemoval,
  searchNames,
  swarmHeader,
  updateProfile,
  updateSwarm,
  type SwarmContext,
} from "../src/swarm.js";

const ports = vi.hoisted(() => ({
  identities: new Map<string, Identity>(),
  nodes: new Map<string, { node: KuboNode; key: KeyPair }>(),
  provide:
    vi.fn<
      (
        store: IpfsStore,
        roots: readonly string[],
        endpoint: string,
      ) => Promise<void>
    >(),
  start: vi.fn<(state: string) => Promise<KuboNode>>(),
}));
vi.mock("../src/identity.js", async () => ({
  ...(await vi.importActual<typeof IdentityModule>("../src/identity.js")),
  accountIdentity: (env: NodeJS.ProcessEnv) => {
    const identity = ports.identities.get(env.HOME ?? "");
    return identity
      ? Promise.resolve(identity)
      : Promise.reject(new Error("missing identity"));
  },
  protectedPath: async (path: string) => {
    await lstat(path);
  },
  secureNew: () => Promise.resolve(),
}));
vi.mock("../src/kubo.js", async () => ({
  ...(await vi.importActual<typeof KuboModule>("../src/kubo.js")),
  prepareNode: (state: string) => Promise.resolve(ports.nodes.get(state)!.node),
  startNode: ports.start,
  peerProof: (node: KuboNode, message: string) => {
    const record = [...ports.nodes.values()].find(
      (record) => record.node === node,
    )!;
    return signEd25519(record.key.privateKey, message).then((signature) => ({
      publicKey: record.key.publicRaw,
      signature,
    }));
  },
}));
vi.mock("../src/content-provider.js", async () => ({
  ...(await vi.importActual<typeof ProviderModule>(
    "../src/content-provider.js",
  )),
  provideContent: ports.provide,
}));
vi.mock("node:sqlite", () => ({
  DatabaseSync: class {
    exec() {}
    close() {}
  },
}));
vi.mock("../src/state.js", () => ({
  State: class {
    aliases = new Map<string, string>();
    headers = new Map<string, unknown>();
    close() {}
    checkSwarmAlias(alias: string, url?: string) {
      if (this.aliases.has(alias) && this.aliases.get(alias) !== url)
        throw new Error("alias conflict");
    }
    registerSwarm(url: string, alias?: string) {
      if (alias) {
        this.checkSwarmAlias(alias, url);
        this.aliases.set(alias, url);
      }
    }
    resolveSwarm(value: string) {
      return this.aliases.get(value) ?? value;
    }
    swarmHeader(account: string, url: string) {
      return this.headers.get(`${account}:${url}`);
    }
    saveSwarmHeader(account: string, url: string, value: unknown) {
      this.headers.set(`${account}:${url}`, value);
    }
    invalidateSwarmHeader(url: string) {
      for (const key of this.headers.keys())
        if (key.endsWith(url)) this.headers.delete(key);
    }
  },
}));
interface Resource extends Variable {
  id: string;
}
const localName = (url: string) =>
  `${createHash("sha256").update(url).digest("hex")}.json`;
describe("onboarding recovery and authorization", { tags: ["mock"] }, () => {
  let root: string,
    store: IpfsStore,
    owner: SwarmContext,
    member: SwarmContext,
    url: string,
    configId: string;
  let variables: Map<string, Resource>;
  let fail: ((request: Request) => Response | Error | undefined) | undefined;
  let scopeOwner: string;
  beforeEach(async () => {
    vi.clearAllMocks();
    ports.identities.clear();
    ports.nodes.clear();
    fail = undefined;
    const base = resolve(".test-work");
    await mkdir(base, { recursive: true });
    root = await mkdtemp(join(base, "swarm-workflow-"));
    store = IpfsStore.fromClient({
      block: { get: () => Promise.reject(new Error("missing block")) },
    });
    vi.spyOn(store, "close").mockResolvedValue();
    vi.spyOn(store, "withLocalSource").mockReturnValue(store);
    ports.provide.mockResolvedValue();
    ports.start.mockImplementation((state) =>
      Promise.resolve(ports.nodes.get(state)!.node),
    );
    variables = new Map();
    const fetcher: typeof fetch = async (input, init) => {
      const request = new Request(input, init),
        fault = fail?.(request);
      if (fault instanceof Error) throw fault;
      if (fault) return fault;
      const parts = new URL(request.url).pathname.split("/").filter(Boolean);
      if (parts[1] === "scopes") {
        const id = uniqueId();
        scopeOwner = request.headers.get("x-ipab-subject")!;
        return Response.json({ id, owner: scopeOwner }, { status: 201 });
      }
      if (parts.length === 2 && request.method === "GET")
        return Response.json({ owner: scopeOwner });
      if (parts.length === 2 && request.method === "POST") {
        const data = (await request.json()) as { value: unknown },
          id = uniqueId();
        const resource: Resource = {
          id,
          value: data.value as Variable["value"],
          cid: await valueCid(data.value),
          status: "writable",
        };
        variables.set(id, resource);
        return Response.json(resource, { status: 201 });
      }
      const resource = variables.get(parts[2]!);
      if (!resource)
        return Response.json(
          { error: { code: "not_found", message: "missing" } },
          { status: 404 },
        );
      if (resource.status === "deleted")
        return Response.json(
          { error: { code: "deleted", message: "deleted" } },
          { status: 410 },
        );
      if (request.method === "PUT") {
        if (resource.status === "frozen")
          return Response.json(
            { error: { code: "frozen", message: "frozen" } },
            { status: 423 },
          );
        if (request.headers.get("if-match") !== `"${resource.cid}"`)
          return Response.json(
            { error: { code: "cas_conflict", message: "changed" } },
            { status: 412 },
          );
        const data = (await request.json()) as { value: Variable["value"] };
        resource.value = data.value;
        resource.cid = await valueCid(data.value);
      } else if (request.method === "POST") resource.status = "frozen";
      else if (request.method === "DELETE") resource.status = "deleted";
      return Response.json(resource);
    };
    const context = async (name: string): Promise<SwarmContext> => {
      const stateDir = join(root, name);
      await mkdir(stateDir);
      const identity = await generateKeyPair(),
        nodeKey = await generateKeyPair();
      ports.identities.set(name, {
        publicKey: identity.publicRaw,
        privateKey: identity.privatePkcs8,
      });
      const { peerId } =
        await vi.importActual<typeof KuboModule>("../src/kubo.js");
      const node: KuboNode = {
        repo: join(stateDir, "repo"),
        peerId: peerId(nodeKey.publicRaw),
        api: "http://127.0.0.1:55001",
        gateway: "http://127.0.0.1:55002",
        auth: uniqueId(),
        addresses: [],
      };
      ports.nodes.set(stateDir, { node, key: nodeKey });
      return {
        store,
        stateDir,
        env: { HOME: name },
        state: new State(stateDir),
        pointerService: "https://scope.example",
        pointerApiKey: uniqueId(),
        fetch: fetcher,
        diagnostic: () => {},
      };
    };
    owner = await context("owner");
    member = await context("member");
    url = await createSwarm(owner, {
      properties: { name: "Organization", description: "" },
      alias: "work",
    });
    configId = url.split("/").at(-1)!;
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await store.close();
    await rm(root, { recursive: true, force: true });
  });
  const credentials = (context: SwarmContext) =>
    join(context.stateDir, "swarm-credentials");
  async function saved(context: SwarmContext, name = localName(url)) {
    return JSON.parse(
      await readFile(join(credentials(context), name), "utf8"),
    ) as Record<string, unknown>;
  }
  async function replace(
    context: SwarmContext,
    value: unknown,
    name = localName(url),
  ) {
    await writeFile(join(credentials(context), name), JSON.stringify(value));
  }
  async function request() {
    const identity = ports.identities.get("owner")!,
      { keyId } = await import("@ipab/bundle/pointer/crypto");
    const path = join(root, "request.json");
    await requestMembership(member, url, {
      ownerFingerprint: await keyId(identity.publicKey),
      output: path,
      alias: "work",
      name: "Member",
    });
    return path;
  }
  async function joined() {
    const path = await request();
    await approveMembership(owner, path);
    await swarmHeader(member, url, true);
    return path;
  }
  const config = () => variables.get(configId)!;
  async function changeConfig(value: unknown) {
    config().value = value as Variable["value"];
    config().cid = await valueCid(value);
  }
  it("requires trusted Owner confirmation, preserves the exact saved Request and rejects another identity or target", async () => {
    await expect(
      requestMembership(member, url, { ownerFingerprint: "wrong" }),
    ).rejects.toThrow("fingerprint");
    const path = await request(),
      first = await readFile(path, "utf8");
    const out = join(root, "again.json");
    const { keyId } = await import("@ipab/bundle/pointer/crypto");
    await requestMembership(member, url, {
      ownerFingerprint: await keyId(ports.identities.get("owner")!.publicKey),
      output: out,
    });
    expect(await readFile(out, "utf8")).toBe(first);
    const record = await saved(member);
    await replace(member, {
      ...record,
      account: ports.identities.get("owner")!.publicKey,
    });
    await expect(request()).rejects.toThrow("different identity");
    await expect(exportRequest(member, url, join(root, "out"))).rejects.toThrow(
      "No local Request",
    );
    await expect(
      exportRequest(owner, url, join(root, "owner-request")),
    ).rejects.toThrow("no Request");
  });
  it("rejects malformed, oversized and tampered Request proofs before approval", async () => {
    const path = await request(),
      record = JSON.parse(await readFile(path, "utf8")) as Record<
        string,
        unknown
      >;
    for (const data of [
      { ...record, v: 2 },
      { ...record, extra: true },
      { ...record, member: "bad" },
      { ...record, signature: "bad" },
      { ...record, peerSignature: "bad" },
      { ...record, peerId: "wrong" },
    ]) {
      await writeFile(path, JSON.stringify(data));
      await expect(approveMembership(owner, path)).rejects.toThrow();
    }
    await writeFile(path, "x".repeat(16385));
    await expect(approveMembership(owner, path)).rejects.toThrow("16 KiB");
  });
  it("only allows Owner approval and management while members can change their own profile", async () => {
    const path = await joined();
    await expect(approveMembership(member, path)).rejects.toThrow("Only");
    await expect(
      updateSwarm(member, url, { name: "not owner" }),
    ).rejects.toThrow("Only");
    await expect(
      removeMember(member, url, ports.identities.get("owner")!.publicKey),
    ).rejects.toThrow("Only");
    const profile = await updateProfile(member, url, {
      name: "Renamed",
      addresses: [],
    });
    expect(profile.name).toBe("Renamed");
    await expect(
      removeMember(owner, url, ports.identities.get("owner")!.publicKey),
    ).rejects.toThrow("Owner removal");
    await expect(removeMember(owner, url, uniqueId())).rejects.toThrow(
      "Unknown member",
    );
    await expect(resumeRemoval(member, url)).rejects.toThrow("No resumable");
  });
  it("recovers approval retries, gives only a duplicate hint and refuses a fresh intent while one is unconfirmed", async () => {
    const path = await request();
    fail = (request) =>
      request.method === "PUT" && request.url.endsWith(configId)
        ? new TypeError("network down")
        : undefined;
    await expect(approveMembership(owner, path)).rejects.toThrow(
      "network down",
    );
    await expect(
      approveMembership(owner, path, { again: true }),
    ).rejects.toThrow("unconfirmed");
    fail = undefined;
    expect(await approveMembership(owner, path)).toBe(url);
    const diagnostics: string[] = [];
    owner.diagnostic = (text) => {
      diagnostics.push(text);
    };
    expect(await approveMembership(owner, path)).toBe(url);
    expect(diagnostics.join()).toContain("Previously approved");
    expect(await approveMembership(owner, path, { again: true })).toBe(url);
  });
  it("refuses corrupted advisory history or saved operations instead of overwriting a different approval", async () => {
    const path = await request(),
      req = JSON.parse(await readFile(path, "utf8")) as { id: string };
    await approveMembership(owner, path);
    const name = `approval-${req.id}.json`,
      record = await saved(owner, name);
    await replace(owner, { ...record, owner: uniqueId() }, name);
    await expect(approveMembership(owner, path)).rejects.toThrow(
      "differs from advisory",
    );
    await replace(owner, { ...record, completed: false, request: {} }, name);
    await expect(approveMembership(owner, path)).rejects.toThrow(
      "exact Request",
    );
  });
  it("does not trust missing packages, changed Owner roots, rolled-back epochs or unrelated request bindings", async () => {
    await request();
    await expect(swarmHeader(member, url)).rejects.toThrow(
      "No approved package",
    );
    const path = join(root, "request.json");
    await approveMembership(owner, path);
    await swarmHeader(member, url, true);
    const original = config().value;
    const data = original as Record<string, unknown>;
    scopeOwner = ports.identities.get("member")!.publicKey;
    await expect(swarmHeader(member, url, true)).rejects.toThrow(
      "immutable Scope",
    );
    scopeOwner = ports.identities.get("owner")!.publicKey;
    await changeConfig({ ...data, owner: scopeOwner, epoch: 0 });
    await expect(swarmHeader(member, url, true)).rejects.toThrow(
      "configuration",
    );
    await changeConfig(original);
    const record = await saved(member);
    await replace(member, { ...record, config: { ...data, epoch: 2 } });
    await expect(swarmHeader(member, url, true)).rejects.toThrow("rollback");
    await replace(member, record);
    const members = data.members as Record<string, unknown>[];
    await changeConfig({
      ...data,
      members: members.map((item) =>
        item.publicKey === ports.identities.get("member")!.publicKey
          ? { ...item, requestId: uniqueId() }
          : item,
      ),
    });
    await expect(swarmHeader(member, url, true)).rejects.toThrow(
      "saved Request",
    );
  });
  it("refreshes an authorization rejection once but leaves ordinary CAS and transport errors distinct", async () => {
    await joined();
    const head = await pointer(member, url),
      current = await head.read();
    let rejected = false,
      configReads = 0;
    fail = (request) => {
      if (request.method === "GET" && request.url.endsWith(configId))
        configReads++;
      if (request.method === "PUT" && !rejected) {
        rejected = true;
        return Response.json(
          { error: { code: "forbidden", message: "denied" } },
          { status: 403 },
        );
      }
      return undefined;
    };
    expect(
      (await head.write(current.root, current.cid, uniqueId())).status,
    ).toBe("writable");
    expect(configReads).toBe(1);
    configReads = 0;
    fail = (request) => {
      if (request.method === "GET" && request.url.endsWith(configId))
        configReads++;
      return request.method === "PUT"
        ? Response.json(
            { error: { code: "cas_conflict", message: "changed" } },
            { status: 412 },
          )
        : undefined;
    };
    await expect(
      head.write(current.root, current.cid, uniqueId()),
    ).rejects.toMatchObject({ status: 412 });
    expect(configReads).toBe(0);
    fail = (request) =>
      request.method === "PUT" ? new TypeError("network outage") : undefined;
    await expect(
      head.write(current.root, current.cid, uniqueId()),
    ).rejects.toThrow("network outage");
  });
  it("replaces stale HEAD authorization after a resource switch and makes callers recompute CAS", async () => {
    await joined();
    const head = await pointer(member, url),
      current = await head.read();
    let rejected = false;
    fail = (request) => {
      if (request.method === "PUT" && !rejected) {
        rejected = true;
        const data = config().value as Record<string, unknown>;
        data.headId = uniqueId();
        return Response.json(
          { error: { code: "frozen", message: "frozen" } },
          { status: 423 },
        );
      }
      return undefined;
    };
    await expect(
      head.write(current.root, current.cid, uniqueId()),
    ).rejects.toThrow();
  });
  it("reuses valid caches, refreshes a missing Name once, and diagnoses malformed HEAD/State reads", async () => {
    const first = await swarmHeader(owner, url),
      second = await swarmHeader(owner, url);
    expect(first.source).toBe("network");
    expect(second.source).toBe("cache");
    await expect(
      resolveReference(owner, "ipab://work/missing", url, (value) => value),
    ).rejects.toThrow("not found");
    const data = config().value as Record<string, unknown>,
      id = data.headId as string;
    variables.get(id)!.value = { wrong: true };
    await expect(swarmHeader(owner, url, true)).rejects.toThrow("HEAD");
  });
  it("persists creation recovery, binds it to this Owner/service, and never allocates a replacement for unknown recovery", async () => {
    await expect(createSwarm(owner, { resume: uniqueId() })).rejects.toThrow(
      "Unknown creation",
    );
    const directory = credentials(owner),
      name = (await readdir(directory)).find((name) =>
        name.startsWith("creation-"),
      )!;
    const op = name.slice("creation-".length, -".json".length),
      record = await saved(owner, name);
    expect(await createSwarm(owner, { resume: op })).toBe(url);
    await replace(owner, { ...record, owner: uniqueId() }, name);
    await expect(createSwarm(owner, { resume: op })).rejects.toThrow(
      "another Owner",
    );
    await expect(
      createSwarm(owner, { service: "https://foreign.example" }),
    ).rejects.toThrow("origin-bound");
    const withoutKey = { ...owner };
    delete withoutKey.pointerApiKey;
    await expect(createSwarm(withoutKey)).rejects.toThrow();
    await expect(createSwarm(owner, { resume: "invalid" })).rejects.toThrow(
      "resume",
    );
    await expect(addSwarm(member, url, "work")).rejects.toThrow(
      "No local Request",
    );
  });
  it("blocks normal Owner changes while a switch is incomplete and validates its closure before retirement", async () => {
    const record = {
      owner: ports.identities.get("owner")!.publicKey,
      url,
      operation: uniqueId(),
      completed: false,
    };
    await replace(owner, record, `transition-${localName(url)}`);
    await expect(updateSwarm(owner, url, { name: "blocked" })).rejects.toThrow(
      "incomplete",
    );
    await expect(swarmHeader(owner, url, true)).rejects.toThrow("incomplete");
    await replace(
      owner,
      { ...record, completed: true },
      `transition-${localName(url)}`,
    );
    await resumeRemoval(owner, url);
  });
  it("keeps publish conflicts separate from import/transport failure and retains the explicit candidate baseline", async () => {
    const content = await jsonBundle(
      store,
      { contentType: "application/json" },
      { hello: true },
    );
    await expect(publish(owner, content, { name: "name" })).rejects.toThrow(
      "selected Swarm",
    );
    await expect(
      publish(owner, content, { swarm: url, snapshot: true }),
    ).rejects.toThrow("require --name");
    await expect(
      publish(owner, content, {
        swarm: url,
        name: "name",
        snapshot: true,
        expect: content,
      }),
    ).rejects.toThrow("occupied");
    await publish(owner, content, { swarm: url, name: "name", snapshot: true });
    await expect(
      publish(owner, content, { swarm: url, name: "name", snapshot: true }),
    ).rejects.toMatchObject({ code: "EDIT_CONFLICT" });
    ports.provide.mockRejectedValueOnce(new Error("import failed"));
    await expect(publish(owner, content, { swarm: url })).rejects.toThrow(
      "import failed",
    );
    fail = (request) =>
      request.method === "PUT" ? new TypeError("result unknown") : undefined;
    await expect(
      publish(owner, content, { swarm: url, name: "new", snapshot: true }),
    ).rejects.toMatchObject({ code: "HEAD_UNCONFIRMED" });
    fail = (request) =>
      request.method === "PUT"
        ? Response.json(
            { error: { code: "cas_conflict", message: "busy" } },
            { status: 412 },
          )
        : undefined;
    await expect(
      publish(owner, content, { swarm: url, name: "new", snapshot: true }),
    ).rejects.toThrow("busy");
  });
  it("bounds public text/profile input and does not accept unknown update or search targets", async () => {
    await expect(updateSwarm(owner, url, {})).rejects.toThrow("requires name");
    await expect(
      updateSwarm(owner, url, { name: "x".repeat(257) }),
    ).rejects.toThrow("limit");
    await expect(
      updateProfile(owner, url, { name: "x".repeat(257) }),
    ).rejects.toThrow("256");
    await expect(
      updateProfile(owner, url, { addresses: Array<string>(17).fill("bad") }),
    ).rejects.toThrow("16");
    await expect(
      updateProfile(owner, url, { addresses: ["invalid"] }),
    ).rejects.toThrow("multiaddr");
    await expect(searchNames(owner, "\u0000", [])).rejects.toThrow("controls");
    await expect(
      requestMembership(member, url, {
        ownerFingerprint: "",
        name: "x".repeat(257),
      }),
    ).rejects.toThrow("256");
    await expect(frozenPublicationClosure(store, uniqueId())).rejects.toThrow();
  });
  it("rejects damaged organization/member/bootstrap records rather than silently replacing its pinned trust root", async () => {
    const original = config().value as Record<string, unknown>,
      members = original.members as Record<string, unknown>[];
    const first = members[0]!;
    for (const value of [
      { ...original, v: 2 },
      { ...original, extra: true },
      { ...original, scopeId: uniqueId() },
      { ...original, owner: "invalid" },
      { ...original, name: 3 },
      { ...original, description: 3 },
      { ...original, headId: "invalid" },
      { ...original, epoch: "1" },
      { ...original, bootstrap: null },
      { ...original, members: [] },
      { ...original, members: [first, first] },
      { ...original, members: [{ ...first, encryptionKey: 3 }] },
      { ...original, members: [{ ...first, profileId: "bad" }] },
      { ...original, members: [{ ...first, requestId: "bad" }] },
      {
        ...original,
        members: [
          { ...first, publicKey: ports.identities.get("member")!.publicKey },
        ],
      },
      { ...original, bootstrap: [123] },
      { ...original, bootstrap: ["not-a-multiaddr"] },
      { ...original, bootstrap: ["/ip4/10.0.0.1/tcp/4001/p2p/Foreign"] },
    ]) {
      await changeConfig(value);
      await expect(swarmHeader(owner, url, true)).rejects.toThrow();
    }
    await changeConfig(original);
    const record = await saved(owner);
    delete record.secret;
    await replace(owner, record);
    await expect(swarmHeader(owner, url, true)).rejects.toThrow(
      "no system recovery",
    );
  });
  it("rejects corrupt public profiles or changed PeerID binding before selecting a provider", async () => {
    const data = config().value as Record<string, unknown>,
      first = (data.members as Record<string, unknown>[])[0]!;
    const profile = variables.get(first.profileId as string)!,
      original = profile.value;
    for (const value of [
      { name: "Profile", addresses: [], updatedAt: "invalid" },
      {
        name: "Profile",
        addresses: [],
        updatedAt: new Date().toISOString(),
        extra: true,
      },
      {
        name: "Profile",
        addresses: [123],
        updatedAt: new Date().toISOString(),
      },
      {
        name: "Profile",
        addresses: ["/ip4/10.0.0.1/tcp/4001/p2p/Foreign"],
        updatedAt: new Date().toISOString(),
      },
    ]) {
      profile.value = value;
      await expect(swarmHeader(owner, url, true)).rejects.toThrow();
    }
    profile.value = original;
    const node = ports.nodes.get(owner.stateDir)!.node;
    ports.start.mockResolvedValueOnce({ ...node, peerId: "wrong" });
    await expect(swarmHeader(owner, url, true)).rejects.toThrow(
      "PeerID differs",
    );
  });
  it("rejects lost pending requests, tampered encrypted packages and changed saved Owner bindings", async () => {
    const path = await joined(),
      record = await saved(member),
      original = config().value as Record<string, unknown>;
    const localRequest = record.request as Record<string, unknown>;
    await replace(member, {
      ...record,
      request: { ...localRequest, peerId: "wrong" },
    });
    await expect(swarmHeader(member, url, true)).rejects.toThrow(
      "saved Request",
    );
    await replace(member, {
      ...record,
      owner: ports.identities.get("member")!.publicKey,
    });
    await expect(swarmHeader(member, url, true)).rejects.toThrow(
      "Pinned Owner",
    );
    await replace(member, record);
    const members = original.members as Record<string, unknown>[];
    const currentMember = members.find(
      (item) => item.publicKey === ports.identities.get("member")!.publicKey,
    )!;
    const approval = currentMember.approval as Record<string, unknown>;
    await changeConfig({
      ...original,
      members: members.map((item) =>
        item === currentMember
          ? { ...item, approval: { ...approval, signature: "A".repeat(86) } }
          : item,
      ),
    });
    await expect(swarmHeader(member, url, true)).rejects.toThrow("signature");
    await changeConfig(original);
    const raw = JSON.parse(await readFile(path, "utf8")) as Record<
      string,
      unknown
    >;
    const peerRecord = ports.nodes.get(member.stateDir)!;
    const { importPrivateKeyPkcs8 } =
      await import("@ipab/bundle/pointer/crypto");
    const changed = {
      ...raw,
      owner: ports.identities.get("member")!.publicKey,
    };
    const body = Object.fromEntries(
      Object.entries(changed).filter(
        ([key]) => key !== "signature" && key !== "peerSignature",
      ),
    );
    const peerSignature = await signEd25519(
      peerRecord.key.privateKey,
      JSON.stringify(["IPAB-REQUEST/1", body]),
    );
    const signature = await signEd25519(
      await importPrivateKeyPkcs8(ports.identities.get("member")!.privateKey),
      JSON.stringify(["IPAB-REQUEST-MEMBER/1", body, peerSignature]),
    );
    await writeFile(
      path,
      JSON.stringify({ ...body, peerSignature, signature }),
    );
    await expect(approveMembership(owner, path)).rejects.toThrow(
      "different Owner",
    );
  });
  it("never retires an old HEAD when a resumable switch lacks its complete closure, and tolerates already-retired resource replies", async () => {
    await joined();
    const memberKey = ports.identities.get("member")!.publicKey;
    fail = (request) =>
      request.method === "POST" &&
      new URL(request.url).pathname.split("/").filter(Boolean).length === 2
        ? Response.json(
            { error: { code: "unavailable", message: "allocation failed" } },
            { status: 503 },
          )
        : undefined;
    await expect(removeMember(owner, url, memberKey)).rejects.toThrow(
      "incomplete",
    );
    fail = undefined;
    const name = `transition-${localName(url)}`,
      record = await saved(owner, name);
    const missing = { ...record };
    delete missing.finalClosureRoots;
    await replace(owner, missing, name);
    await expect(resumeRemoval(owner, url)).rejects.toThrow(
      "closure is missing",
    );
    await replace(owner, { ...record, url: "https://other.example" }, name);
    await expect(resumeRemoval(owner, url)).rejects.toThrow("owned by");
    await replace(owner, record, name);
    const old = record.oldConfig as Record<string, unknown>,
      members = old.members as Record<string, unknown>[];
    const profile = members.find((item) => item.publicKey === memberKey)!
      .profileId as string;
    const head = old.headId as string;
    fail = (request) =>
      (request.method === "DELETE" &&
        (request.url.endsWith(profile) || request.url.endsWith(head))) ||
      (request.method === "POST" && request.url.endsWith(`${profile}/freeze`))
        ? Response.json(
            { error: { code: "deleted", message: "already retired" } },
            { status: 410 },
          )
        : undefined;
    await resumeRemoval(owner, url);
    expect((await saved(owner, name)).completed).toBe(true);
  });
  it("keeps network failures in profile retirement resumable rather than reporting them as successful cleanup", async () => {
    await joined();
    const data = config().value as Record<string, unknown>,
      members = data.members as Record<string, unknown>[];
    const profile = members.find(
      (item) => item.publicKey === ports.identities.get("member")!.publicKey,
    )!.profileId as string;
    fail = (request) =>
      request.method === "POST" && request.url.endsWith(`${profile}/freeze`)
        ? new TypeError("retirement network failed")
        : undefined;
    await expect(
      removeMember(owner, url, ports.identities.get("member")!.publicKey),
    ).rejects.toThrow("retirement network failed");
    expect(
      (await saved(owner, `transition-${localName(url)}`)).completed,
    ).not.toBe(true);
    fail = undefined;
    await resumeRemoval(owner, url);
    expect((await saved(owner, `transition-${localName(url)}`)).completed).toBe(
      true,
    );
  });
  it("rejects explicit PeerID rebinding and duplicate active peer identities during fresh approval", async () => {
    const path = await joined(),
      original = config().value as Record<string, unknown>;
    const members = original.members as Record<string, unknown>[];
    await changeConfig({
      ...original,
      members: members.map((item) =>
        item.publicKey === ports.identities.get("member")!.publicKey
          ? { ...item, peerId: "NewPeer" }
          : item,
      ),
    });
    await expect(
      approveMembership(owner, path, { again: true }),
    ).rejects.toThrow("rebinding");
    await changeConfig(original);
    const name = (await readdir(credentials(owner))).find((name) =>
      name.startsWith("approval-"),
    )!;
    await rm(join(credentials(owner), name));
    const request = JSON.parse(await readFile(path, "utf8")) as Record<
      string,
      unknown
    >;
    await changeConfig({
      ...original,
      members: [{ ...members[0], peerId: request.peerId }],
    });
    await expect(approveMembership(owner, path)).rejects.toThrow(
      "assigned to another",
    );
  });
  it("uses an independently owned State when none is passed and distinguishes missing selection, cache and artifact format failures", async () => {
    const context = { ...owner };
    delete context.state;
    expect((await swarmHeader(context, url)).head.root).toBeTruthy();
    await expect(
      resolveReference(owner, "ipab:///missing", undefined, (value) => value),
    ).rejects.toThrow("Select");
    const plain = await jsonBundle(
      store,
      { contentType: "application/json" },
      { not: "Artifact" },
    );
    await expect(
      publish(owner, plain, { swarm: url, name: "update", expect: plain }),
    ).rejects.toThrow("Bundle type");
    await expect(searchNames(owner, "", [])).rejects.toThrow("1..256");
  });
});
