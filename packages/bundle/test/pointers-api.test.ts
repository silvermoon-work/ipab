import { describe, expect, it } from "vitest";
import {
  RootPointerClient,
  pointerSigningMessage,
  pointerOrigin,
  type PointerProof,
} from "../src/pointer/pointers.js";
import {
  generateKeyPair,
  randomBytes,
  toBase64Url,
  verifyEd25519,
  sha256Hex,
} from "../src/pointer/crypto.js";

describe("confirmed pointers API client", { tags: ["mock"] }, () => {
  const root = "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku";
  const origin = "https://pointers.example";
  it("signs every binding and never sends creation API keys on GET or PUT", async () => {
    const keys = await generateKeyPair();
    const apiKey = toBase64Url(randomBytes(32));
    const operation = toBase64Url(randomBytes(18));
    const requests: Request[] = [];
    const transport: typeof fetch = async (input, options) => {
      expect(options?.redirect).toBe("error");
      expect(options?.cache).toBe("no-store");
      const request = new Request(input, options);
      requests.push(request);
      const body = await request.clone().text();
      const proof: PointerProof = {
        origin,
        id: request.method === "POST" ? "" : "server_random_id",
        method: request.method,
        path: new URL(request.url).pathname,
        bodySha256: await sha256Hex(body),
        ifMatch: request.headers.get("if-match") ?? "",
        idempotencyKey: request.headers.get("idempotency-key") ?? "",
        timestamp: Number(request.headers.get("x-pointer-timestamp")),
        nonce: request.headers.get("x-pointer-nonce")!,
        subject: keys.publicRaw,
      };
      const signature = request.headers.get("authorization")!.split(" ")[1]!;
      expect(
        await verifyEd25519(
          keys.publicKey,
          signature,
          pointerSigningMessage(proof),
        ),
      ).toBe(true);
      for (const field of [
        "origin",
        "id",
        "method",
        "path",
        "bodySha256",
        "ifMatch",
        "idempotencyKey",
        "nonce",
        "subject",
      ] as const)
        expect(
          await verifyEd25519(
            keys.publicKey,
            signature,
            pointerSigningMessage({
              ...proof,
              [field]: `${proof[field]}changed`,
            }),
          ),
        ).toBe(false);
      expect(
        await verifyEd25519(
          keys.publicKey,
          signature,
          pointerSigningMessage({ ...proof, timestamp: proof.timestamp + 1 }),
        ),
      ).toBe(false);
      if (request.method === "POST") {
        expect(request.headers.get("x-api-key")).toBe(apiKey);
        expect(JSON.parse(body)).toEqual({ owner: keys.publicRaw, root });
        return new Response('{"id":"server_random_id"}', { status: 201 });
      }
      expect(request.headers.has("x-api-key")).toBe(false);
      return new Response(
        JSON.stringify({ root, revision: "9007199254740993" }),
        { headers: { etag: '"9007199254740993"' } },
      );
    };
    const options = {
      origin,
      privateKey: keys.privatePkcs8,
      publicKey: keys.publicRaw,
      fetch: transport,
    };
    const creator = new RootPointerClient(options);
    expect(await creator.create(root, { origin, apiKey }, operation)).toBe(
      "server_random_id",
    );
    const pointer = new RootPointerClient({
      ...options,
      id: "server_random_id",
    });
    expect((await pointer.read()).revision).toBe("9007199254740993");
    await pointer.write(root, "9007199254740993", operation);
    expect(requests[2]!.headers.get("if-match")).toBe('"9007199254740993"');
    await expect(
      creator.create(
        root,
        { origin: "https://other.example", apiKey },
        operation,
      ),
    ).rejects.toThrow("bound");
    expect(requests).toHaveLength(3);
  });
  it("network retries keep the operation key but issue fresh nonce proofs", async () => {
    const keys = await generateKeyPair();
    const headers: Headers[] = [];
    const operation = toBase64Url(randomBytes(18));
    const client = new RootPointerClient({
      origin,
      id: "server_random_id",
      privateKey: keys.privatePkcs8,
      publicKey: keys.publicRaw,
      fetch: (input, options) => {
        const request = new Request(input, options);
        headers.push(request.headers);
        if (headers.length === 1) throw new TypeError("network unavailable");
        return Promise.resolve(
          new Response(JSON.stringify({ root, revision: "2" }), {
            headers: { etag: '"2"' },
          }),
        );
      },
    });
    await client.write(root, "1", operation);
    expect(headers.map((header) => header.get("idempotency-key"))).toEqual([
      operation,
      operation,
    ]);
    expect(headers[0]!.get("x-pointer-nonce")).not.toBe(
      headers[1]!.get("x-pointer-nonce"),
    );
  });
  it("rejects malformed revision/ETag, foreign origins, and parses authenticated CAS details", async () => {
    const keys = await generateKeyPair();
    const operation = toBase64Url(randomBytes(18));
    const base = {
      origin,
      id: "server_random_id",
      privateKey: keys.privatePkcs8,
      publicKey: keys.publicRaw,
    };
    expect(() =>
      pointerOrigin("https://pointers.example/business-path"),
    ).toThrow("fixed");
    expect(() => pointerOrigin("http://remote.example")).toThrow("HTTPS");
    await expect(
      new RootPointerClient({
        ...base,
        fetch: () =>
          Promise.resolve(
            new Response(JSON.stringify({ root, revision: "01" })),
          ),
      }).read(),
    ).rejects.toThrow("revision");
    await expect(
      new RootPointerClient({
        ...base,
        fetch: () =>
          Promise.resolve(
            new Response(JSON.stringify({ root, revision: "1" })),
          ),
      }).read(),
    ).rejects.toThrow("ETag");
    await expect(
      new RootPointerClient({
        ...base,
        fetch: () =>
          Promise.resolve(
            new Response(
              JSON.stringify({
                error: {
                  code: "precondition_failed",
                  message: "changed",
                  details: { root, revision: "13" },
                },
              }),
              { status: 412, headers: { etag: '"13"' } },
            ),
          ),
      }).write(root, "12", operation),
    ).rejects.toMatchObject({ status: 412, current: { root, revision: "13" } });
  });
  it("fails closed on oversized/malformed responses and never echoes reflected credential material", async () => {
    const keys = await generateKeyPair();
    const apiKey = toBase64Url(randomBytes(32));
    const operation = toBase64Url(randomBytes(18));
    const base = {
      origin,
      privateKey: keys.privatePkcs8,
      publicKey: keys.publicRaw,
    };
    for (const response of [
      new Response(new Uint8Array(65 * 1024)),
      new Response("not JSON"),
      new Response(null, { status: 204 }),
    ]) {
      await expect(
        new RootPointerClient({
          ...base,
          id: "server_random_id",
          fetch: () => Promise.resolve(response),
        }).read(),
      ).rejects.toThrow(/body|byte limit|Malformed/);
    }
    for (const body of [
      JSON.stringify({ id: apiKey }),
      JSON.stringify({ error: { code: apiKey, message: apiKey } }),
      `{"broken":"${apiKey}`,
    ]) {
      const client = new RootPointerClient({
        ...base,
        fetch: () =>
          Promise.resolve(
            new Response(body, { status: body.includes("error") ? 401 : 201 }),
          ),
      });
      const message = await client
        .create(root, { origin, apiKey }, operation)
        .catch((error: unknown) =>
          error instanceof Error ? error.message : "invalid error",
        );
      expect(message.includes(apiKey)).toBe(false);
    }
    await expect(
      new RootPointerClient({
        ...base,
        fetch: () => Promise.resolve(new Response('{"id":4}')),
      }).create(root, { origin, apiKey }, operation),
    ).rejects.toThrow("creation response");
  });
  it("rejects invalid targets/CAS arguments and bounds unknown network retries", async () => {
    const keys = await generateKeyPair();
    const base = {
      origin,
      privateKey: keys.privatePkcs8,
      publicKey: keys.publicRaw,
    };
    const operation = toBase64Url(randomBytes(18));
    expect(() => new RootPointerClient({ ...base, id: "../escape" })).toThrow(
      "pointer ID",
    );
    await expect(new RootPointerClient(base).read()).rejects.toThrow(
      "pointer ID",
    );
    await expect(
      new RootPointerClient(base).write(root, "1", operation),
    ).rejects.toThrow("CAS");
    const addressed = new RootPointerClient({
      ...base,
      id: "server_random_id",
    });
    await expect(
      addressed.create(
        root,
        { origin, apiKey: toBase64Url(randomBytes(32)) },
        operation,
      ),
    ).rejects.toThrow("bound");
    await expect(addressed.write(root, "*", operation)).rejects.toThrow("CAS");
    await expect(addressed.write(root, "1", "not-random")).rejects.toThrow(
      "operation",
    );
    let attempts = 0;
    const failed = new RootPointerClient({
      ...base,
      id: "server_random_id",
      now: () => 1_000,
      nonce: () => toBase64Url(randomBytes(18)),
      fetch: () => {
        attempts++;
        return Promise.reject(new TypeError("unavailable"));
      },
    });
    await expect(failed.write(root, "1", operation)).rejects.toThrow(
      "result is unknown",
    );
    expect(attempts).toBe(3);
  });
});
