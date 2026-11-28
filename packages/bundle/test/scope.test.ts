import { describe, expect, it } from "vitest";
import {
  ScopeClient,
  ScopeApiError,
  boundedText,
  decodeScopeCertificate,
  issueScopeCertificate,
  scopeCertificateMessage,
  scopeSigningMessage,
  uniqueId,
  valueCid,
  verifyScopeCertificate,
} from "../src/pointer/scope.js";
import {
  generateKeyPair,
  importPrivateKeyPkcs8,
  toBase64Url,
  utf8,
} from "../src/pointer/crypto.js";

describe("Scope protocol", { tags: ["unit"] }, () => {
  it("canonicalizes JSON DAG-CBOR while bounding encoding, numeric, Unicode and structural complexity", async () => {
    expect(await valueCid({ a: 1, b: ["hello", true, null, 1.5] })).toBe(
      await valueCid({ b: ["hello", true, null, 1.5], a: 1 }),
    );
    expect(await valueCid("😀")).toMatch(/^bafyre/);
    for (const invalid of [
      undefined,
      Number.NaN,
      Infinity,
      2 ** 53,
      new Date(),
      "\ud800",
      "\udc00",
      "\ud800x",
      { field: undefined },
      "x".repeat(65536),
      "\u0000".repeat(20000),
      Array(9000).fill(null),
    ]) {
      await expect(valueCid(invalid)).rejects.toThrow();
    }
    let deep: unknown = null;
    for (let i = 0; i < 34; i++) deep = [deep];
    await expect(valueCid(deep)).rejects.toThrow("complexity");
  });
  it("uses service/Scope/subject/exact IDs without expiry and rejects all altered grants", async () => {
    const owner = await generateKeyPair(),
      member = await generateKeyPair();
    const service = "https://service.example",
      scope = uniqueId(),
      id = uniqueId();
    const certificate = await issueScopeCertificate(
      { v: 1, service, scopeId: scope, subject: member.publicRaw, write: [id] },
      await importPrivateKeyPkcs8(owner.privatePkcs8),
    );
    await verifyScopeCertificate(
      certificate,
      owner.publicRaw,
      service,
      scope,
      id,
      member.publicRaw,
    );
    expect(scopeCertificateMessage(certificate.body)).toContain(
      "IPAB-SCOPE-CERT/1",
    );
    for (const invalid of [
      undefined,
      [],
      { body: null },
      { ...certificate, sig: "" },
      { ...certificate, extra: true },
      { ...certificate, body: { ...certificate.body, exp: 1 } },
      { ...certificate, body: { ...certificate.body, write: ["*"] } },
      { ...certificate, body: { ...certificate.body, write: [id, id] } },
      { ...certificate, body: { ...certificate.body, write: [] } },
      {
        ...certificate,
        body: { ...certificate.body, write: Array(33).fill(id) },
      },
    ])
      await expect(
        verifyScopeCertificate(
          invalid,
          owner.publicRaw,
          service,
          scope,
          id,
          member.publicRaw,
        ),
      ).rejects.toThrow("certificate");
    for (const [anchor, origin, targetScope, target, subject] of [
      [member.publicRaw, service, scope, id, member.publicRaw],
      [owner.publicRaw, "https://other.example", scope, id, member.publicRaw],
      [owner.publicRaw, service, uniqueId(), id, member.publicRaw],
      [owner.publicRaw, service, scope, uniqueId(), member.publicRaw],
      [owner.publicRaw, service, scope, id, owner.publicRaw],
    ])
      await expect(
        verifyScopeCertificate(
          certificate,
          anchor!,
          origin!,
          targetScope!,
          target!,
          subject!,
        ),
      ).rejects.toThrow();
    expect(
      decodeScopeCertificate(toBase64Url(utf8(JSON.stringify(certificate)))),
    ).toEqual(certificate);
    expect(() => decodeScopeCertificate("x".repeat(8193))).toThrow("large");
  });
  it("binds every request mutation component to a deterministic domain-separated message", () => {
    const proof = {
      service: "https://service.example",
      scopeId: uniqueId(),
      variableId: uniqueId(),
      method: "PUT",
      path: "/v1/scope/variable",
      bodySha256: "body",
      ifMatch: '"cid"',
      idempotencyKey: uniqueId(),
      timestamp: 1,
      nonce: uniqueId(),
      subject: uniqueId(),
    };
    const original = scopeSigningMessage(proof);
    for (const field of Object.keys(proof) as (keyof typeof proof)[]) {
      const changed = {
        ...proof,
        [field]: field === "timestamp" ? 2 : "different",
      };
      expect(scopeSigningMessage(changed)).not.toBe(original);
    }
  });
});
describe("Scope client wire port", { tags: ["mock"] }, () => {
  it("supports public reads, all Owner lifecycle methods and subject certificates with content-CID CAS", async () => {
    const owner = await generateKeyPair(),
      service = "https://service.example",
      scope = uniqueId(),
      id = uniqueId();
    const requests: Request[] = [];
    const certificate = await issueScopeCertificate(
      { v: 1, service, scopeId: scope, subject: owner.publicRaw, write: [id] },
      owner.privateKey,
    );
    const client = new ScopeClient({
      service,
      apiKey: uniqueId(),
      signer: {
        publicKey: owner.publicRaw,
        privateKey: owner.privatePkcs8,
        certificate,
      },
      now: () => 1,
      nonce: () => uniqueId(),
      fetch: (input, init) => {
        requests.push(new Request(input, init));
        return Promise.resolve(
          Response.json({
            id,
            value: null,
            cid: "current",
            status: "writable",
          }),
        );
      },
    });
    await client.createScope(uniqueId());
    await client.create(scope, null, uniqueId());
    await client.read(scope, id);
    await client.write(scope, id, { changed: true }, "baseline", uniqueId());
    await client.freeze(scope, id, uniqueId());
    await client.delete(scope, id, uniqueId());
    expect(requests.map((request) => request.method)).toEqual([
      "POST",
      "POST",
      "GET",
      "PUT",
      "POST",
      "DELETE",
    ]);
    expect(requests[0]!.headers.has("x-api-key")).toBe(true);
    expect(requests[1]!.headers.has("x-api-key")).toBe(false);
    expect(requests[2]!.headers.has("authorization")).toBe(false);
    expect(requests[2]!.headers.has("x-ipab-certificate")).toBe(false);
    expect(requests[3]!.headers.get("if-match")).toBe('"baseline"');
    expect(requests[3]!.headers.has("x-ipab-certificate")).toBe(true);
    expect(requests[4]!.url).toBe(`${service}/v1/${scope}/${id}/freeze`);
    await expect(client.read("*", id)).rejects.toThrow("Unique ID");
    await expect(client.read(scope, "*")).rejects.toThrow("Unique ID");
    await expect(
      new ScopeClient({ service }).write(scope, id, {}, "cid", uniqueId()),
    ).rejects.toThrow("signer");
    const before = requests.length;
    await expect(client.create(scope, Number.NaN, uniqueId())).rejects.toThrow(
      "finite",
    );
    await expect(
      client.write(scope, id, Number.POSITIVE_INFINITY, "baseline", uniqueId()),
    ).rejects.toThrow("finite");
    expect(requests).toHaveLength(before);
  });
  it("preserves distinct HTTP errors and aborts oversized streamed responses", async () => {
    const service = "https://service.example",
      scope = uniqueId(),
      id = uniqueId();
    for (const body of [
      { error: { code: "frozen", message: "retired" } },
      {},
    ]) {
      const client = new ScopeClient({
        service,
        fetch: () => Promise.resolve(Response.json(body, { status: 423 })),
      });
      await expect(client.read(scope, id)).rejects.toBeInstanceOf(
        ScopeApiError,
      );
    }
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(131073));
      },
      cancel() {
        cancelled = true;
      },
    });
    await expect(boundedText(new Response(stream))).rejects.toThrow("128 KiB");
    expect(cancelled).toBe(true);
    expect(await boundedText(new Response(null))).toBe("");
    expect(await boundedText(new Response("hello"))).toBe("hello");
    await expect(
      boundedText(new Response(new Uint8Array([255]))),
    ).rejects.toThrow("UTF-8");
    expect(
      () => new ScopeClient({ service: "http://public.example" }),
    ).toThrow();
    await expect(
      verifyScopeCertificate(
        { body: { v: 2 } },
        "bad",
        service,
        scope,
        id,
        "bad",
      ),
    ).rejects.toThrow();
  });
});
