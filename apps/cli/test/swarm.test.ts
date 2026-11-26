import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { IpfsStore } from "@ipab/ipfs-store";
import { CarBlockIterator } from "@ipld/car/iterator";
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

const ports = vi.hoisted(() => ({
  identity: vi.fn<(env: NodeJS.ProcessEnv) => Promise<Identity>>(),
}));
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
      vi.spyOn(store, "registerOwner").mockImplementation(() => undefined);
      vi.spyOn(store, "retain").mockResolvedValue(undefined);
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
    });
    afterEach(async () => {
      vi.restoreAllMocks();
      ports.identity.mockReset();
      await store.close();
      await rm(work, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    });
    const local = (reference: string) => reference;
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
