import { describe, expect, it } from "vitest";
import {
  ScopeClient,
  ScopeApiError,
  uniqueId,
  valueCid,
} from "@ipab/bundle/pointer/scope";
import { SERVICE, generateKeyPair, scopeWorld } from "./helpers.ts";
describe("Scope / Variable service", { tags: ["mock"] }, () => {
  it("uses independent opaque Scope and Variable IDs and allows completely public reads", async () => {
    const w = await scopeWorld();
    expect(w.scope.id).not.toBe(w.variable.id);
    expect(w.scope.id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await w.reader.read(w.scope.id, w.variable.id)).toEqual({
      value: { root: "A" },
      cid: await valueCid({ root: "A" }),
      status: "writable",
    });
    expect(await w.reader.send("GET", w.scope.id)).toEqual({
      id: w.scope.id,
      owner: w.owner.publicRaw,
    });
    const other = await w.client.createScope(uniqueId());
    await expect(w.reader.read(other.id, w.variable.id)).rejects.toMatchObject({
      status: 404,
    });
    expect(
      (await w.service.fetch(`${SERVICE}/v1/pointers/${w.variable.id}`)).status,
    ).toBe(404);
  });
  it("allows subject possession for exact HEAD and profile IDs, not other resources or management", async () => {
    const w = await scopeWorld();
    const written = await w.memberClient.write(
      w.scope.id,
      w.variable.id,
      { root: "B" },
      w.variable.cid,
      uniqueId(),
    );
    expect(written.value).toEqual({ root: "B" });
    await w.memberClient.write(
      w.scope.id,
      w.profile.id,
      { name: "Member" },
      w.profile.cid,
      uniqueId(),
    );
    const config = await w.client.create(w.scope.id, {}, uniqueId());
    await expect(
      w.memberClient.write(w.scope.id, config.id, {}, config.cid, uniqueId()),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      w.memberClient.create(w.scope.id, {}, uniqueId()),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      w.memberClient.freeze(w.scope.id, w.variable.id, uniqueId()),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      w.memberClient.delete(w.scope.id, w.variable.id, uniqueId()),
    ).rejects.toMatchObject({ status: 403 });
    const impostor = await generateKeyPair();
    const attacker = new ScopeClient({
      service: SERVICE,
      fetch: w.service.fetch,
      signer: {
        publicKey: impostor.publicRaw,
        privateKey: impostor.privatePkcs8,
        certificate: w.certificate,
      },
    });
    await expect(
      attacker.write(w.scope.id, w.variable.id, {}, written.cid, uniqueId()),
    ).rejects.toMatchObject({ status: 403 });
  });
  it("rejects tampered, foreign-service, foreign-Scope and wildcard certificates without time expiry", async () => {
    const w = await scopeWorld();
    for (const body of [
      { ...w.certificate.body, service: "https://elsewhere.example" },
      { ...w.certificate.body, scopeId: uniqueId() },
      { ...w.certificate.body, write: ["*"] },
      { ...w.certificate.body, subject: w.owner.publicRaw },
    ]) {
      const signer = {
        publicKey: w.member.publicRaw,
        privateKey: w.member.privatePkcs8,
        certificate: { ...w.certificate, body },
      };
      await expect(
        new ScopeClient({
          service: SERVICE,
          fetch: w.service.fetch,
          signer,
        }).write(w.scope.id, w.variable.id, {}, w.variable.cid, uniqueId()),
      ).rejects.toMatchObject({ status: 403 });
    }
    expect(Object.keys(w.certificate.body).sort()).toEqual([
      "scopeId",
      "service",
      "subject",
      "v",
      "write",
    ]);
    await w.memberClient.write(
      w.scope.id,
      w.variable.id,
      {},
      w.variable.cid,
      uniqueId(),
    );
  });
  it("performs content CID CAS with ABA, normal conflict and idempotent network retries", async () => {
    const w = await scopeWorld(),
      key = uniqueId();
    const b = await w.client.write(
      w.scope.id,
      w.variable.id,
      { root: "B" },
      w.variable.cid,
      key,
    );
    expect(
      await w.client.write(
        w.scope.id,
        w.variable.id,
        { root: "B" },
        w.variable.cid,
        key,
      ),
    ).toEqual(b);
    await expect(
      w.client.write(
        w.scope.id,
        w.variable.id,
        { root: "C" },
        w.variable.cid,
        uniqueId(),
      ),
    ).rejects.toMatchObject({ status: 412, code: "cas_conflict" });
    await expect(
      w.client.write(w.scope.id, w.variable.id, {}, w.variable.cid, key),
    ).rejects.toMatchObject({ status: 409 });
    const a = await w.client.write(
      w.scope.id,
      w.variable.id,
      { root: "A" },
      b.cid,
      uniqueId(),
    );
    expect(a.cid).toBe(w.variable.cid);
    expect(
      (
        await w.client.write(
          w.scope.id,
          w.variable.id,
          { root: "C" },
          w.variable.cid,
          uniqueId(),
        )
      ).value,
    ).toEqual({ root: "C" });
  });
  it("requires freeze before delete, freezes Owner too, exposes final reads and never resurrects an ID", async () => {
    const w = await scopeWorld();
    await expect(
      w.client.delete(w.scope.id, w.variable.id, uniqueId()),
    ).rejects.toMatchObject({ status: 409 });
    const final = await w.client.freeze(w.scope.id, w.variable.id, uniqueId());
    expect(final.status).toBe("frozen");
    expect(await w.reader.read(w.scope.id, w.variable.id)).toEqual(final);
    await expect(
      w.client.write(w.scope.id, w.variable.id, {}, final.cid, uniqueId()),
    ).rejects.toMatchObject({ status: 423 });
    const deleted = await w.client.delete(
      w.scope.id,
      w.variable.id,
      uniqueId(),
    );
    expect(deleted.status).toBe("deleted");
    await expect(
      w.reader.read(w.scope.id, w.variable.id),
    ).rejects.toMatchObject({ status: 410 });
    await expect(
      w.client.write(w.scope.id, w.variable.id, {}, deleted.cid, uniqueId()),
    ).rejects.toMatchObject({ status: 410 });
    expect((await w.client.create(w.scope.id, {}, uniqueId())).id).not.toBe(
      w.variable.id,
    );
  });
  it("binds method, target, body, CAS, idempotency, subject, service and fresh nonce in each proof", async () => {
    const w = await scopeWorld();
    let signed: { url: string; headers: Headers; body: string } | undefined;
    const capturing: typeof fetch = async (input, init) => {
      if (typeof input !== "string" || typeof init?.body !== "string")
        throw new Error("Expected the client's canonical JSON wire request.");
      signed = {
        url: input,
        headers: new Headers(init.headers),
        body: init.body,
      };
      return w.service.fetch(input, init);
    };
    const client = new ScopeClient({
      service: SERVICE,
      signer: {
        publicKey: w.owner.publicRaw,
        privateKey: w.owner.privatePkcs8,
      },
      fetch: capturing,
    });
    await client.write(
      w.scope.id,
      w.variable.id,
      { root: "B" },
      w.variable.cid,
      uniqueId(),
    );
    expect(
      (
        await w.service.fetch(signed!.url, {
          method: "PUT",
          headers: signed!.headers,
          body: signed!.body,
        })
      ).status,
    ).toBe(401);
    for (const mutate of [
      "body",
      "if-match",
      "idempotency-key",
      "x-ipab-subject",
      "url",
    ]) {
      const headers = new Headers(signed!.headers);
      if (mutate !== "body" && mutate !== "url")
        headers.set(
          mutate,
          mutate === "x-ipab-subject" ? w.member.publicRaw : uniqueId(),
        );
      const url =
        mutate === "url"
          ? `${SERVICE}/v1/${w.scope.id}/${w.profile.id}`
          : signed!.url;
      expect(
        (
          await w.service.fetch(url, {
            method: "PUT",
            headers,
            body: mutate === "body" ? '{"value":{}}' : signed!.body,
          })
        ).status,
      ).not.toBe(200);
    }
    const stale = new ScopeClient({
      service: SERVICE,
      signer: {
        publicKey: w.owner.publicRaw,
        privateKey: w.owner.privatePkcs8,
      },
      fetch: w.service.fetch,
      now: () => 1,
    });
    await expect(
      stale.freeze(w.scope.id, w.variable.id, uniqueId()),
    ).rejects.toMatchObject({ status: 401 });
  });
  it("bounds JSON, streamed wire input, headers, resource allocation and validates API key", async () => {
    const w = await scopeWorld();
    await expect(
      w.client.create(w.scope.id, { data: "x".repeat(65536) }, uniqueId()),
    ).rejects.toMatchObject({ status: 400 });
    const body = "x".repeat(131073);
    expect(
      (
        await w.service.fetch(
          new Request(`${SERVICE}/v1/${w.scope.id}`, { method: "POST", body }),
        )
      ).status,
    ).toBe(413);
    expect(
      (
        await w.service.fetch(
          new Request(`${SERVICE}/v1/${w.scope.id}`, {
            headers: { huge: "x".repeat(16385) },
          }),
        )
      ).status,
    ).toBe(413);
    expect(
      (await w.service.fetch(`${SERVICE}/v1/${w.scope.id}?x=1`)).status,
    ).toBe(400);
    const unauthorized = new ScopeClient({
      service: SERVICE,
      signer: {
        publicKey: w.owner.publicRaw,
        privateKey: w.owner.privatePkcs8,
      },
      fetch: w.service.fetch,
    });
    await expect(unauthorized.createScope(uniqueId())).rejects.toBeInstanceOf(
      ScopeApiError,
    );
    await w.service.stores.get(`scope:${w.scope.id}`)!.put("count", 4096);
    await expect(
      w.client.create(w.scope.id, {}, uniqueId()),
    ).rejects.toMatchObject({ status: 429 });
  });
});
