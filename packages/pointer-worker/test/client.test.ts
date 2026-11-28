import { describe, expect, it } from "vitest";
import { ScopeClient, uniqueId, valueCid } from "@ipab/bundle/pointer/scope";
import { generateKeyPair } from "./helpers.ts";

describe("Scope client", { tags: ["mock"] }, () => {
  it("public GET has no signer, certificate or secret header", async () => {
    let request: Request | undefined;
    const client = new ScopeClient({
      service: "https://service.example",
      fetch: (input, init) => {
        request = new Request(input, init);
        return Promise.resolve(
          Response.json({ value: null, cid: "cid", status: "writable" }),
        );
      },
    });
    await client.read(uniqueId(), uniqueId());
    expect(request!.headers.has("authorization")).toBe(false);
    expect(request!.headers.has("x-api-key")).toBe(false);
    expect(request!.headers.has("x-ipab-certificate")).toBe(false);
  });
  it("reports service errors distinctly and rejects unbounded responses or unsigned writes", async () => {
    const client = new ScopeClient({
      service: "https://service.example",
      fetch: () =>
        Promise.resolve(
          Response.json(
            { error: { code: "cas_conflict", message: "changed" } },
            { status: 412 },
          ),
        ),
    });
    await expect(client.read(uniqueId(), uniqueId())).rejects.toMatchObject({
      status: 412,
      code: "cas_conflict",
    });
    await expect(
      client.write(uniqueId(), uniqueId(), {}, "cid", uniqueId()),
    ).rejects.toThrow("signer");
    const giant = new ScopeClient({
      service: "https://service.example",
      fetch: () => Promise.resolve(new Response("x".repeat(131073))),
    });
    await expect(giant.read(uniqueId(), uniqueId())).rejects.toThrow("128 KiB");
  });
  it("validates canonical services, IDs and stable DAG-CBOR JSON value identity", async () => {
    expect(() => new ScopeClient({ service: "http://public.example" })).toThrow(
      "HTTPS",
    );
    const owner = await generateKeyPair();
    const client = new ScopeClient({
      service: "https://service.example",
      signer: { publicKey: owner.publicRaw, privateKey: owner.privatePkcs8 },
    });
    await expect(client.read("*", uniqueId())).rejects.toThrow("Unique ID");
    expect(await valueCid({ b: 2, a: 1 })).toBe(await valueCid({ a: 1, b: 2 }));
    for (const invalid of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      9007199254740992,
      undefined,
      "\ud800",
      new Date(),
    ]) {
      await expect(valueCid(invalid)).rejects.toThrow();
    }
    let deep: unknown = null;
    for (let i = 0; i < 34; i++) deep = [deep];
    await expect(valueCid(deep)).rejects.toThrow("complexity");
  });
});
