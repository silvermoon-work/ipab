import { describe, expect, it, vi } from "vitest";
import {
  PointerClient,
  PointerApiError,
  rawPublicKeyBytes,
  utf8Bytes,
} from "../src/client.ts";
import { runOperator } from "../src/operator.ts";
import { fromBase64Url, publicKeyToPem, sha256Hex } from "../src/crypto.ts";
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
} from "./helpers.ts";

describe("new client shapes", { tags: ["mock"] }, () => {
  it("creates, reads, writes and returns authorized 412 current state", async () => {
    const service = await createService(),
      owner = await generateKeyPair();
    const client = new PointerClient({
      service: SERVICE,
      apiKey: API_KEY,
      signer: { privateKey: owner.privatePkcs8, publicKey: owner.publicRaw },
      fetch: service.fetch,
      now: () => NOW,
    });
    const { id } = await client.create(ROOT, { idempotencyKey: "create" });
    expect(await client.create(ROOT, { idempotencyKey: "create" })).toEqual({
      id,
    });
    expect(await client.read(id)).toEqual({
      root: ROOT,
      revision: "1",
      etag: '"1"',
    });
    const written = await client.write(id, ROOT2, {
      ifRevision: "1",
      idempotencyKey: "edit",
    });
    expect(written).toEqual({ root: ROOT2, revision: "2", etag: '"2"' });
    expect(await client.create(ROOT, { idempotencyKey: "create" })).toEqual({
      id,
    });
    expect(await client.read(id)).toEqual(written);
    expect(
      await client.write(id, ROOT2, {
        ifRevision: "1",
        idempotencyKey: "edit",
      }),
    ).toEqual(written);
    try {
      await client.write(id, ROOT, { ifRevision: "1" });
      throw new Error("expected conflict");
    } catch (err) {
      expect(err).toBeInstanceOf(PointerApiError);
      expect(err).toMatchObject({
        status: 412,
        code: "precondition_failed",
        current: { root: ROOT2, revision: "2" },
      });
    }
  });
  it("only sends the API key on creation, rejects redirects and lets members read/write", async () => {
    const service = await createService(),
      owner = await generateKeyPair(),
      member = await generateKeyPair();
    const seen: RequestInit[] = [];
    const transport: typeof fetch = (url, init) => {
      seen.push(init!);
      return service.fetch(url, init);
    };
    const client = new PointerClient({
      service: SERVICE,
      apiKey: API_KEY,
      signer: { privateKey: owner.privatePkcs8, publicKey: owner.publicRaw },
      fetch: transport,
    });
    const { id } = await client.create(ROOT);
    await client.read(id);
    await client.write(id, ROOT2, { ifRevision: "1" });
    expect(new Headers(seen[0]!.headers).get("x-api-key")).toBe(API_KEY);
    for (const request of seen.slice(1)) {
      expect(new Headers(request.headers).get("x-api-key")).toBeNull();
      expect(request.redirect).toBe("error");
    }
    const certificate = await makeCert(owner, member, id);
    const memberClient = new PointerClient({
      service: SERVICE,
      apiKey: API_KEY,
      signer: {
        privateKey: member.privatePkcs8,
        publicKey: member.publicRaw,
        certificate,
      },
      fetch: service.fetch,
    });
    expect((await memberClient.read(id)).revision).toBe("2");
    expect(
      (await memberClient.write(id, ROOT, { ifRevision: "2" })).revision,
    ).toBe("3");
    await expect(memberClient.create(ROOT)).rejects.toThrow("direct owner");
  });
  it("validates options and safe client preconditions", async () => {
    const owner = await generateKeyPair(),
      signer = { privateKey: owner.privatePkcs8, publicKey: owner.publicRaw };
    expect(
      () => new PointerClient({ service: "http://public.example", signer }),
    ).toThrow();
    expect(
      () =>
        new PointerClient({
          service: SERVICE,
          signer: { ...signer, publicKey: "AAAA" },
        }),
    ).toThrow("full canonical");
    expect(
      () =>
        new PointerClient({
          service: SERVICE,
          signer: { ...signer, privateKey: "" },
        }),
    ).toThrow("private key");
    expect(
      () =>
        new PointerClient({
          service: SERVICE,
          signer,
          apiKey: "private\nmalformed-key",
        }),
    ).toThrow("canonical base64url");
    const client = new PointerClient({
      service: SERVICE,
      signer,
      nonce: () => "a".repeat(32),
    });
    await expect(client.create(ROOT)).rejects.toThrow("API key");
    await expect(client.read("named-pointer")).rejects.toThrow(
      "invalid pointer ID",
    );
    await expect(client.write("id", ROOT, { ifRevision: "0" })).rejects.toThrow(
      "positive canonical",
    );
    expect([...rawPublicKeyBytes(owner.publicRaw)]).toEqual([
      ...fromBase64Url(owner.publicRaw),
    ]);
    expect([...rawPublicKeyBytes(publicKeyToPem(owner.publicRaw))]).toEqual([
      ...fromBase64Url(owner.publicRaw),
    ]);
    expect(new TextDecoder().decode(utf8Bytes("héllo"))).toBe("héllo");
  });
  it("surfaces HTTP errors without fabricating current state", async () => {
    const owner = await generateKeyPair();
    const client = new PointerClient({
      service: SERVICE,
      signer: { privateKey: owner.privatePkcs8, publicKey: owner.publicRaw },
      fetch: () => Promise.resolve(Response.json({}, { status: 503 })),
      nonce: () => "a".repeat(32),
      now: () => NOW,
    });
    await expect(client.read("A".repeat(43))).rejects.toMatchObject({
      status: 503,
      code: "http_error",
      current: undefined,
      message: "HTTP 503",
    });
  });
});

describe("operator commands", { tags: ["mock"] }, () => {
  it("accepts opaque IDs and idempotency keys beginning with a dash", async () => {
    const owner = await generateKeyPair();
    const id = `-${"A".repeat(42)}`;
    let request: Request | undefined;
    await runOperator(
      [
        "write",
        "--key",
        "key.json",
        "--id",
        id,
        "--root",
        ROOT,
        "--if-revision",
        "1",
        "--idempotency-key",
        "-".repeat(24),
      ],
      {
        env: { IPAB_POINTERS_SERVICE: SERVICE },
        read: () =>
          Promise.resolve(
            JSON.stringify({
              publicKey: owner.publicRaw,
              privateKey: owner.privatePkcs8,
            }),
          ),
        print: () => undefined,
        fetch: (input, options) => {
          request = new Request(input, options);
          return Promise.resolve(
            new Response(JSON.stringify({ root: ROOT, revision: "2" }), {
              headers: { etag: '"2"' },
            }),
          );
        },
      },
    );
    expect(request?.url).toBe(`${SERVICE}/v1/pointers/${id}`);
    expect(request?.headers.get("idempotency-key")).toBe("-".repeat(24));
  });
  it("consumes flat protected JSON config or aligned environment without exposing the API key", async () => {
    const service = await createService(),
      owner = await generateKeyPair();
    const key = JSON.stringify({
      publicKey: owner.publicRaw,
      privateKey: owner.privatePkcs8,
    });
    const output: string[] = [];
    const io = {
      env: {},
      print: (line: string) => output.push(line),
      fetch: service.fetch,
      read: (path: string) =>
        Promise.resolve(
          path === "config.json"
            ? JSON.stringify({
                "pointers.service": SERVICE,
                "pointers.apiKey": API_KEY,
              })
            : key,
        ),
    };
    await runOperator(
      [
        "create",
        "--key",
        "owner.json",
        "--root",
        ROOT,
        "--config-file",
        "config.json",
        "--idempotency-key",
        "first",
      ],
      io,
    );
    const { id } = JSON.parse(output.pop()!) as { id: string };
    await runOperator(["read", "--key", "owner.json", "--id", id], {
      ...io,
      env: { IPAB_POINTERS_SERVICE: SERVICE },
    });
    expect(JSON.parse(output.pop()!)).toEqual({
      root: ROOT,
      revision: "1",
      etag: '"1"',
    });
    await runOperator(
      [
        "write",
        "--key",
        "owner.json",
        "--id",
        id,
        "--root",
        ROOT2,
        "--if-revision",
        "1",
      ],
      {
        ...io,
        env: { IPAB_POINTERS_SERVICE: SERVICE, IPAB_POINTERS_API_KEY: API_KEY },
      },
    );
    expect(JSON.parse(output.pop()!)).toEqual({
      root: ROOT2,
      revision: "2",
      etag: '"2"',
    });
    await runOperator(
      [
        "create",
        "--key",
        "owner.json",
        "--root",
        ROOT,
        "--service",
        SERVICE,
        "--api-key-file",
        "api-key.txt",
      ],
      {
        ...io,
        read: (path) =>
          Promise.resolve(path === "api-key.txt" ? `${API_KEY}\n` : key),
      },
    );
    expect(output.join("\n")).not.toContain(API_KEY);
  });
  it("issues only owner leaf certificates bound to service, ID, member and validity", async () => {
    const service = await createService(),
      owner = await generateKeyPair(),
      member = await generateKeyPair();
    const id = await createPointer(service, owner),
      stores = new Map([
        [
          "owner.json",
          JSON.stringify({
            publicKey: owner.publicRaw,
            privateKey: owner.privatePkcs8,
          }),
        ],
        [
          "member.json",
          JSON.stringify({
            publicKey: member.publicRaw,
            privateKey: member.privatePkcs8,
          }),
        ],
      ]);
    const io = {
      env: { IPAB_POINTERS_SERVICE: SERVICE },
      print: vi.fn(),
      read: (path: string) => Promise.resolve(stores.get(path)!),
      save: (path: string, text: string) => {
        stores.set(path, text);
        return Promise.resolve();
      },
    };
    await runOperator(
      [
        "certify",
        "--issuer",
        "owner.json",
        "--member-key",
        "member.json",
        "--id",
        id,
        "--out",
        "certified.json",
      ],
      io,
    );
    const signer = JSON.parse(stores.get("certified.json")!) as {
      publicKey: string;
      privateKey: string;
      certificate: Awaited<ReturnType<typeof makeCert>>;
    };
    expect(signer.certificate.body).toMatchObject({
      service: SERVICE,
      pointerId: id,
      owner: owner.publicRaw,
      member: member.publicRaw,
      v: 2,
    });
    expect(
      (
        await new PointerClient({
          service: SERVICE,
          signer,
          fetch: service.fetch,
        }).read(id)
      ).revision,
    ).toBe("1");
    await expect(
      runOperator(
        [
          "certify",
          "--issuer",
          "certified.json",
          "--member-key",
          "member.json",
          "--id",
          id,
          "--out",
          "delegated.json",
        ],
        io,
      ),
    ).rejects.toThrow("member delegation");
    await expect(
      runOperator(
        [
          "certify",
          "--issuer",
          "owner.json",
          "--member-key",
          "member.json",
          "--id",
          id,
          "--out",
          "invalid.json",
          "--days",
          "0",
        ],
        io,
      ),
    ).rejects.toThrow("positive");
    await expect(
      runOperator(
        [
          "certify",
          "--issuer",
          "owner.json",
          "--member-key",
          "member.json",
          "--id",
          id,
          "--out",
          "short.json",
          "--days",
          "0.0000000001",
        ],
        io,
      ),
    ).rejects.toThrow("positive safe validity");
  });
  it("generates API key material only on explicit invocation and prints the key once plus digest instructions", async () => {
    const random = vi
      .spyOn(crypto, "getRandomValues")
      .mockImplementation((array) => array);
    try {
      const lines: string[] = [];
      await runOperator(["api-key"], { print: (line) => lines.push(line) });
      expect(lines[0]).toBe("A".repeat(43));
      expect(lines[1]).toContain(await sha256Hex(lines[0]!));
      expect(lines.slice(1).join("\n")).not.toContain(lines[0]!);
      expect(random).toHaveBeenCalledTimes(1);
    } finally {
      random.mockRestore();
    }
  });
  it("keygen writes a keystore without printing private key material", async () => {
    const stores = new Map<string, string>(),
      lines: string[] = [];
    await runOperator(["keygen", "--out", "owner.json"], {
      print: (line) => lines.push(line),
      save: (path, text) => {
        stores.set(path, text);
        return Promise.resolve();
      },
    });
    const key = JSON.parse(stores.get("owner.json")!) as {
      privateKey: string;
      publicKey: string;
    };
    expect(lines.join("\n")).not.toContain(key.privateKey);
    expect(lines.join("\n")).toContain(key.publicKey);
  });
  it("rejects malformed config, missing options, old commands and invalid IDs", async () => {
    const owner = await generateKeyPair();
    const io = {
      env: { IPAB_POINTERS_SERVICE: SERVICE },
      read: () =>
        Promise.resolve(
          JSON.stringify({
            publicKey: owner.publicRaw,
            privateKey: owner.privatePkcs8,
          }),
        ),
    };
    await expect(runOperator(["read"], io)).rejects.toThrow("--key required");
    await expect(
      runOperator(["read", "--key", "owner.json", "--id", "named"], io),
    ).rejects.toThrow("invalid pointer ID");
    await expect(
      runOperator(["rotate", "--key", "owner.json"], io),
    ).rejects.toThrow("commands:");
    await expect(
      runOperator(["read", "--config-file", "config.json"], {
        ...io,
        read: () => Promise.resolve("[]"),
      }),
    ).rejects.toThrow("JSON object");
    await expect(
      runOperator(["read", "--config-file", "config.json"], {
        ...io,
        read: () => Promise.resolve('{"pointers.apiKey":"private-fragment'),
      }),
    ).rejects.toThrow("valid protected JSON");
    await expect(
      runOperator(["read", "--key", "owner.json"], {
        ...io,
        read: () => Promise.resolve('{"privateKey":"private-fragment'),
      }),
    ).rejects.toThrow("valid protected JSON");
    await expect(
      runOperator(["read", "--key", "owner.json"], {
        ...io,
        read: () => Promise.resolve("{}"),
      }),
    ).rejects.toThrow("requires canonical");
  });
});
