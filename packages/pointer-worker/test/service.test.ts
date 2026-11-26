import { describe, expect, it } from "vitest";
import { AdminClient } from "../src/client.ts";
import { PointerObject } from "../src/pointer-object.ts";
import { RegistryObject } from "../src/registry-object.ts";
import { MAX_VALUE_BYTES } from "../src/protocol.ts";
import { generateKeyPair, randomBytes, toBase64Url } from "../src/crypto.ts";
import type { Env } from "../src/index.ts";
import {
  MemoryStorage,
  NOW,
  authContext,
  createService,
  makeCert,
  responseJson,
  signedRequest,
  testContext,
  world,
} from "./helpers.ts";

const BASE = "https://pointer.example";

function createProvider() {
  return async (options: Parameters<typeof createService>[0] = {}) => {
    const adminKeys = await generateKeyPair();
    const service = createService({
      adminPublicKey: adminKeys.publicRaw,
      ...options,
    });
    const admin = new AdminClient({
      baseUrl: BASE,
      signer: { privateKey: adminKeys.privatePkcs8, subject: "admin" },
      fetch: service.fetch,
    });
    return { service, admin, adminKeys };
  };
}

const provide = createProvider();

async function createPointer(
  admin: AdminClient,
  name = "demo",
): Promise<{ rootPublic: string; rootPrivate: string }> {
  const root = await generateKeyPair();
  await admin.create(name, root.publicRaw);
  return { rootPublic: root.publicRaw, rootPrivate: root.privatePkcs8 };
}

describe("worker routing", () => {
  it("describes itself and reports health", { tags: ["unit"] }, async () => {
    const { service } = await provide();
    const root = await service.fetch(`${BASE}/`);
    expect(root.status).toBe(200);
    expect(await responseJson(root)).toEqual({
      service: "signed-pointer",
      protocol: 1,
      data: "/{name}/v1/value",
      admin: "/_admin/v1/variables",
    });
    expect(root.headers.get("cache-control")).toBe("no-store");
    expect(root.headers.get("x-content-type-options")).toBe("nosniff");

    const health = await service.fetch(`${BASE}/_health`);
    expect(health.status).toBe(200);
    expect(await responseJson(health)).toEqual({ ok: true, protocol: 1 });
  });

  it(
    "rejects unsupported methods and unknown names",
    { tags: ["unit"] },
    async () => {
      const { service, admin } = await provide();
      await admin.create("a", (await generateKeyPair()).publicRaw);
      const post = await service.fetch(`${BASE}/`, { method: "POST" });
      expect(post.status).toBe(405);
      expect(post.headers.get("allow")).toBe("GET");

      const unknown = await service.fetch(`${BASE}/missing/v1/value`);
      expect(unknown.status).toBe(404);
      expect(await responseJson(unknown)).toMatchObject({
        error: { code: "unknown_pointer" },
      });

      const invalidName = await service.fetch(`${BASE}/Admin/v1/value`);
      expect(invalidName.status).toBe(404);

      const notRouted = await service.fetch(`${BASE}/a/v1/other`);
      expect(notRouted.status).toBe(404);
      expect(await responseJson(notRouted)).toMatchObject({
        error: { code: "not_found" },
      });
    },
  );

  it(
    "answers capability and info endpoints without authentication",
    { tags: ["unit"] },
    async () => {
      const { service, admin } = await provide();
      const { rootPublic } = await createPointer(admin);

      const info = await service.fetch(`${BASE}/demo`);
      expect(info.status).toBe(200);
      expect(await responseJson(info)).toEqual({
        pointer: "demo",
        protocol: 1,
      });

      const health = await service.fetch(`${BASE}/demo/health`);
      expect(await responseJson(health)).toEqual({
        ok: true,
        pointer: "demo",
        protocol: 1,
      });

      const capabilities = (await responseJson(
        await service.fetch(`${BASE}/demo/v1/capabilities`),
      )) as Record<string, unknown>;
      expect(capabilities).toMatchObject({
        protocol: 1,
        algorithm: "Ed25519",
        pointer: "demo",
        maxValueBytes: MAX_VALUE_BYTES,
        maxCertificateChainDepth: 5,
      });
      expect(capabilities.features).toMatchObject({
        optimisticLock: "if-match-version",
        directSigning: true,
      });
      expect(rootPublic).toMatch(/^[A-Za-z0-9_-]+$/);
    },
  );

  it(
    "answers CORS preflight and scopes CORS headers to the configured origin",
    { tags: ["unit"] },
    async () => {
      const { service } = await provide({
        allowedOrigin: "https://app.example",
      });
      const preflight = await service.fetch(`${BASE}/demo/v1/value`, {
        method: "OPTIONS",
        headers: { origin: "https://app.example" },
      });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get("access-control-allow-origin")).toBe(
        "https://app.example",
      );

      const rejected = await service.fetch(`${BASE}/demo/v1/value`, {
        method: "OPTIONS",
        headers: { origin: "https://evil.example" },
      });
      expect(rejected.headers.get("access-control-allow-origin")).toBeNull();

      const sameOrigin = await service.fetch(`${BASE}/_health`, {
        headers: { origin: "https://app.example" },
      });
      expect(sameOrigin.headers.get("access-control-allow-origin")).toBe(
        "https://app.example",
      );
    },
  );
});

describe("admin plane", () => {
  it(
    "is disabled when no admin key is configured",
    { tags: ["unit"] },
    async () => {
      const service = createService();
      const response = await service.fetch(`${BASE}/_admin/v1/variables`);
      expect(response.status).toBe(404);
      expect(await responseJson(response)).toMatchObject({
        error: { code: "not_found" },
      });
    },
  );

  it(
    "creates, lists, reads, rotates and deletes pointers",
    { tags: ["unit"] },
    async () => {
      const { admin } = await provide();
      const { rootPublic } = await createPointer(admin, "beta");
      const other = await generateKeyPair();
      await admin.create("alpha", other.publicRaw);

      const listed = await admin.list();
      expect(listed.variables.map((v) => v.name)).toEqual(["alpha", "beta"]);

      const detail = await admin.get("beta");
      expect(detail.pubkey).toBe(rootPublic);
      expect(detail.version).toBe(0);
      expect(detail.updatedAt).toBeNull();

      const rotated = await admin.rotate("beta", other.publicRaw);
      expect(rotated.pubkey).toBe(other.publicRaw);

      const removed = await admin.remove("beta");
      expect(removed).toEqual({ deleted: "beta" });

      await expect(admin.get("beta")).rejects.toMatchObject({ status: 404 });
    },
  );

  it(
    "rejects duplicate, invalid and malformed creations",
    { tags: ["unit"] },
    async () => {
      const { admin } = await provide();
      const { rootPublic } = await createPointer(admin, "demo");

      await expect(admin.create("demo", rootPublic)).rejects.toMatchObject({
        status: 409,
        code: "conflict",
      });
      await expect(admin.create("Admin", rootPublic)).rejects.toMatchObject({
        status: 400,
      });
      await expect(admin.create("demo2", "not-a-key")).rejects.toMatchObject({
        status: 400,
      });
    },
  );

  it(
    "rejects unknown bodies, bad JSON and unknown targets",
    { tags: ["unit"] },
    async () => {
      const { service, admin, adminKeys } = await provide();
      await createPointer(admin, "demo");

      const send = (body: string) =>
        signedRequest({
          method: "POST",
          path: "/_admin/v1/variables",
          body,
          key: adminKeys,
          subject: "admin",
        });

      const unknownField = await service.fetch(
        await send('{"name":"x","pubkey":"y","z":1}'),
      );
      expect(unknownField.status).toBe(400);

      const badJson = await service.fetch(await send("{"));
      expect(badJson.status).toBe(400);

      const arrayBody = await service.fetch(await send("[]"));
      expect(arrayBody.status).toBe(400);

      const emptyBody = await service.fetch(
        await signedRequest({
          method: "GET",
          path: "/_admin/v1/variables/demo",
          key: adminKeys,
          subject: "admin",
        }),
      );
      expect(emptyBody.status).toBe(200);

      const missing = await service.fetch(
        await signedRequest({
          method: "DELETE",
          path: "/_admin/v1/variables/nope",
          key: adminKeys,
          subject: "admin",
        }),
      );
      expect(missing.status).toBe(404);

      const rotateMissing = await service.fetch(
        await signedRequest({
          method: "PUT",
          path: "/_admin/v1/variables/nope",
          body: '{"pubkey":"AAAA"}',
          key: adminKeys,
          subject: "admin",
        }),
      );
      expect(rotateMissing.status).toBe(404);
    },
  );

  it(
    "rejects admin requests signed through a certificate chain",
    { tags: ["unit"] },
    async () => {
      const { service, adminKeys } = await provide();
      const member = await generateKeyPair();
      const cert = await makeCert(
        { keys: adminKeys, chain: [], subject: "admin" },
        { keys: member, subject: "alice" },
        { read: true, write: true, sub: "alice" },
      );
      const request = await signedRequest({
        method: "POST",
        path: "/_admin/v1/variables",
        body: JSON.stringify({ name: "demo", pubkey: member.publicRaw }),
        key: member,
        chain: [cert],
        signWith: member,
        subject: "alice",
      });
      const response = await service.fetch(request);
      expect(response.status).toBe(403);
      expect(await responseJson(response)).toMatchObject({
        error: { code: "forbidden" },
      });
    },
  );

  it(
    "rejects replayed admin nonces and unsupported methods",
    { tags: ["unit"] },
    async () => {
      const { service, admin, adminKeys } = await provide();
      await createPointer(admin, "demo");
      const request = await signedRequest({
        method: "GET",
        path: "/_admin/v1/variables",
        key: adminKeys,
        subject: "admin",
      });
      expect((await service.fetch(request)).status).toBe(200);
      const replay = await service.fetch(request);
      expect(replay.status).toBe(401);
      expect(await responseJson(replay)).toMatchObject({
        error: { code: "replayed" },
      });

      const patch = await service.fetch(
        await signedRequest({
          method: "PATCH",
          path: "/_admin/v1/variables/demo",
          key: adminKeys,
          subject: "admin",
        }),
      );
      expect(patch.status).toBe(405);
      expect(patch.headers.get("allow")).toBe("GET, PUT, DELETE");
    },
  );

  it(
    "validates rotation bodies and path names",
    { tags: ["unit"] },
    async () => {
      const { service, admin, adminKeys } = await provide();
      await createPointer(admin, "demo");

      const rotate = async (body: string) => {
        const response = await service.fetch(
          await signedRequest({
            method: "PUT",
            path: "/_admin/v1/variables/demo",
            body,
            key: adminKeys,
            subject: "admin",
          }),
        );
        return response.status;
      };
      expect(await rotate("{")).toBe(400);
      expect(await rotate('{"pubkey":"AAAA","extra":1}')).toBe(400);
      expect(await rotate('{"pubkey":1}')).toBe(400);

      const badName = await service.fetch(
        await signedRequest({
          method: "DELETE",
          path: "/_admin/v1/variables/Admin",
          key: adminKeys,
          subject: "admin",
        }),
      );
      expect(badName.status).toBe(400);
    },
  );

  it(
    "reports storage failures while provisioning",
    { tags: ["mock"] },
    async () => {
      class FailingStorage extends MemoryStorage {
        override put<T>(key: string, value: T): Promise<void> {
          throw new Error(`disk full: ${key} (${typeof value})`);
        }
      }
      const context = testContext(new FailingStorage());
      const { admin } = await provide({
        pointerContext: () => context.ctx,
      });
      await expect(
        admin.create("demo", (await generateKeyPair()).publicRaw),
      ).rejects.toMatchObject({ status: 500 });
    },
  );
});

describe("data plane", () => {
  it(
    "requires authentication and a configured pointer",
    { tags: ["unit"] },
    async () => {
      const { service, admin } = await provide();
      await createPointer(admin, "demo");
      const anonymous = await service.fetch(`${BASE}/demo/v1/value`);
      expect(anonymous.status).toBe(401);
      expect(await responseJson(anonymous)).toMatchObject({
        error: { code: "missing_auth" },
      });

      const unconfigured = await service.fetch(`${BASE}/other/v1/value`, {
        method: "GET",
      });
      expect(unconfigured.status).toBe(404);
    },
  );

  it(
    "reads and writes through a directly signed anchor",
    { tags: ["mock"] },
    async () => {
      const { service, admin } = await provide();
      const root = await generateKeyPair();
      await admin.create("demo", root.publicRaw);

      const emptyRead = await signedRequest({
        path: "/demo/v1/value",
        key: root,
        subject: "alice",
      });
      const read = await service.fetch(emptyRead);
      expect(read.status).toBe(200);
      const readBody = (await responseJson(read)) as Record<string, unknown>;
      expect(readBody).toMatchObject({
        value: "",
        version: 0,
        updatedAt: null,
      });
      expect(readBody.signer).toMatchObject({ subject: "alice", direct: true });
      expect(read.headers.get("etag")).toBe('"0"');

      const firstWrite = await service.fetch(
        await signedRequest({
          method: "PUT",
          path: "/demo/v1/value",
          body: JSON.stringify({ value: "target=staging" }),
          ifMatch: "*",
          key: root,
          subject: "alice",
        }),
      );
      expect(firstWrite.status).toBe(200);
      expect(firstWrite.headers.get("etag")).toBe('"1"');
      const written = (await responseJson(firstWrite)) as Record<
        string,
        unknown
      >;
      expect(written).toMatchObject({
        value: "target=staging",
        version: 1,
        updatedBy: "alice",
      });

      const secondWrite = await service.fetch(
        await signedRequest({
          method: "PUT",
          path: "/demo/v1/value",
          body: JSON.stringify({ value: "target=prod" }),
          ifMatch: '"1"',
          key: root,
          subject: "alice",
        }),
      );
      expect(secondWrite.status).toBe(200);
      expect(secondWrite.headers.get("etag")).toBe('"2"');
    },
  );

  it(
    "enforces the optimistic lock and reports the current state",
    { tags: ["mock"] },
    async () => {
      const { service, admin } = await provide();
      const root = await generateKeyPair();
      await admin.create("demo", root.publicRaw);

      await service.fetch(
        await signedRequest({
          method: "PUT",
          path: "/demo/v1/value",
          body: JSON.stringify({ value: "first" }),
          ifMatch: "*",
          key: root,
          subject: "alice",
        }),
      );

      const conflict = await service.fetch(
        await signedRequest({
          method: "PUT",
          path: "/demo/v1/value",
          body: JSON.stringify({ value: "second" }),
          ifMatch: "*",
          key: root,
          subject: "alice",
        }),
      );
      expect(conflict.status).toBe(412);
      expect(conflict.headers.get("etag")).toBe('"1"');
      expect(await responseJson(conflict)).toMatchObject({
        error: {
          code: "precondition_failed",
          details: { version: 1, value: "first" },
        },
      });

      const missingPrecondition = await service.fetch(
        await signedRequest({
          method: "PUT",
          path: "/demo/v1/value",
          body: JSON.stringify({ value: "third" }),
          key: root,
          subject: "alice",
        }),
      );
      expect(missingPrecondition.status).toBe(428);
      expect(await responseJson(missingPrecondition)).toMatchObject({
        error: { code: "precondition_required" },
      });
    },
  );

  it("validates write bodies and value sizes", { tags: ["mock"] }, async () => {
    const { service, admin } = await provide();
    const root = await generateKeyPair();
    await admin.create("demo", root.publicRaw);

    const put = async (body: string) => {
      const response = await service.fetch(
        await signedRequest({
          method: "PUT",
          path: "/demo/v1/value",
          body,
          ifMatch: "*",
          key: root,
          subject: "alice",
        }),
      );
      return { status: response.status, body: await responseJson(response) };
    };

    expect((await put("{")).status).toBe(400);
    expect((await put("[]")).status).toBe(400);
    expect((await put('{"value":"x","extra":1}')).status).toBe(400);
    expect((await put('{"value":1}')).status).toBe(400);

    const tooLarge = await put(
      JSON.stringify({ value: "a".repeat(MAX_VALUE_BYTES + 1) }),
    );
    expect(tooLarge.status).toBe(413);
    expect(tooLarge.body).toMatchObject({
      error: { code: "value_too_large" },
    });
  });

  it(
    "rejects replays, scope escapes and read-only writers",
    { tags: ["mock"] },
    async () => {
      const w = await world();
      const { service, admin } = await provide();
      await admin.create("demo", w.root.publicRaw);

      const readRequest = await signedRequest({
        path: "/demo/v1/value",
        key: w.root,
        subject: "alice",
      });
      expect((await service.fetch(readRequest)).status).toBe(200);
      const replay = await service.fetch(readRequest);
      expect(replay.status).toBe(401);
      expect(await responseJson(replay)).toMatchObject({
        error: { code: "replayed" },
      });

      const readerWrite = await service.fetch(
        await signedRequest({
          method: "PUT",
          path: "/demo/v1/value",
          body: JSON.stringify({ value: "nope" }),
          ifMatch: "*",
          key: w.reader.keys,
          chain: w.reader.chain,
          signWith: w.reader.keys,
        }),
      );
      expect(readerWrite.status).toBe(403);

      const readerRead = await service.fetch(
        await signedRequest({
          path: "/demo/v1/value",
          key: w.reader.keys,
          chain: w.reader.chain,
          signWith: w.reader.keys,
        }),
      );
      expect(readerRead.status).toBe(200);

      const widened = await service.fetch(
        await signedRequest({
          method: "PUT",
          path: "/demo/v1/value",
          body: JSON.stringify({ value: "nope" }),
          ifMatch: "*",
          key: w.reader.keys,
          chain: w.reader.chain,
          signWith: w.reader.keys,
          scope: { read: true, write: true },
        }),
      );
      expect(widened.status).toBe(403);
    },
  );

  it(
    "replays idempotent writes without bumping the version",
    { tags: ["mock"] },
    async () => {
      const { service, admin } = await provide();
      const root = await generateKeyPair();
      await admin.create("demo", root.publicRaw);

      const write = () =>
        signedRequest({
          method: "PUT",
          path: "/demo/v1/value",
          body: JSON.stringify({ value: "stable" }),
          ifMatch: "*",
          key: root,
          subject: "alice",
        });
      const first = await write();
      first.headers.set("idempotency-key", "key-1");
      const accepted = await service.fetch(first);
      expect(accepted.status).toBe(200);

      const retry = await write();
      retry.headers.set("idempotency-key", "key-1");
      const replayed = await service.fetch(retry);
      expect(replayed.status).toBe(200);
      expect(await responseJson(replayed)).toMatchObject({
        version: 1,
        idempotent: true,
      });

      const conflict = await signedRequest({
        method: "PUT",
        path: "/demo/v1/value",
        body: JSON.stringify({ value: "different" }),
        ifMatch: "*",
        key: root,
        subject: "alice",
      });
      conflict.headers.set("idempotency-key", "key-1");
      const conflicted = await service.fetch(conflict);
      expect(conflicted.status).toBe(409);
      expect(await responseJson(conflicted)).toMatchObject({
        error: { code: "idempotency_conflict" },
      });
    },
  );

  it(
    "denies reads narrowed away and unsupported info methods",
    { tags: ["mock"] },
    async () => {
      const { service, admin } = await provide();
      const root = await generateKeyPair();
      await admin.create("demo", root.publicRaw);

      const readDenied = await service.fetch(
        await signedRequest({
          scope: { read: false, write: true },
          key: root,
          subject: "alice",
          path: "/demo/v1/value",
        }),
      );
      expect(readDenied.status).toBe(403);

      const postInfo = await service.fetch(
        await signedRequest({
          method: "POST",
          key: root,
          subject: "alice",
          path: "/demo",
        }),
      );
      expect(postInfo.status).toBe(405);
      expect(postInfo.headers.get("allow")).toBe("GET");
    },
  );

  it(
    "rejects invalid idempotency keys and unsupported methods",
    { tags: ["mock"] },
    async () => {
      const { service, admin } = await provide();
      const root = await generateKeyPair();
      await admin.create("demo", root.publicRaw);

      const write = await signedRequest({
        method: "PUT",
        path: "/demo/v1/value",
        body: JSON.stringify({ value: "x" }),
        ifMatch: "*",
        key: root,
        subject: "alice",
      });
      write.headers.set("idempotency-key", "bad key");
      expect((await service.fetch(write)).status).toBe(400);

      const post = await service.fetch(
        await signedRequest({
          method: "POST",
          path: "/demo/v1/value",
          key: root,
          subject: "alice",
        }),
      );
      expect(post.status).toBe(405);
      expect(post.headers.get("allow")).toBe("GET, PUT");
    },
  );

  it(
    "reports storage failures on the data plane",
    { tags: ["mock"] },
    async () => {
      class BrokenStorage extends MemoryStorage {
        override get<T>(key: string): Promise<T | undefined> {
          throw new Error(`unreachable: ${key}`);
        }
      }
      const { service, admin } = await provide({
        pointerContext: () => testContext(new BrokenStorage()).ctx,
      });
      const root = await generateKeyPair();
      // The registry provisioning succeeds, then the pointer storage lookup fails.
      await admin.create("demo", root.publicRaw).catch(() => undefined);
      const response = await service.fetch(`${BASE}/demo/v1/value`);
      expect(response.status).toBe(500);
      expect(await responseJson(response)).toMatchObject({
        error: { code: "internal" },
      });
    },
  );
});

describe("durable objects", () => {
  it(
    "provisions a pointer exactly once and keeps state across rotations",
    { tags: ["unit"] },
    async () => {
      const pointer = new PointerObject(testContext().ctx, {} as Env);
      const config = { name: "demo", pubkey: "pub", createdAt: NOW };
      expect(await pointer.getConfig()).toBeNull();
      expect(await pointer.configure(config)).toBe(true);
      expect(await pointer.configure(config)).toBe(false);
      expect(await pointer.getConfig()).toEqual(config);
      expect(await pointer.rotate("next")).toEqual({
        ...config,
        pubkey: "next",
      });
      expect(await pointer.status()).toEqual({
        value: "",
        version: 0,
        updatedAt: null,
        updatedBy: null,
      });
      await pointer.destroy();
      expect(await pointer.getConfig()).toBeNull();
      expect(await pointer.rotate("next")).toBeNull();
    },
  );

  it(
    "rejects operations on an unconfigured pointer",
    { tags: ["unit"] },
    async () => {
      const pointer = new PointerObject(testContext().ctx, {} as Env);
      const result = await pointer.execute(
        {
          op: "read",
          auth: {
            keyId: "k",
            certId: null,
            subject: "alice",
            scope: { read: true, write: true },
            timestamp: NOW,
            nonce: "nonce-0123456789ab",
            ifMatch: null,
            direct: true,
          },
        },
        NOW,
      );
      expect(result).toMatchObject({ ok: false, code: "unknown_pointer" });
    },
  );

  it(
    "reloads persisted configuration and value in a new instance",
    { tags: ["unit"] },
    async () => {
      const storage = new MemoryStorage();
      const env = {} as Env;
      const first = new PointerObject(testContext(storage).ctx, env);
      const config = { name: "demo", pubkey: "pub", createdAt: NOW };
      await first.configure(config);
      const written = await first.execute(
        {
          op: "write",
          auth: authContext({ nonce: "nonce-persist-0001" }),
          value: "head-cid",
          expectedVersion: 0,
        },
        NOW,
      );
      expect(written.ok).toBe(true);

      const second = new PointerObject(testContext(storage).ctx, env);
      expect(await second.getConfig()).toEqual(config);
      expect(await second.status()).toMatchObject({
        value: "head-cid",
        version: 1,
      });
    },
  );

  it(
    "deduplicates idempotent writes, rejects fingerprint reuse and prunes state",
    { tags: ["unit"] },
    async () => {
      const pointer = new PointerObject(testContext().ctx, {} as Env);
      await pointer.configure({ name: "demo", pubkey: "pub", createdAt: NOW });

      const write = (
        nonce: string,
        key: string,
        fingerprint: string,
        expectedVersion: number,
      ) =>
        pointer.execute(
          {
            op: "write",
            auth: authContext({ nonce }),
            value: "value",
            expectedVersion,
            idempotencyKey: key,
            fingerprint,
          },
          NOW,
        );

      expect((await write("nonce-idem-0000001", "k1", "fp1", 0)).ok).toBe(true);
      const replay = await write("nonce-idem-0000002", "k1", "fp1", 0);
      expect(replay).toMatchObject({ ok: true, idempotent: true });

      const conflict = await write("nonce-idem-0000003", "k1", "fp2", 1);
      expect(conflict).toMatchObject({
        ok: false,
        code: "idempotency_conflict",
      });

      // Expired idempotency records no longer block a new write.
      const expired = await pointer.execute(
        {
          op: "write",
          auth: authContext({ nonce: "nonce-idem-0000004" }),
          value: "later",
          expectedVersion: 1,
          idempotencyKey: "k1",
          fingerprint: "fp3",
        },
        NOW + 700,
      );
      expect(expired.ok).toBe(true);

      // The record set is bounded: new keys evict the oldest entries.
      for (let index = 0; index < 205; index++) {
        const result = await pointer.execute(
          {
            op: "write",
            auth: authContext({
              nonce: `nonce-prune-${String(index).padStart(6, "0")}`,
            }),
            value: `v${String(index)}`,
            expectedVersion: index + 2,
            idempotencyKey: `bulk-${String(index)}`,
            fingerprint: `bulk-fp-${String(index)}`,
          },
          NOW + 10,
        );
        expect(result.ok).toBe(true);
      }
    },
  );

  it(
    "keeps the registry index sorted and replay-safe",
    { tags: ["unit"] },
    async () => {
      const registry = new RegistryObject(testContext().ctx, {} as Env);
      expect(await registry.list()).toEqual([]);
      expect(
        await registry.create({ name: "b", pubkey: "p", createdAt: NOW }),
      ).toBe(true);
      expect(
        await registry.create({ name: "b", pubkey: "p", createdAt: NOW }),
      ).toBe(false);
      await registry.create({ name: "a", pubkey: "p", createdAt: NOW });
      expect((await registry.list()).map((entry) => entry.name)).toEqual([
        "a",
        "b",
      ]);
      expect(await registry.get("a")).toEqual({
        name: "a",
        pubkey: "p",
        createdAt: NOW,
      });
      expect(await registry.get("missing")).toBeNull();
      expect(await registry.remove("missing")).toBe(false);
      expect(await registry.remove("a")).toBe(true);

      expect(await registry.consumeNonce("nonce-1", NOW)).toBe(true);
      expect(await registry.consumeNonce("nonce-1", NOW)).toBe(false);
      expect(await registry.consumeNonce("nonce-2", NOW + 1000)).toBe(true);
    },
  );
});

describe("fixtures", () => {
  it("produces unique nonces and stable base64url", { tags: ["unit"] }, () => {
    const a = toBase64Url(randomBytes(18));
    const b = toBase64Url(randomBytes(18));
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]{24}$/);
  });
});
