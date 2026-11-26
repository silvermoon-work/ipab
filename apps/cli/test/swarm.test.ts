import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { IpfsStore, type IpfsStoreOptions } from "@ipab/ipfs-store";
import type * as StoreModule from "@ipab/ipfs-store";
import { CarBlockIterator } from "@ipld/car/iterator";
import * as dagCbor from "@ipld/dag-cbor";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import {
  encodeBundleCar,
  memoryTree,
  streamChunks,
} from "@ipab/bundle-builder";
import {
  generateKeyPair,
  randomBytes,
  toBase64Url,
} from "@ipab/bundle/pointer/crypto";
import {
  approveMembership,
  artifactType,
  createSwarm,
  descriptor,
  joinSwarm,
  jsonBundle,
  pointer,
  publish,
  requestMembership,
  readSnapshot,
  requestType,
  resolveReference,
  responseType,
  typedJson,
  type Artifact,
  type SwarmContext,
} from "../src/swarm.js";
import { getBundle } from "../src/get.js";
import { appSchema } from "../src/app-definition.js";
import type { Identity } from "../src/identity.js";
import type * as IdentityModule from "../src/identity.js";
import { cli } from "./helpers.js";
import { writeCar } from "../src/authoring.js";

const ports = vi.hoisted(() => ({
  identity: vi.fn<(env: NodeJS.ProcessEnv) => Promise<Identity>>(),
  store: undefined as IpfsStore | undefined,
}));
vi.mock("@ipab/ipfs-store", async () => {
  const actual = await vi.importActual<typeof StoreModule>("@ipab/ipfs-store");
  return {
    ...actual,
    IpfsStore: class extends actual.IpfsStore {
      constructor(options: IpfsStoreOptions) {
        super(options);
        if (ports.store) return ports.store;
      }
    },
  };
});
vi.mock("../src/identity.js", async () => ({
  ...(await vi.importActual<typeof IdentityModule>("../src/identity.js")),
  accountIdentity: ports.identity,
  protectedPath: () => Promise.resolve(),
  secureNew: () => Promise.resolve(),
}));

describe(
  "client swarm workflow with mocked identity/retention/network ports",
  { tags: ["mock"] },
  () => {
    const origin = "https://pointers.example";
    const fixtureId = toBase64Url(new Uint8Array(32).fill(5));
    const noteType = {
      name: "Note",
      description: "",
      entry: {
        path: "entry.json",
        contentType: "application/json",
        schema: { type: "object" },
      },
    } as const;
    let work: string, store: IpfsStore, a: SwarmContext, b: SwarmContext;
    let root = "",
      revision = 1,
      creates = 0,
      failProvide = false,
      provideCalls = 0;
    let identities: Map<string, Identity>;
    beforeEach(async () => {
      await mkdir(resolve(".test-work"), { recursive: true });
      work = await mkdtemp(join(resolve(".test-work"), "swarm-mock-"));
      identities = new Map();
      for (const home of ["a", "b", "c"]) {
        const keys = await generateKeyPair();
        identities.set(home, {
          publicKey: keys.publicRaw,
          privateKey: keys.privatePkcs8,
        });
      }
      ports.identity.mockImplementation((env) => {
        const identity = identities.get(env.HOME ?? "");
        if (!identity) throw new Error("Unknown isolated identity");
        return Promise.resolve(identity);
      });
      const apiKey = toBase64Url(randomBytes(32));
      store = IpfsStore.fromClient({
        block: {
          get: () => Promise.reject(new Error("Missing mocked content")),
        },
      });
      ports.store = store;
      vi.spyOn(store, "registerOwner").mockImplementation(() => undefined);
      vi.spyOn(store, "retain").mockResolvedValue(undefined);
      vi.spyOn(store, "close").mockResolvedValue(undefined);
      root = "";
      revision = 1;
      creates = 0;
      provideCalls = 0;
      failProvide = false;
      const fetcher: typeof fetch = async (input, options) => {
        const request = new Request(input, options);
        if (new URL(request.url).pathname.startsWith("/api/v0/dag/import")) {
          provideCalls++;
          if (failProvide) return new Response("unavailable", { status: 503 });
          const file = (await request.formData()).get("file");
          if (!(file instanceof Blob)) throw new Error("Missing provider CAR");
          const car = await CarBlockIterator.fromBytes(
            new Uint8Array(await file.arrayBuffer()),
          );
          const roots = await car.getRoots();
          return new Response(
            roots
              .map((cid) =>
                JSON.stringify({
                  Root: { Cid: { "/": cid.toString() }, PinErrorMsg: "" },
                }),
              )
              .join("\n"),
          );
        }
        if (request.method === "POST") {
          const body = (await request.json()) as { root: string };
          root = body.root;
          creates++;
          return new Response(JSON.stringify({ id: fixtureId }), {
            status: 201,
            headers: { location: `/v1/pointers/${fixtureId}` },
          });
        }
        if (request.method === "PUT") {
          if (request.headers.get("if-match") !== `"${revision}"`)
            return new Response(
              JSON.stringify({
                error: {
                  code: "precondition_failed",
                  details: { root, revision: String(revision) },
                },
              }),
              { status: 412, headers: { etag: `"${revision}"` } },
            );
          root = ((await request.json()) as { root: string }).root;
          revision++;
        }
        return new Response(
          JSON.stringify({ root, revision: String(revision) }),
          { headers: { etag: `"${revision}"` } },
        );
      };
      const context = async (home: string) => {
        const stateDir = join(work, home);
        await mkdir(stateDir);
        return {
          store,
          stateDir,
          env: { HOME: home },
          provider: "http://127.0.0.1:5001",
          fetch: fetcher,
          pointerService: origin,
          pointerApiKey: apiKey,
        };
      };
      a = await context("a");
      b = await context("b");
      vi.stubGlobal("fetch", fetcher);
      const contentConfig = join(work, "store.json");
      await writeFile(
        contentConfig,
        JSON.stringify({ backend: "local", dataDir: join(work, "content") }),
      );
      vi.stubEnv("TASK_CONTENT_CONFIG", contentConfig);
    });
    afterEach(async () => {
      vi.restoreAllMocks();
      ports.identity.mockReset();
      ports.store = undefined;
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      await store.close();
      await rm(work, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    });
    const local = (reference: string) => reference;
    it("retries only network failures, reports bounded CAS contention, and preserves candidates on service errors", async () => {
      const swarm = await createSwarm(a);
      const original = a.fetch!;
      let attempts = 0;
      a.fetch = (input, options) => {
        const request = new Request(input, options);
        if (request.method === "GET" && attempts++ < 2)
          return Promise.reject(new TypeError("network"));
        return original(input, options);
      };
      await (await pointer(a, swarm)).read();
      expect(attempts).toBe(3);
      const content = await jsonBundle(store, noteType, { text: "retained" });
      a.fetch = (input, options) => {
        const request = new Request(input, options);
        if (request.method === "PUT")
          return Promise.resolve(
            new Response(
              JSON.stringify({
                error: {
                  code: "precondition_failed",
                  message: "changed",
                  details: { root, revision: String(revision) },
                },
              }),
              { status: 412, headers: { etag: `"${revision}"` } },
            ),
          );
        return original(input, options);
      };
      await expect(
        publish(a, content, { swarm, name: "busy" }),
      ).rejects.toThrow("HEAD is busy");
      a.fetch = (input, options) => {
        const request = new Request(input, options);
        if (request.method === "PUT")
          return Promise.resolve(
            new Response(
              '{"error":{"code":"internal","message":"storage failure"}}',
              { status: 500 },
            ),
          );
        return original(input, options);
      };
      await expect(
        publish(a, content, { swarm, name: "unconfirmed" }),
      ).rejects.toThrow("result is unknown");
      await expect(publish(a, content, { snapshot: true })).rejects.toThrow(
        "require --name",
      );
      await expect(publish(a, content, { name: "named" })).rejects.toThrow(
        "requires --swarm",
      );
      await expect(
        publish(a, content, { name: "../unsafe", swarm }),
      ).rejects.toThrow("Unsafe");
    });
    it("rejects invalid publication/state data instead of treating it as an empty name table", async () => {
      const block = async (value: unknown) => {
        const bytes = dagCbor.encode(value);
        const cid = CID.createV1(dagCbor.code, await sha256.digest(bytes));
        await store.put(cid, bytes);
        return cid;
      };
      await expect(
        readSnapshot(store, await jsonBundle(store, noteType, {})),
      ).rejects.toThrow("DAG-CBOR");
      await expect(
        readSnapshot(store, (await block({ v: 1 })).toString()),
      ).rejects.toThrow("publication");
      for (const value of [
        { v: 2, properties: { name: "", description: "" }, names: {} },
        { v: 1, properties: { name: 1, description: "" }, names: {} },
        {
          v: 1,
          properties: { name: "", description: "" },
          names: { test: "not-a-CID" },
        },
        {
          v: 1,
          properties: { name: "", description: "" },
          names: { "../bad": await block({}) },
        },
      ]) {
        const state = await block(value);
        const publication = await block({ v: 1, state });
        await expect(
          readSnapshot(store, publication.toString()),
        ).rejects.toThrow();
      }
    });
    it("routes the new CLI create/request/approve/join/status/publish/get commands through configured ports", async () => {
      const env = {
        HOME: "a",
        IPAB_POINTERS_SERVICE: origin,
        IPAB_POINTERS_API_KEY: a.pointerApiKey!,
        IPAB_SWARM_PROVIDER: a.provider,
      };
      const create = await cli(
        a.stateDir,
        [
          "--json",
          "swarm",
          "create",
          "--name",
          "test",
          "--description",
          "owned",
        ],
        { env },
      );
      expect(create.code, create.err).toBe(0);
      const swarm = (JSON.parse(create.out) as { cid: string }).cid;
      const memberEnv = { HOME: "b", IPAB_SWARM_PROVIDER: b.provider };
      const requested = await cli(
        b.stateDir,
        ["--json", "swarm", "request", swarm],
        { env: memberEnv },
      );
      expect(requested.code, requested.err).toBe(0);
      const request = (JSON.parse(requested.out) as { cid: string }).cid;
      expect(
        (await cli(a.stateDir, ["swarm", "approve", request], { env })).code,
      ).toBe(1);
      expect(
        (
          await cli(a.stateDir, ["swarm", "approve", request], {
            env,
            tty: true,
            confirm: () => Promise.resolve(false),
          })
        ).code,
      ).toBe(1);
      const approved = await cli(
        a.stateDir,
        ["--json", "swarm", "approve", request, "--yes", "--expires-in", "600"],
        { env },
      );
      expect(approved.code, approved.err).toBe(0);
      const response = (JSON.parse(approved.out) as { cid: string }).cid;
      expect(
        (await cli(b.stateDir, ["swarm", "join", response], { env: memberEnv }))
          .code,
      ).toBe(0);
      expect(
        (await cli(b.stateDir, ["swarm", "status"], { env: memberEnv })).code,
      ).toBe(2);
      expect(
        (
          await cli(b.stateDir, ["--json", "swarm", "status", swarm], {
            env: memberEnv,
          })
        ).code,
      ).toBe(0);
      const payload = await jsonBundle(store, noteType, { text: "Hello" });
      const published = await cli(
        a.stateDir,
        [
          "--swarm",
          swarm,
          "--json",
          "publish",
          payload,
          "--name",
          "documents/hello",
        ],
        { env },
      );
      expect(published.code, published.err).toBe(0);
      const node = (JSON.parse(published.out) as { cid: string }).cid;
      const downloaded = await cli(
        b.stateDir,
        [
          "--swarm",
          swarm,
          "--json",
          "get",
          "name:documents/hello",
          "-o",
          join(work, "cli-get"),
        ],
        { env: memberEnv },
      );
      expect(downloaded.code, downloaded.err).toBe(0);
      expect(JSON.parse(downloaded.out)).toMatchObject({
        targetCid: node,
        cid: payload,
      });
      expect(
        (
          await cli(
            b.stateDir,
            [
              "--swarm",
              swarm,
              "get",
              "--raw",
              "name:documents/hello",
              "-o",
              join(work, "raw-get"),
            ],
            { env: memberEnv },
          )
        ).code,
      ).toBe(0);
      const encoded = await encodeBundleCar(
        memoryTree(
          new Map([
            [
              ".bundle.yaml",
              new TextEncoder().encode(JSON.stringify(noteType)),
            ],
            ["entry.json", new TextEncoder().encode('{"text":"CAR"}')],
          ]),
        ),
      );
      const car = join(work, "content.car");
      await writeCar(encoded, car);
      expect((await cli(a.stateDir, ["publish", car], { env })).code).toBe(0);
    });
    it("creates, grants membership, publishes versions, and gets content/raw without implicit source fetch", async () => {
      const swarm = await createSwarm(a);
      expect((await descriptor(store, swarm)).variable).toBe(fixtureId);
      const request = await requestMembership(b, swarm);
      await expect(approveMembership(b, request)).rejects.toThrow("Only");
      const response = await approveMembership(a, request);
      expect(await joinSwarm(b, response)).toBe(swarm);
      expect(await joinSwarm(b, response)).toBe(swarm);
      const v1 = await jsonBundle(store, noteType, { text: "Hello" });
      const node1 = await publish(a, v1, { swarm, name: "documents/hello" });
      expect(
        await resolveReference(b, "name:documents/hello", swarm, local),
      ).toEqual({ targetCid: node1, cid: v1 });
      const directory = await getBundle(store, v1, join(work, "get"));
      expect(
        JSON.parse(await readFile(join(directory, "entry.json"), "utf8")),
      ).toEqual({ text: "Hello" });
      await expect(getBundle(store, v1, directory)).rejects.toThrow(
        "not empty",
      );
      const v2 = await jsonBundle(store, noteType, { text: "Welcome" });
      const node2 = await publish(b, v2, {
        swarm,
        name: "documents/hello",
        expect: node1,
      });
      expect(
        await typedJson<Artifact>(store, node2, artifactType),
      ).toMatchObject({ value: v2, previous: node1 });
      expect(
        (await resolveReference(a, "name:documents/hello", swarm, local, true))
          .cid,
      ).toBe(node2);
      await expect(
        publish(a, v1, { swarm, name: "documents/hello", expect: node1 }),
      ).rejects.toMatchObject({ code: "EDIT_CONFLICT" });
      expect(await publish(a, v1, {})).toBe(v1);
      expect(
        await publish(a, v1, {
          swarm,
          name: "documents/snapshot",
          snapshot: true,
        }),
      ).toBe(v1);
      const encoded = await encodeBundleCar(
        memoryTree(
          new Map([
            [
              ".bundle.yaml",
              new TextEncoder().encode(JSON.stringify(appSchema)),
            ],
            [
              "app.json",
              new TextEncoder().encode(
                JSON.stringify({
                  name: "app",
                  version: "1.0.0",
                  description: "",
                  entry: "resources/app.cjs",
                  source: {
                    cid: "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku",
                  },
                }),
              ),
            ],
            [
              "resources/app.cjs",
              new TextEncoder().encode('console.log("Hello");'),
            ],
          ]),
        ),
      );
      try {
        const car = await CarBlockIterator.fromIterable(
          streamChunks(encoded.stream),
        );
        for await (const block of car) await store.put(block.cid, block.bytes);
        await getBundle(
          store,
          encoded.cid.toString(),
          join(work, "app-with-unavailable-source"),
        );
      } finally {
        await encoded.close();
      }
    });
    it("retains a returned pointer ID and resumes descriptor provision without reallocating", async () => {
      const original = a.fetch!;
      a.fetch = async (input, options) => {
        if (
          new URL(
            input instanceof Request ? input.url : input.toString(),
          ).pathname.startsWith("/api/v0/dag/import") &&
          creates === 1 &&
          provideCalls === 1
        )
          return new Response("unavailable", { status: 503 });
        return original(input, options);
      };
      const error = await createSwarm(a).catch((cause: unknown) => cause);
      if (!(error instanceof Error))
        throw new Error("Expected unconfirmed creation");
      const operation = /--resume ([A-Za-z0-9_-]+)/.exec(error.message)?.[1];
      expect(operation).toBeDefined();
      expect(creates).toBe(1);
      a.fetch = original;
      const swarm = await createSwarm(a, { resume: operation! });
      expect((await descriptor(store, swarm)).variable).toBe(fixtureId);
      expect(creates).toBe(1);
    });
    it("rejects foreign origin, mismatched requests/certificates and unauthorized Name lookups", async () => {
      await expect(
        createSwarm(a, { service: "https://other.example" }),
      ).rejects.toThrow("configured origin");
      const swarm = await createSwarm(a);
      const request = await requestMembership(b, swarm);
      const response = await approveMembership(a, request);
      const c = { ...b, env: { HOME: "c" } };
      await expect(joinSwarm(c, response)).rejects.toThrow(
        "exact pending request",
      );
      const savedResponse = await typedJson<{
        swarm: string;
        request: string;
        certificate: unknown;
      }>(store, response, responseType);
      const tampered = await jsonBundle(store, responseType, {
        ...savedResponse,
        certificate: { body: {}, sig: "invalid" },
      });
      await expect(joinSwarm(b, tampered)).rejects.toThrow("certificate");
      const savedRequest = await typedJson<Record<string, unknown>>(
        store,
        request,
        requestType,
      );
      const invalid = await jsonBundle(store, requestType, {
        ...savedRequest,
        signature: "invalid",
      });
      await expect(approveMembership(a, invalid)).rejects.toThrow(
        "possession proof",
      );
      await expect(approveMembership(a, request, 1)).rejects.toThrow(
        "duration",
      );
      await expect(
        resolveReference(a, "name:missing", undefined, local),
      ).rejects.toThrow("require");
      await expect(
        resolveReference(a, "name:missing", swarm, local),
      ).rejects.toThrow("not present");
      await expect(
        publish(a, await jsonBundle(store, noteType, {}), { expect: swarm }),
      ).rejects.toThrow("require --name");
      await expect(pointer(c, swarm)).rejects.toThrow();
      failProvide = true;
      await expect(
        publish(a, await jsonBundle(store, noteType, {}), {
          swarm,
          name: "not-shared",
        }),
      ).rejects.toThrow("provider");
    });
  },
);
