import { describe, expect, it, vi } from "vitest";
import { CID } from "multiformats/cid";
import { identity } from "multiformats/hashes/identity";
import { encodeCertificate } from "../src/certificates.ts";
import { MAX_BODY_BYTES, MAX_CERT_BYTES, MAX_NONCES } from "../src/protocol.ts";
import { randomBytes, toBase64Url, utf8 } from "../src/crypto.ts";
import {
  API_KEY,
  NOW,
  ROOT,
  ROOT2,
  SERVICE,
  createPointer,
  createService,
  generateKeyPair,
  makeCert,
  signedRequest,
} from "./helpers.ts";

describe("publication pointer API", { tags: ["mock"] }, () => {
  it("creates independent swarms under one owner and exposes only signed roots", async () => {
    const service = await createService(),
      owner = await generateKeyPair();
    const id = await createPointer(service, owner),
      second = await createPointer(service, owner);
    expect(id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second).not.toBe(id);
    const read = await service.fetch(
      await signedRequest({ key: owner, pointerId: id }),
    );
    expect(await read.json()).toEqual({ root: ROOT, revision: "1" });
    expect(read.headers.get("etag")).toBe('"1"');
    expect(read.headers.get("cache-control")).toBe("no-store");
    expect((await service.fetch(`${SERVICE}/v1/pointers/${id}`)).status).toBe(
      401,
    );
    for (const path of [
      "/",
      "/_admin/v1/variables",
      "/v1/challenges",
      "/demo/v1/value",
      `/v1/pointers/${id}/capabilities`,
      `/v1/pointers/${id}/`,
    ]) {
      expect((await service.fetch(`${SERVICE}${path}`)).status).toBe(404);
    }
    expect((await service.fetch(`${SERVICE}/_health`)).status).toBe(200);
    expect((await service.fetch(`${SERVICE}/v1/pointers/`)).status).toBe(405);
    for (const method of ["POST", "DELETE", "PATCH"])
      expect(
        (await service.fetch(`${SERVICE}/v1/pointers/${id}`, { method }))
          .status,
      ).toBe(405);
  });
  it("requires API key and owner proof on creation; API key does not authorize reads", async () => {
    const service = await createService(),
      owner = await generateKeyPair(),
      outsider = await generateKeyPair();
    const body = JSON.stringify({ owner: owner.publicRaw, root: ROOT });
    for (const apiKey of ["", "wrong", toBase64Url(randomBytes(32))]) {
      expect(
        (
          await service.fetch(
            await signedRequest({ key: owner, method: "POST", body, apiKey }),
          )
        ).status,
      ).toBe(401);
    }
    expect(
      (
        await service.fetch(
          await signedRequest({
            key: outsider,
            subject: owner.publicRaw,
            method: "POST",
            body,
            apiKey: API_KEY,
          }),
        )
      ).status,
    ).toBe(401);
    const response = await service.fetch(
      await signedRequest({
        key: owner,
        method: "POST",
        body,
        apiKey: API_KEY,
      }),
    );
    const { id } = await response.json<{ id: string }>();
    expect(response.headers.get("location")).toBe(`/v1/pointers/${id}`);
    expect(
      (
        await service.fetch(
          await signedRequest({
            key: outsider,
            pointerId: id,
            apiKey: API_KEY,
          }),
        )
      ).status,
    ).toBe(403);
    service.env.POINTER_API_KEY_SHA256 = "";
    expect(
      (await service.fetch(await signedRequest({ key: owner, pointerId: id })))
        .status,
    ).toBe(200);
    expect(
      (
        await service.fetch(
          await signedRequest({
            key: owner,
            method: "POST",
            body,
            apiKey: API_KEY,
          }),
        )
      ).status,
    ).toBe(401);
  });
  it("accepts owner-issued leaf members for read/write, never cross-pointer/service or member-issued certs", async () => {
    const service = await createService(),
      owner = await generateKeyPair(),
      member = await generateKeyPair(),
      otherMember = await generateKeyPair();
    const id = await createPointer(service, owner),
      second = await createPointer(service, owner);
    const cert = await makeCert(owner, member, id);
    expect(
      (
        await service.fetch(
          await signedRequest({
            key: member,
            pointerId: id,
            certificate: cert,
          }),
        )
      ).status,
    ).toBe(200);
    const write = await service.fetch(
      await signedRequest({
        key: member,
        pointerId: id,
        certificate: cert,
        method: "PUT",
        ifMatch: '"1"',
        body: JSON.stringify({ root: ROOT2 }),
      }),
    );
    expect(await write.json()).toEqual({ root: ROOT2, revision: "2" });
    for (const certificate of [
      await makeCert(owner, member, second),
      await makeCert(owner, member, id, { service: "https://other.example" }),
      await makeCert(member, otherMember, id, { owner: owner.publicRaw }),
      await makeCert(owner, member, id, { exp: NOW - 1 }),
      await makeCert(owner, member, id, { iat: NOW + 10 }),
      await makeCert(owner, member, id, { exp: NOW - 1, iat: NOW }),
      { ...cert, body: { ...cert.body, member: otherMember.publicRaw } },
      { ...cert, body: { ...cert.body, ca: true } },
    ])
      expect(
        (
          await service.fetch(
            await signedRequest({ key: member, pointerId: id, certificate }),
          )
        ).status,
      ).toBe(403);
    expect(
      (
        await service.fetch(
          await signedRequest({
            key: otherMember,
            pointerId: id,
            certificate: cert,
          }),
        )
      ).status,
    ).toBe(403);
    const chain = await signedRequest({
      key: member,
      pointerId: id,
      certificate: cert,
    });
    chain.headers.append("x-pointer-cert", encodeCertificate(cert));
    expect((await service.fetch(chain)).status).toBe(403);
    const create = await signedRequest({
      key: member,
      method: "POST",
      body: JSON.stringify({ owner: member.publicRaw, root: ROOT }),
      apiKey: API_KEY,
      certificate: cert,
    });
    expect((await service.fetch(create)).status).toBe(403);
  });
  it("commits concurrent CAS exactly once and persists revisions across restarts", async () => {
    const service = await createService(),
      owner = await generateKeyPair();
    const id = await createPointer(service, owner);
    const requests = await Promise.all(
      [ROOT, ROOT2].map((root) =>
        signedRequest({
          key: owner,
          pointerId: id,
          method: "PUT",
          ifMatch: '"1"',
          body: JSON.stringify({ root }),
        }),
      ),
    );
    const responses = await Promise.all(
      requests.map((request) => service.fetch(request)),
    );
    expect(responses.map((r) => r.status).sort()).toEqual([200, 412]);
    const success = await responses.find((r) => r.status === 200)!.json();
    const conflict = responses.find((r) => r.status === 412)!;
    expect(await conflict.json()).toEqual({
      error: {
        code: "precondition_failed",
        message: "pointer revision has changed",
        details: success,
      },
    });
    expect(conflict.headers.get("etag")).toBe('"2"');
    service.restart();
    expect(
      await (
        await service.fetch(await signedRequest({ key: owner, pointerId: id }))
      ).json(),
    ).toEqual(success);
    const same = await service.fetch(
      await signedRequest({
        key: owner,
        pointerId: id,
        method: "PUT",
        ifMatch: '"2"',
        body: JSON.stringify({ root: (success as { root: string }).root }),
      }),
    );
    expect((await same.json<{ revision: string }>()).revision).toBe("3");
  });
  it("fresh-nonce write retries bind key, raw body and If-Match; stale/expired authorization cannot obtain cached success", async () => {
    const service = await createService(),
      owner = await generateKeyPair(),
      member = await generateKeyPair();
    const id = await createPointer(service, owner);
    const base = {
      key: owner,
      pointerId: id,
      method: "PUT",
      ifMatch: '"1"',
      body: JSON.stringify({ root: ROOT2 }),
      idempotencyKey: "publish",
    };
    const nonce = toBase64Url(randomBytes(24));
    const original = await signedRequest({ ...base, nonce });
    expect(
      (await service.fetch(await signedRequest({ ...base, nonce }))).status,
    ).toBe(200);
    expect((await service.fetch(original)).status).toBe(401);
    service.restart();
    for (let i = 0; i < 2; i++) {
      expect(
        await (await service.fetch(await signedRequest(base))).json(),
      ).toEqual({ root: ROOT2, revision: "2" });
    }
    for (const change of [
      { body: JSON.stringify({ root: ROOT }) },
      { ifMatch: '"2"' },
      { body: JSON.stringify({ root: ROOT2 }, null, 2) },
    ]) {
      expect(
        (await service.fetch(await signedRequest({ ...base, ...change })))
          .status,
      ).toBe(409);
    }
    const cert = await makeCert(owner, member, id);
    const memberWrite = {
      ...base,
      key: member,
      certificate: cert,
      ifMatch: '"2"',
    };
    expect((await service.fetch(await signedRequest(memberWrite))).status).toBe(
      200,
    );
    expect(
      (
        await service.fetch(
          await signedRequest({
            ...memberWrite,
            certificate: await makeCert(owner, member, id, { exp: NOW - 1 }),
          }),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await service.fetch(
          await signedRequest({ ...base, timestamp: NOW - 61 }),
        )
      ).status,
    ).toBe(401);
    expect(
      (await service.fetch(await signedRequest({ ...base, key: member })))
        .status,
    ).toBe(403);
    expect(
      (
        await service.fetch(
          await signedRequest({
            ...memberWrite,
            ifMatch: '"3"',
            idempotencyKey: "fresh",
          }),
        )
      ).status,
    ).toBe(200);
  });
  it("creation retries allocate one ID across concurrent calls and restarts and reject different bodies", async () => {
    const service = await createService(),
      owner = await generateKeyPair();
    const base = {
      key: owner,
      method: "POST",
      body: JSON.stringify({ owner: owner.publicRaw, root: ROOT }),
      apiKey: API_KEY,
      idempotencyKey: "create",
    };
    const responses = await Promise.all(
      (await Promise.all([signedRequest(base), signedRequest(base)])).map((r) =>
        service.fetch(r),
      ),
    );
    expect(responses.map((r) => r.status)).toEqual([201, 201]);
    const first = await responses[0]!.json();
    expect(await responses[1]!.json()).toEqual(first);
    service.restart();
    expect(
      await (await service.fetch(await signedRequest(base))).json(),
    ).toEqual(first);
    expect(
      (
        await service.fetch(
          await signedRequest({
            ...base,
            body: JSON.stringify({ owner: owner.publicRaw, root: ROOT2 }),
          }),
        )
      ).status,
    ).toBe(409);
    expect(service.pointerStores.size).toBe(1);
    const anotherOwner = await generateKeyPair();
    const another = await createPointer(service, anotherOwner, ROOT, "create");
    expect(another).not.toBe((first as { id: string }).id);
  });
  it("recovers creation from pre-commit, ambiguous post-commit and registry failures without false success", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      for (const mode of [
        "before",
        "after",
        "registry",
        "registry-after",
      ] as const) {
        const service = await createService(),
          owner = await generateKeyPair();
        const base = {
          key: owner,
          method: "POST",
          body: JSON.stringify({ owner: owner.publicRaw, root: ROOT }),
          apiKey: API_KEY,
          idempotencyKey: "retry",
        };
        if (mode === "registry" || mode === "registry-after") {
          service.registryStore.failBeforeCommit = mode === "registry";
          service.registryStore.failAfterCommit = mode === "registry-after";
        } else {
          const get = service.env.POINTER.get.bind(service.env.POINTER);
          vi.spyOn(service.env.POINTER, "get").mockImplementation((id) => {
            const pointer = get(id),
              storage = service.pointerStores.get(String(id))!;
            storage.failBeforeCommit = mode === "before";
            storage.failAfterCommit = mode === "after";
            return pointer;
          });
        }
        expect((await service.fetch(await signedRequest(base))).status).toBe(
          500,
        );
        const allocated = [...service.registryStore.data.keys()].find((key) =>
          key.startsWith("allocation:"),
        );
        service.registryStore.failBeforeCommit = false;
        service.registryStore.failAfterCommit = false;
        vi.restoreAllMocks();
        for (const storage of service.pointerStores.values()) {
          storage.failBeforeCommit = false;
          storage.failAfterCommit = false;
        }
        service.restart();
        const response = await service.fetch(await signedRequest(base));
        expect(response.status).toBe(201);
        const { id } = await response.json<{ id: string }>();
        if (allocated) expect(`allocation:${id}`).toBe(allocated);
        expect(
          await (
            await service.fetch(
              await signedRequest({ key: owner, pointerId: id }),
            )
          ).json(),
        ).toEqual({ root: ROOT, revision: "1" });
      }
    } finally {
      log.mockRestore();
    }
  });
  it("rolls back nonce/CAS/idempotency on write failure, and recovers an ambiguous committed write", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      for (const after of [false, true]) {
        const service = await createService(),
          owner = await generateKeyPair(),
          id = await createPointer(service, owner);
        const storage = service.pointerStores.get(`pointer-v2:${id}`)!;
        storage.failBeforeCommit = !after;
        storage.failAfterCommit = after;
        const base = {
          key: owner,
          pointerId: id,
          method: "PUT",
          ifMatch: '"1"',
          body: JSON.stringify({ root: ROOT2 }),
          idempotencyKey: "retry",
        };
        expect((await service.fetch(await signedRequest(base))).status).toBe(
          500,
        );
        storage.failBeforeCommit = false;
        storage.failAfterCommit = false;
        service.restart();
        expect(
          await (await service.fetch(await signedRequest(base))).json(),
        ).toEqual({ root: ROOT2, revision: "2" });
        expect(
          await (await service.fetch(await signedRequest(base))).json(),
        ).toEqual({ root: ROOT2, revision: "2" });
      }
    } finally {
      vi.restoreAllMocks();
    }
  });
  it("never evicts live nonces at saturation, including after restart, then accepts after expiry", async () => {
    const service = await createService(),
      owner = await generateKeyPair(),
      id = await createPointer(service, owner);
    const storage = service.pointerStores.get(`pointer-v2:${id}`)!;
    const nonces = Object.fromEntries(
      Array.from({ length: MAX_NONCES }, (_, i) => [`nonce-${i}`, NOW + 130]),
    );
    const current = await storage.get<Record<string, unknown>>("pointer");
    await storage.put("pointer", { ...current, nonces });
    service.restart();
    expect(
      (await service.fetch(await signedRequest({ key: owner, pointerId: id })))
        .status,
    ).toBe(429);
    expect(
      (await storage.get<{ nonces: Record<string, number> }>("pointer"))!
        .nonces,
    ).toEqual(nonces);
    service.registryStore.data.set("nonces", structuredClone(nonces));
    expect(
      (
        await service.fetch(
          await signedRequest({
            key: owner,
            method: "POST",
            body: JSON.stringify({ owner: owner.publicRaw, root: ROOT }),
            apiKey: API_KEY,
          }),
        )
      ).status,
    ).toBe(429);
    const clock = vi.spyOn(Date, "now").mockReturnValue((NOW + 131) * 1000);
    try {
      expect(
        (
          await service.fetch(
            await signedRequest({
              key: owner,
              pointerId: id,
              timestamp: NOW + 131,
            }),
          )
        ).status,
      ).toBe(200);
    } finally {
      clock.mockRestore();
    }
  });
  it("binds audience, ID, method, path, raw body, If-Match, idempotency, timestamp, nonce and signer", async () => {
    const service = await createService(),
      owner = await generateKeyPair(),
      id = await createPointer(service, owner),
      second = await createPointer(service, owner);
    const base = {
      key: owner,
      pointerId: id,
      method: "PUT",
      ifMatch: '"1"',
      body: JSON.stringify({ root: ROOT2 }),
      idempotencyKey: "edit",
    };
    for (const [name, value] of [
      ["if-match", '"2"'],
      ["idempotency-key", "other"],
      ["x-pointer-timestamp", String(NOW + 1)],
      ["x-pointer-nonce", toBase64Url(randomBytes(24))],
      ["x-pointer-subject", (await generateKeyPair()).publicRaw],
      ["authorization", "Ed25519 wrong"],
    ]) {
      const request = await signedRequest(base);
      request.headers.set(name!, value!);
      expect([401, 403]).toContain((await service.fetch(request)).status);
    }
    const original = await signedRequest(base);
    expect(
      (
        await service.fetch(
          new Request(`${SERVICE}/v1/pointers/${second}`, {
            method: original.method,
            headers: original.headers,
            body: base.body,
          }),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await service.fetch(
          new Request(original.url, {
            method: "GET",
            headers: original.headers,
          }),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await service.fetch(
          new Request(original.url, {
            method: "PUT",
            headers: original.headers,
            body: JSON.stringify({ root: ROOT }),
          }),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await service.fetch(
          await signedRequest({ ...base, service: "https://other.example" }),
        )
      ).status,
    ).toBe(401);
    // Host is deliberately not an authorization input; only the configured origin is.
    const host = await signedRequest({ key: owner, pointerId: id });
    host.headers.set("host", "untrusted.example");
    expect((await service.fetch(host)).status).toBe(200);
    const clock = vi.spyOn(Date, "now").mockReturnValue(NOW * 1000);
    try {
      for (const timestamp of [NOW - 61, NOW + 61])
        expect(
          (
            await service.fetch(
              await signedRequest({ key: owner, pointerId: id, timestamp }),
            )
          ).status,
        ).toBe(401);
      for (const timestamp of [NOW - 60, NOW + 60])
        expect(
          (
            await service.fetch(
              await signedRequest({ key: owner, pointerId: id, timestamp }),
            )
          ).status,
        ).toBe(200);
    } finally {
      clock.mockRestore();
    }
    const replayNonce = toBase64Url(randomBytes(24));
    const replay = await signedRequest({
      key: owner,
      pointerId: id,
      nonce: replayNonce,
    });
    expect(
      (
        await service.fetch(
          await signedRequest({
            key: owner,
            pointerId: id,
            nonce: replayNonce,
          }),
        )
      ).status,
    ).toBe(200);
    service.restart();
    expect((await service.fetch(replay)).status).toBe(401);
  });
  it("rejects malformed bodies, CIDs, owner keys, ETags and inputs before unbounded buffering", async () => {
    const service = await createService(),
      owner = await generateKeyPair(),
      id = await createPointer(service, owner);
    for (const body of [
      "",
      "null",
      "[]",
      "{",
      '{"root":"garbage"}',
      '{"root":1}',
      JSON.stringify({ root: ROOT, extra: true }),
      JSON.stringify({ root: ROOT.toUpperCase() }),
    ]) {
      expect(
        (
          await service.fetch(
            await signedRequest({
              key: owner,
              pointerId: id,
              method: "PUT",
              ifMatch: '"1"',
              body,
            }),
          )
        ).status,
      ).toBe(400);
    }
    for (const ifMatch of [
      "*",
      'W/"1"',
      '"1","2"',
      '"01"',
      '"0"',
      "1",
      '"-1"',
    ]) {
      expect(
        (
          await service.fetch(
            await signedRequest({
              key: owner,
              pointerId: id,
              method: "PUT",
              ifMatch,
              body: JSON.stringify({ root: ROOT }),
            }),
          )
        ).status,
      ).toBe(400);
    }
    for (const [name, value] of [
      ["x-pointer-timestamp", "not-integer"],
      ["x-pointer-subject", "AAAA"],
      ["x-pointer-nonce", "too-short"],
      ["idempotency-key", "x".repeat(201)],
    ]) {
      const request = await signedRequest({ key: owner, pointerId: id });
      request.headers.set(name!, value!);
      expect((await service.fetch(request)).status).toBe(400);
    }
    expect(
      (
        await service.fetch(
          await signedRequest({
            key: owner,
            pointerId: id,
            method: "PUT",
            body: JSON.stringify({ root: ROOT }),
          }),
        )
      ).status,
    ).toBe(428);
    expect(
      (
        await service.fetch(
          await signedRequest({
            key: owner,
            method: "POST",
            apiKey: API_KEY,
            body: JSON.stringify({ root: ROOT, owner: "AAAA" }),
          }),
        )
      ).status,
    ).toBe(400);
    const tooBig = await signedRequest({
      key: owner,
      method: "POST",
      apiKey: API_KEY,
      body: "x".repeat(MAX_BODY_BYTES + 1),
    });
    expect((await service.fetch(tooBig)).status).toBe(413);
    const longCid = CID.createV1(
      0x55,
      identity.digest(new Uint8Array(200)),
    ).toString();
    for (const options of [
      {
        pointerId: id,
        method: "PUT",
        ifMatch: '"1"',
        body: JSON.stringify({ root: longCid }),
      },
      {
        method: "POST",
        apiKey: API_KEY,
        body: JSON.stringify({ owner: owner.publicRaw, root: longCid }),
      },
    ])
      expect(
        (await service.fetch(await signedRequest({ key: owner, ...options })))
          .status,
      ).toBe(413);
    const cert = await signedRequest({ key: owner, pointerId: id });
    cert.headers.set("x-pointer-cert", "A".repeat(MAX_CERT_BYTES + 1));
    expect((await service.fetch(cert)).status).toBe(413);
    const headers = await signedRequest({ key: owner, pointerId: id });
    headers.headers.set("x-junk", "A".repeat(17000));
    expect((await service.fetch(headers)).status).toBe(413);
    const contentLength = await signedRequest({
      key: owner,
      method: "POST",
      apiKey: API_KEY,
    });
    contentLength.headers.set("content-length", "999999");
    expect((await service.fetch(contentLength)).status).toBe(413);
    const invalidUtf8 = await signedRequest({
      key: owner,
      method: "POST",
      apiKey: API_KEY,
      bodyBytes: new Uint8Array([255]),
    });
    expect((await service.fetch(invalidUtf8)).status).toBe(400);
    const bom = await signedRequest({
      key: owner,
      method: "POST",
      apiKey: API_KEY,
      bodyBytes: new Uint8Array([
        239,
        187,
        191,
        ...utf8(JSON.stringify({ owner: owner.publicRaw, root: ROOT })),
      ]),
    });
    expect((await service.fetch(bom)).status).toBe(400);
    const getBody = await signedRequest({
      key: owner,
      pointerId: id,
      method: "PUT",
      body: "x",
    });
    getBody.headers.set("x-pointer-scope", '{"read":true}');
    expect((await service.fetch(getBody)).status).toBe(400);
  });
  it("uses only the configured CORS origin and fails closed for invalid deployment audiences", async () => {
    const service = await createService({
      allowedOrigin: "https://client.example",
    });
    const cors = await service.fetch(`${SERVICE}/v1/pointers/`, {
      method: "OPTIONS",
      headers: { origin: "https://client.example" },
    });
    expect(cors.status).toBe(204);
    expect(cors.headers.get("access-control-allow-origin")).toBe(
      "https://client.example",
    );
    expect(
      (
        await service.fetch(`${SERVICE}/_health`, {
          headers: { origin: "https://bad.example" },
        })
      ).headers.get("access-control-allow-origin"),
    ).toBeNull();
    service.env.POINTER_SERVICE = "https://pointer.example/path";
    vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect((await service.fetch(`${SERVICE}/v1/pointers/`)).status).toBe(500);
    } finally {
      vi.restoreAllMocks();
    }
  });
});
