import { describe, expect, it } from "vitest";
import { scopeSigningMessage, uniqueId } from "@ipab/bundle/pointer/scope";
import { signEd25519, sha256Hex } from "../src/crypto.ts";
import { ScopeObject, type ScopeWire } from "../src/scope-object.ts";
import {
  API_KEY,
  SERVICE,
  createScopeService,
  scopeWorld,
  testContext,
} from "./helpers.ts";

async function ownerWire(
  w: Awaited<ReturnType<typeof scopeWorld>>,
  method: string,
  body = "",
  id = w.variable.id,
  action = "",
): Promise<ScopeWire> {
  const path = `/v1/${w.scope.id}/${id}${action ? `/${action}` : ""}`;
  const proof = {
    service: SERVICE,
    scopeId: w.scope.id,
    variableId: id,
    method,
    path,
    bodySha256: await sha256Hex(body),
    ifMatch: "",
    idempotencyKey: uniqueId(),
    timestamp: Math.floor(Date.now() / 1000),
    nonce: uniqueId(),
    subject: w.owner.publicRaw,
  };
  return {
    method,
    path,
    body,
    headers: {
      authorization: `Ed25519 ${await signEd25519(w.owner.privateKey, scopeSigningMessage(proof))}`,
      "x-ipab-subject": proof.subject,
      "x-ipab-timestamp": String(proof.timestamp),
      "x-ipab-nonce": proof.nonce,
      "idempotency-key": proof.idempotencyKey,
    },
  };
}
describe(
  "Scope request validation and fail-closed routing",
  { tags: ["mock"] },
  () => {
    it("rejects bad route/method combinations and permits explicit-origin CORS without bypassing mutation checks", async () => {
      const w = await scopeWorld();
      for (const [path, method, status] of [
        ["/unknown", "GET", 404],
        [`/v1/${w.scope.id}/bad`, "GET", 404],
        [`/v1/${w.scope.id}/${w.variable.id}`, "PATCH", 405],
        [`/v1/${w.scope.id}/${w.variable.id}/freeze`, "GET", 405],
      ] as const)
        expect(
          (await w.service.fetch(`${SERVICE}${path}`, { method })).status,
        ).toBe(status);
      expect((await w.service.fetch(`${SERVICE}/_health`)).status).toBe(200);
      const service = await createScopeService({
        allowedOrigin: "https://browser.example",
      });
      const preflight = await service.fetch(`${SERVICE}/v1/${w.scope.id}`, {
        method: "OPTIONS",
        headers: { origin: "https://browser.example" },
      });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get("access-control-allow-origin")).toBe(
        "https://browser.example",
      );
      expect(
        (
          await service.fetch(`${SERVICE}/v1/${w.scope.id}`, {
            headers: { origin: "https://foreign.example" },
          })
        ).headers.has("access-control-allow-origin"),
      ).toBe(false);
    });
    it("reports malformed creation bodies, unavailable API-key digests and oversized wire headers as client errors", async () => {
      const service = await createScopeService();
      for (const body of [
        "{",
        "null",
        "{}",
        '{"owner":"bad"}',
        `{"owner":"${"A".repeat(43)}","extra":true}`,
      ]) {
        const response = await service.fetch(`${SERVICE}/v1/scopes`, {
          method: "POST",
          headers: { "x-api-key": API_KEY },
          body,
        });
        expect(response.status).toBe(400);
      }
      const unavailable = await createScopeService({ digest: "" });
      expect(
        (
          await unavailable.fetch(`${SERVICE}/v1/scopes`, {
            method: "POST",
            headers: { "x-api-key": API_KEY },
            body: "{}",
          })
        ).status,
      ).toBe(401);
      expect(
        (
          await service.fetch(`${SERVICE}/v1/${uniqueId()}`, {
            headers: { "x-ipab-certificate": "x".repeat(8193) },
          })
        ).status,
      ).toBe(413);
      expect(
        (
          await service.fetch(`${SERVICE}/v1/${uniqueId()}`, {
            headers: { arbitrary: "x".repeat(16385) },
          })
        ).status,
      ).toBe(413);
    });
    it("distinguishes invalid/stale proof fields, missing subject certificates and bad signatures", async () => {
      const w = await scopeWorld(),
        object = w.service.objects.get(`scope:${w.scope.id}`)!;
      const original = await ownerWire(w, "PUT", '{"value":null}');
      for (const headers of [
        { ...original.headers, "x-ipab-timestamp": "01" },
        { ...original.headers, "x-ipab-timestamp": "9007199254740993" },
        { ...original.headers, "x-ipab-timestamp": "1" },
        { ...original.headers, "x-ipab-subject": "" },
        { ...original.headers, "x-ipab-nonce": "" },
        { ...original.headers, "idempotency-key": "" },
        { ...original.headers, authorization: "" },
        { ...original.headers, authorization: `Ed25519 ${"A".repeat(86)}` },
        { ...original.headers, "x-ipab-subject": w.member.publicRaw },
        {
          ...original.headers,
          "x-ipab-subject": w.member.publicRaw,
          "x-ipab-certificate": "invalid-json",
        },
      ]) {
        const result = await object.handle(
          { ...original, headers },
          w.scope.id,
          w.variable.id,
          "",
        );
        expect(
          "error" in result ? result.error.status : result.status,
        ).toBeGreaterThanOrEqual(400);
      }
      const headers = { ...original.headers };
      delete headers["x-ipab-timestamp"];
      delete headers["x-ipab-nonce"];
      delete headers["idempotency-key"];
      const result = await object.handle(
        { ...original, headers },
        w.scope.id,
        w.variable.id,
        "",
      );
      expect(result).toMatchObject({ error: { status: 401 } });
    });
    it("consumes verified nonces even for invalid mutation bodies and never accepts management payloads", async () => {
      const w = await scopeWorld(),
        object = w.service.objects.get(`scope:${w.scope.id}`)!;
      for (const body of [
        "{",
        "null",
        '{"value":0,"extra":true}',
        '{"value":"\\ud800"}',
      ]) {
        const wire = await ownerWire(w, "PUT", body);
        const result = await object.handle(wire, w.scope.id, w.variable.id, "");
        expect(result).toMatchObject({ status: 400 });
        expect(
          await object.handle(wire, w.scope.id, w.variable.id, ""),
        ).toMatchObject({ error: { status: 401, code: "replayed" } });
      }
      const management = await ownerWire(
        w,
        "POST",
        '{"value":0}',
        w.variable.id,
        "freeze",
      );
      expect(
        await object.handle(management, w.scope.id, w.variable.id, "freeze"),
      ).toMatchObject({ status: 400 });
      expect(
        await object.handle(
          { method: "GET", path: "", body: "not empty", headers: {} },
          w.scope.id,
          "",
          "",
        ),
      ).toMatchObject({ error: { status: 400 } });
    });
    it("does not configure a conflicting Owner or treat missing/deleted resources as writable", async () => {
      const w = await scopeWorld(),
        object = w.service.objects.get(`scope:${w.scope.id}`)!;
      await object.configure(w.owner.publicRaw);
      await expect(object.configure(w.member.publicRaw)).rejects.toThrow(
        "owner conflict",
      );
      const absent = new ScopeObject(testContext().ctx, w.service.env);
      expect(
        await absent.handle(
          { method: "GET", path: "", body: "", headers: {} },
          uniqueId(),
          "",
          "",
        ),
      ).toMatchObject({ error: { status: 404 } });
      await expect(
        w.client.write(w.scope.id, uniqueId(), {}, w.variable.cid, uniqueId()),
      ).rejects.toMatchObject({ status: 404 });
      const missingCas = await ownerWire(w, "PUT", '{"value":null}');
      expect(
        await object.handle(missingCas, w.scope.id, w.variable.id, ""),
      ).toMatchObject({ status: 428 });
      const invalidMethod = await ownerWire(w, "POST");
      expect(
        await object.handle(invalidMethod, w.scope.id, w.variable.id, ""),
      ).toMatchObject({ status: 405 });
      await w.client.freeze(w.scope.id, w.variable.id, uniqueId());
      await w.client.delete(w.scope.id, w.variable.id, uniqueId());
      await expect(
        w.client.freeze(w.scope.id, w.variable.id, uniqueId()),
      ).rejects.toMatchObject({ status: 410 });
    });
  },
);
describe("Scope durable capacity and recovery", { tags: ["mock"] }, () => {
  it("recovers the same allocation after an ambiguous registry commit and rejects a changed creation intent", async () => {
    const w = await scopeWorld(),
      key = uniqueId();
    const registry = w.service.stores.get(
      `scope-registry:${w.owner.publicRaw}`,
    )!;
    registry.failAfterCommit = true;
    await expect(w.client.createScope(key)).rejects.toMatchObject({
      status: 500,
    });
    registry.failAfterCommit = false;
    w.service.restart();
    const recovered = await w.client.createScope(key);
    expect(await w.client.createScope(key)).toEqual(recovered);
    await expect(
      w.client.send(
        "POST",
        "",
        "",
        { owner: w.owner.publicRaw },
        { ifCid: "different-intent", idempotencyKey: key },
      ),
    ).rejects.toMatchObject({ status: 409 });
    registry.failBeforeCommit = true;
    await expect(w.client.createScope(uniqueId())).rejects.toMatchObject({
      status: 500,
    });
    registry.failBeforeCommit = false;
    await registry.put("count", 4096);
    await expect(w.client.createScope(uniqueId())).rejects.toMatchObject({
      status: 429,
      code: "owner_capacity",
    });
  });
  it("keeps live write retries recoverable at capacity and prunes expired slots instead of evicting live results", async () => {
    const w = await scopeWorld(),
      storage = w.service.stores.get(`scope:${w.scope.id}`)!,
      key = uniqueId();
    const committed = await w.client.write(
      w.scope.id,
      w.variable.id,
      { next: true },
      w.variable.cid,
      key,
    );
    const now = Math.floor(Date.now() / 1000);
    for (let i = 0; i < 4096; i++)
      await storage.put(`retry-meta:seed-${i}`, { expiresAt: now + 600 });
    expect(
      await w.client.write(
        w.scope.id,
        w.variable.id,
        { next: true },
        w.variable.cid,
        key,
      ),
    ).toEqual(committed);
    await expect(
      w.client.write(w.scope.id, w.variable.id, {}, committed.cid, uniqueId()),
    ).rejects.toMatchObject({ status: 429, code: "retry_capacity" });
    for (let i = 0; i < 4096; i++)
      await storage.put(`retry-meta:seed-${i}`, { expiresAt: now - 1 });
    expect(
      (
        await w.client.write(
          w.scope.id,
          w.variable.id,
          {},
          committed.cid,
          uniqueId(),
        )
      ).value,
    ).toEqual({});
  });
  it("does not exceed lifecycle retry, nonce or lifetime allocation capacity", async () => {
    const w = await scopeWorld(),
      storage = w.service.stores.get(`scope:${w.scope.id}`)!;
    for (let i = 0; i < 12288; i++)
      await storage.put(`retry-meta:permanent-${i}`, { expiresAt: null });
    await expect(
      w.client.freeze(w.scope.id, w.variable.id, uniqueId()),
    ).rejects.toMatchObject({ status: 429 });
    const other = await w.client.createScope(uniqueId());
    await w.client.create(other.id, null, uniqueId());
    const otherStorage = w.service.stores.get(`scope:${other.id}`)!;
    await otherStorage.put(
      "nonces",
      Object.fromEntries(
        Array.from({ length: 5000 }, (_, i) => [
          `nonce-${i}`,
          Math.floor(Date.now() / 1000) + 130,
        ]),
      ),
    );
    await expect(
      w.client.create(other.id, null, uniqueId()),
    ).rejects.toMatchObject({ status: 429, code: "nonce_capacity" });
    await otherStorage.put("nonces", {});
    await otherStorage.put("count", 4096);
    await expect(
      w.client.create(other.id, null, uniqueId()),
    ).rejects.toMatchObject({ status: 429, code: "scope_capacity" });
  });
});
