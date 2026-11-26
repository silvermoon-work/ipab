import { describe, expect, it } from "vitest";
import {
  AdminClient,
  PointerApiError,
  PointerClient,
  rawPublicKeyBytes,
  utf8Bytes,
} from "../src/client.ts";
import { fromBase64Url, generateKeyPair, toBase64Url } from "../src/crypto.ts";
import { NOW, createService, world } from "./helpers.ts";
import { issueCertificate } from "../src/certificates.ts";
import { importPrivateKeyPkcs8, keyId, randomBytes } from "../src/crypto.ts";

const BASE = "https://pointer.example";

async function signer(subject = "alice") {
  const keys = await generateKeyPair();
  return { keys, signer: { privateKey: keys.privatePkcs8, subject } };
}

async function pointerWorld(name = "demo") {
  const adminKeys = await generateKeyPair();
  const service = createService({ adminPublicKey: adminKeys.publicRaw });
  const admin = new AdminClient({
    baseUrl: BASE,
    signer: { privateKey: adminKeys.privatePkcs8, subject: "admin" },
    fetch: service.fetch,
  });
  const w = await world();
  await admin.create(name, w.root.publicRaw);
  return { service, admin, w };
}

describe("PointerClient", () => {
  it(
    "requires bound requests and certificates for new swarms, rejects cross-service reuse and replay",
    { tags: ["mock"] },
    async () => {
      const { service, admin, w } = await pointerWorld();
      await admin.create("bound", w.root.publicRaw, true);
      await admin.create("other", w.root.publicRaw, true);
      const certificate = await issueCertificate(
        {
          v: 1,
          aud: `${BASE}/bound`,
          sub: "member",
          pub: w.agent1.keys.publicRaw,
          scope: { read: true, write: true },
          iss: "owner",
          iss_pub: w.root.publicRaw,
          kid: await keyId(w.agent1.keys.publicRaw),
          cid: toBase64Url(randomBytes(16)),
          iat: NOW - 10,
          exp: NOW + 3600,
          ca: false,
        },
        await importPrivateKeyPkcs8(w.root.privatePkcs8),
      );
      const options = {
        signer: {
          privateKey: w.agent1.keys.privatePkcs8,
          certificates: [certificate],
        },
        fetch: service.fetch,
        now: () => NOW,
      };
      const bound = new PointerClient({ ...options, baseUrl: `${BASE}/bound` });
      await bound.read();
      await expect(
        new PointerClient({ ...options, baseUrl: `${BASE}/other` }).read(),
      ).rejects.toMatchObject({ status: 403 });
      await expect(
        new PointerClient({
          ...options,
          baseUrl: `https://elsewhere.example/bound`,
        }).read(),
      ).rejects.toMatchObject({ status: 403 });
      await expect(
        new PointerClient({
          ...options,
          signer: {
            privateKey: w.agent1.keys.privatePkcs8,
            certificates: w.agent1.chain,
          },
          baseUrl: `${BASE}/bound`,
        }).read(),
      ).rejects.toMatchObject({ status: 403 });
      const replay = new PointerClient({
        ...options,
        baseUrl: `${BASE}/bound`,
        nonce: () => "fixed_nonce_for_replay_123",
      });
      await replay.read();
      await expect(replay.read()).rejects.toMatchObject({
        status: 401,
        code: "replayed",
      });
    },
  );
  it("validates its options", { tags: ["unit"] }, async () => {
    const { signer: s } = await signer();
    expect(
      () => new PointerClient({ baseUrl: "", signer: s, now: () => NOW }),
    ).toThrow("baseUrl is required");
    expect(
      () =>
        new PointerClient({
          baseUrl: `${BASE}/demo`,
          signer: { privateKey: "" },
          now: () => NOW,
        }),
    ).toThrow("signer.privateKey is required");
    expect(
      () =>
        new PointerClient({
          baseUrl: `${BASE}/demo`,
          signer: { privateKey: s.privateKey },
          now: () => NOW,
        }),
    ).toThrow("signer.subject is required");
  });

  it("reads capabilities without signing", { tags: ["mock"] }, async () => {
    const { service, w } = await pointerWorld();
    const client = new PointerClient({
      baseUrl: `${BASE}/demo`,
      signer: {
        privateKey: w.agent1.keys.privatePkcs8,
        certificates: w.agent1.chain,
      },
      fetch: service.fetch,
      now: () => NOW,
    });
    const capabilities = await client.capabilities();
    expect(capabilities).toMatchObject({ pointer: "demo", protocol: 1 });
  });

  it(
    "reads, writes and creates through the in-process Worker",
    { tags: ["mock"] },
    async () => {
      const { service, w } = await pointerWorld();
      const client = new PointerClient({
        baseUrl: `${BASE}/demo/`,
        signer: { privateKey: w.root.privatePkcs8, subject: "alice" },
        fetch: service.fetch,
        now: () => NOW,
      });

      const empty = await client.read();
      expect(empty).toMatchObject({ value: "", version: 0, etag: '"0"' });

      const created = await client.create("first");
      expect(created).toMatchObject({
        value: "first",
        version: 1,
        etag: '"1"',
      });

      const updated = await client.write("second", { ifVersion: 1 });
      expect(updated).toMatchObject({ value: "second", version: 2 });

      const idempotent = await client.write("second", {
        ifVersion: 2,
      });
      expect(idempotent.version).toBe(3);
    },
  );

  it(
    "signs with a certificate chain and narrows scope per request",
    { tags: ["mock"] },
    async () => {
      const { service, w } = await pointerWorld();
      const client = new PointerClient({
        baseUrl: `${BASE}/demo`,
        signer: {
          privateKey: w.reader.keys.privatePkcs8,
          certificates: w.reader.chain,
          scope: { read: true, write: false },
        },
        fetch: service.fetch,
        now: () => NOW,
      });
      const read = await client.read();
      expect(read.signer).toMatchObject({
        subject: "alice/reader",
        direct: false,
      });
    },
  );

  it(
    "retries a conflicting update a bounded number of times",
    { tags: ["mock"] },
    async () => {
      const { service, w } = await pointerWorld();
      const client = new PointerClient({
        baseUrl: `${BASE}/demo`,
        signer: { privateKey: w.root.privatePkcs8, subject: "alice" },
        fetch: service.fetch,
        now: () => NOW,
      });
      const other = new PointerClient({
        baseUrl: `${BASE}/demo`,
        signer: { privateKey: w.root.privatePkcs8, subject: "alice" },
        fetch: service.fetch,
        now: () => NOW,
      });

      let calls = 0;
      const result = await client.update(async () => {
        calls += 1;
        if (calls === 1) {
          // Another writer wins the race between read and write.
          await other.create("winner");
        }
        return `value-${calls}`;
      });
      expect(calls).toBe(2);
      expect(result).toMatchObject({ value: "value-2", version: 2 });
    },
  );

  it(
    "stops retrying after the attempt limit and surfaces the conflict",
    { tags: ["mock"] },
    async () => {
      const { service, w } = await pointerWorld();
      const client = new PointerClient({
        baseUrl: `${BASE}/demo`,
        signer: { privateKey: w.root.privatePkcs8, subject: "alice" },
        fetch: service.fetch,
        now: () => NOW,
      });
      await client.create("baseline");

      const error = await client
        .update(
          async () => {
            await client.write("racing", { ifVersion: 1 });
            return "never";
          },
          { maxAttempts: 1 },
        )
        .catch((err: unknown) => err);
      expect(error).toBeInstanceOf(PointerApiError);
      expect((error as PointerApiError).status).toBe(412);
    },
  );

  it("wraps non-JSON error responses", { tags: ["unit"] }, async () => {
    const { signer: s } = await signer();
    const client = new PointerClient({
      baseUrl: `${BASE}/demo`,
      signer: s,
      now: () => NOW,
      fetch: () => Promise.resolve(new Response("boom", { status: 500 })),
    });
    const error = await client.read().catch((err: unknown) => err);
    expect(error).toBeInstanceOf(PointerApiError);
    expect((error as PointerApiError).code).toBe("http_error");
    expect((error as PointerApiError).current).toBeUndefined();
  });

  it(
    "exposes the current state on precondition failures",
    { tags: ["mock"] },
    async () => {
      const { service, w } = await pointerWorld();
      const client = new PointerClient({
        baseUrl: `${BASE}/demo`,
        signer: { privateKey: w.root.privatePkcs8, subject: "alice" },
        fetch: service.fetch,
        now: () => NOW,
      });
      await client.create("first");
      const error = await client
        .write("second", { ifVersion: 0 })
        .catch((err: unknown) => err);
      expect((error as PointerApiError).current).toEqual({
        value: "first",
        version: 1,
      });
    },
  );

  it("honours an injected clock and nonce", { tags: ["unit"] }, async () => {
    const { signer: s } = await signer();
    const seen: string[] = [];
    const client = new PointerClient({
      baseUrl: `${BASE}/demo`,
      signer: s,
      now: () => 1_700_000_000,
      nonce: () => "fixed-nonce-01234567",
      fetch: (input, init) => {
        const request =
          input instanceof Request ? input : new Request(input, init);
        seen.push(request.headers.get("x-pointer-timestamp") ?? "");
        return Promise.resolve(
          new Response(
            JSON.stringify({
              value: "",
              version: 0,
              updatedAt: null,
              updatedBy: null,
            }),
            { status: 200, headers: { etag: '"0"' } },
          ),
        );
      },
    });
    const result = await client.read();
    expect(result.version).toBe(0);
    expect(seen).toEqual(["1700000000"]);
  });

  it(
    "sends an idempotency key when one is given",
    { tags: ["mock"] },
    async () => {
      const { service, w } = await pointerWorld();
      const client = new PointerClient({
        baseUrl: `${BASE}/demo`,
        signer: { privateKey: w.root.privatePkcs8, subject: "alice" },
        fetch: service.fetch,
        now: () => NOW,
      });
      const result = await client.create("first", { idempotencyKey: "idem-1" });
      expect(result.version).toBe(1);
    },
  );
});

describe("AdminClient", () => {
  it("requires direct signing", { tags: ["unit"] }, async () => {
    const w = await world();
    expect(
      () =>
        new AdminClient({
          baseUrl: `${BASE}/demo`,
          signer: {
            privateKey: w.agent1.keys.privatePkcs8,
            certificates: w.agent1.chain,
          },
          now: () => NOW,
        }),
    ).toThrow(/direct/);
  });

  it(
    "mints admin requests that verify against the admin key",
    { tags: ["unit"] },
    async () => {
      const keys = await generateKeyPair();
      const captured: Request[] = [];
      const client = new AdminClient({
        baseUrl: "https://pointers.example",
        signer: { privateKey: keys.privatePkcs8, subject: "admin" },
        now: () => NOW,
        nonce: () => "admin-nonce-0123456789",
        fetch: (input, init) => {
          captured.push(
            input instanceof Request ? input : new Request(input, init),
          );
          return Promise.resolve(
            new Response(
              JSON.stringify({
                name: "demo",
                pubkey: keys.publicRaw,
                createdAt: NOW,
              }),
              { status: 201, headers: { "content-type": "application/json" } },
            ),
          );
        },
      });
      const created = await client.create("demo", keys.publicRaw);
      expect(created.name).toBe("demo");
      expect(captured).toHaveLength(1);
      expect(captured[0]!.headers.get("x-pointer-subject")).toBe("admin");
      expect(captured[0]!.headers.get("authorization")).toMatch(/^Ed25519 /);
    },
  );

  it(
    "lists, reads, rotates and removes pointers",
    { tags: ["mock"] },
    async () => {
      const adminKeys = await generateKeyPair();
      const service = createService({ adminPublicKey: adminKeys.publicRaw });
      const admin = new AdminClient({
        baseUrl: BASE,
        signer: { privateKey: adminKeys.privatePkcs8, subject: "admin" },
        fetch: service.fetch,
      });
      const target = await generateKeyPair();
      const replacement = await generateKeyPair();

      await admin.create("demo", target.publicRaw);
      expect((await admin.list()).variables).toHaveLength(1);
      expect((await admin.get("demo")).pubkey).toBe(target.publicRaw);
      expect((await admin.rotate("demo", replacement.publicRaw)).pubkey).toBe(
        replacement.publicRaw,
      );
      expect(await admin.remove("demo")).toEqual({ deleted: "demo" });

      const error = await admin.get("demo").catch((err: unknown) => err);
      expect(error).toBeInstanceOf(PointerApiError);
      expect((error as PointerApiError).status).toBe(404);
      expect((error as PointerApiError).body).toMatchObject({
        error: { code: "unknown_pointer" },
      });
    },
  );
});

describe("key helpers", () => {
  it("loads raw keys from base64url and PEM", { tags: ["unit"] }, async () => {
    const keys = await generateKeyPair();
    const raw = rawPublicKeyBytes(keys.publicRaw);
    expect([...raw]).toEqual([...fromBase64Url(keys.publicRaw)]);

    const pem = `-----BEGIN PUBLIC KEY-----\n${toBase64Url(new Uint8Array([48, 42, 48, 5, 6, 3, 43, 101, 112, 3, 33, 0, ...raw]))}\n-----END PUBLIC KEY-----`;
    expect([...rawPublicKeyBytes(pem)]).toEqual([...raw]);
    expect([...utf8Bytes("abc")]).toEqual([97, 98, 99]);
  });
});
