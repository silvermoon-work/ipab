import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PointerClient } from "../src/client.ts";
import {
  MAX_IDEMPOTENCY_RECORDS,
  type PointerConfig,
} from "../src/protocol.ts";
import { toBase64Url } from "../src/crypto.ts";
import {
  API_KEY,
  NOW,
  ROOT,
  ROOT2,
  SERVICE,
  createService,
  generateKeyPair,
} from "./helpers.ts";

interface CreationRecord {
  config: PointerConfig;
  fingerprint: string;
  retryKey: string;
  expiresAt: number | null;
}
describe("bounded retry lifecycle", { tags: ["mock"] }, () => {
  let now: number;
  beforeEach(() => {
    now = NOW;
    vi.spyOn(Date, "now").mockImplementation(() => now * 1000);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
  async function world() {
    const service = await createService(),
      owner = await generateKeyPair();
    const client = new PointerClient({
      service: SERVICE,
      apiKey: API_KEY,
      signer: { publicKey: owner.publicRaw, privateKey: owner.privatePkcs8 },
      fetch: service.fetch,
      now: () => now,
    });
    return { service, client };
  }

  it("retains completed creation retries for ten minutes without renewal, prunes both indexes after restart, and permits key reuse", async () => {
    const { service, client } = await world();
    const first = await client.create(ROOT, { idempotencyKey: "create" });
    const allocation = `allocation:${first.id}`;
    const record =
      (await service.registryStore.get<CreationRecord>(allocation))!;
    await client.write(first.id, ROOT2, { ifRevision: "1" });
    now += 599;
    service.restart();
    expect(await client.create(ROOT, { idempotencyKey: "create" })).toEqual(
      first,
    );
    expect(
      (await service.registryStore.get<CreationRecord>(allocation))!.expiresAt,
    ).toBe(record.expiresAt);
    now += 1;
    service.restart();
    const next = await client.create(ROOT, { idempotencyKey: "create" });
    expect(next.id).not.toBe(first.id);
    expect(await service.registryStore.get(allocation)).toBeUndefined();
    expect(
      (await service.registryStore.get<CreationRecord>(record.retryKey))!.config
        .id,
    ).toBe(next.id);
    expect((await client.read(first.id)).root).toBe(ROOT2);
  });

  it("rejects full unexpired creation capacity without eviction, still serves existing retries, then frees expired capacity", async () => {
    const { service, client } = await world();
    const first = await client.create(ROOT, { idempotencyKey: "seed" });
    const sample = (await service.registryStore.get<CreationRecord>(
      `allocation:${first.id}`,
    ))!;
    for (let i = 1; i < MAX_IDEMPOTENCY_RECORDS; i++) {
      const id = toBase64Url(new Uint8Array(32).fill(i));
      const record = {
        ...sample,
        config: { ...sample.config, id },
        retryKey: `create:fixture-${i}`,
      };
      await service.registryStore.put(`allocation:${id}`, record);
      await service.registryStore.put(record.retryKey, record);
    }
    const before = await service.registryStore.list<CreationRecord>({
      prefix: "allocation:",
    });
    service.restart();
    await expect(
      client.create(ROOT, { idempotencyKey: "new" }),
    ).rejects.toMatchObject({ status: 429, code: "idempotency_capacity" });
    expect(await service.registryStore.list({ prefix: "allocation:" })).toEqual(
      before,
    );
    expect(await client.create(ROOT, { idempotencyKey: "seed" })).toEqual(
      first,
    );
    now += 600;
    service.restart();
    expect((await client.create(ROOT, { idempotencyKey: "new" })).id).not.toBe(
      first.id,
    );
    expect(
      (await service.registryStore.list({ prefix: "allocation:" })).size,
    ).toBe(1);
    expect((await service.registryStore.list({ prefix: "create:" })).size).toBe(
      1,
    );
  });

  it("prunes expired write retries persistently, allows reuse with a new CAS condition, and does not renew successful retries", async () => {
    const { service, client } = await world();
    const { id } = await client.create(ROOT);
    expect(
      (await service.registryStore.list({ prefix: "allocation:" })).size,
    ).toBe(0);
    const first = await client.write(id, ROOT2, {
      ifRevision: "1",
      idempotencyKey: "write",
    });
    now += 599;
    service.restart();
    expect(
      await client.write(id, ROOT2, {
        ifRevision: "1",
        idempotencyKey: "write",
      }),
    ).toEqual(first);
    now += 1;
    service.restart();
    expect(
      await client.write(id, ROOT, {
        ifRevision: "2",
        idempotencyKey: "write",
      }),
    ).toEqual({ root: ROOT, revision: "3", etag: '"3"' });
    expect(
      (
        await service.pointerStores
          .get(`pointer-v2:${id}`)!
          .list({ prefix: "retry:" })
      ).size,
    ).toBe(1);
  });

  it("fails closed at the live write cap without evicting retries and accepts new writes after expiry", async () => {
    const { service, client } = await world();
    const { id } = await client.create(ROOT);
    const original = await client.write(id, ROOT2, {
      ifRevision: "1",
      idempotencyKey: "seed",
    });
    const store = service.pointerStores.get(`pointer-v2:${id}`)!;
    const sample = [
      ...(await store.list<{
        fingerprint: string;
        expiresAt: number;
        result: unknown;
      }>({ prefix: "retry:" })),
    ][0]![1];
    for (let i = 1; i < MAX_IDEMPOTENCY_RECORDS; i++)
      await store.put(`retry:fixture-${i}`, sample);
    const before = await store.list({ prefix: "retry:" });
    service.restart();
    await expect(
      client.write(id, ROOT, { ifRevision: "2", idempotencyKey: "new" }),
    ).rejects.toMatchObject({ status: 429, code: "idempotency_capacity" });
    expect(await store.list({ prefix: "retry:" })).toEqual(before);
    expect(
      await client.write(id, ROOT2, {
        ifRevision: "1",
        idempotencyKey: "seed",
      }),
    ).toEqual(original);
    now += 600;
    service.restart();
    expect(
      (await client.write(id, ROOT, { ifRevision: "2", idempotencyKey: "new" }))
        .revision,
    ).toBe("3");
    expect((await store.list({ prefix: "retry:" })).size).toBe(1);
  });

  it("never expires an ambiguous incomplete configure; recovery keeps its ID even after the normal retry window", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    for (const after of [false, true]) {
      const { service, client } = await world();
      const get = service.env.POINTER.get.bind(service.env.POINTER);
      const failing = vi
        .spyOn(service.env.POINTER, "get")
        .mockImplementation((id) => {
          const pointer = get(id),
            store = service.pointerStores.get(String(id))!;
          store.failBeforeCommit = !after;
          store.failAfterCommit = after;
          return pointer;
        });
      await expect(
        client.create(ROOT, { idempotencyKey: "recover" }),
      ).rejects.toMatchObject({ status: 500 });
      failing.mockRestore();
      const pending = [
        ...(await service.registryStore.list<CreationRecord>({
          prefix: "allocation:",
        })),
      ][0]![1];
      expect(pending.expiresAt).toBeNull();
      for (const store of service.pointerStores.values()) {
        store.failBeforeCommit = false;
        store.failAfterCommit = false;
      }
      now += 1200;
      service.restart();
      expect(await client.create(ROOT, { idempotencyKey: "recover" })).toEqual({
        id: pending.config.id,
      });
      const completed = (await service.registryStore.get<CreationRecord>(
        `allocation:${pending.config.id}`,
      ))!;
      expect(completed.expiresAt).toBe(now + 600);
      expect((await client.read(pending.config.id)).revision).toBe("1");
    }
  });

  it("protects all incomplete slots at capacity, allowing only recovery rather than silently discarding them", async () => {
    const { service, client } = await world();
    const first = await client.create(ROOT, { idempotencyKey: "seed" });
    const sample = (await service.registryStore.get<CreationRecord>(
      `allocation:${first.id}`,
    ))!;
    const pending = { ...sample, expiresAt: null };
    await service.registryStore.put(`allocation:${first.id}`, pending);
    await service.registryStore.put(sample.retryKey, pending);
    for (let i = 1; i < MAX_IDEMPOTENCY_RECORDS; i++) {
      const id = toBase64Url(new Uint8Array(32).fill(i));
      const record = {
        ...pending,
        config: { ...pending.config, id },
        retryKey: `create:pending-${i}`,
      };
      await service.registryStore.put(`allocation:${id}`, record);
      await service.registryStore.put(record.retryKey, record);
    }
    const before = await service.registryStore.list({ prefix: "allocation:" });
    now += 1200;
    service.restart();
    await expect(
      client.create(ROOT, { idempotencyKey: "new" }),
    ).rejects.toMatchObject({ status: 429 });
    expect(await service.registryStore.list({ prefix: "allocation:" })).toEqual(
      before,
    );
    expect(await client.create(ROOT, { idempotencyKey: "seed" })).toEqual(
      first,
    );
    now += 600;
    service.restart();
    expect((await client.create(ROOT, { idempotencyKey: "new" })).id).not.toBe(
      first.id,
    );
    expect(
      (await service.registryStore.list({ prefix: "allocation:" })).size,
    ).toBe(MAX_IDEMPOTENCY_RECORDS);
  });

  it("recovers Registry finalization failures without expiring an unconfirmed completion or renewing a committed one", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    for (const after of [false, true]) {
      const { service, client } = await world();
      const registry = service.env.REGISTRY.get(
        service.env.REGISTRY.idFromName("registry-v2"),
      );
      const complete = registry.complete.bind(registry);
      const failing = vi
        .spyOn(registry, "complete")
        .mockImplementation(async (config) => {
          service.registryStore.failBeforeCommit = !after;
          service.registryStore.failAfterCommit = after;
          try {
            await complete(config);
          } finally {
            service.registryStore.failBeforeCommit = false;
            service.registryStore.failAfterCommit = false;
          }
        });
      await expect(
        client.create(ROOT, { idempotencyKey: "finalize" }),
      ).rejects.toMatchObject({ status: 500 });
      failing.mockRestore();
      const record = [
        ...(await service.registryStore.list<CreationRecord>({
          prefix: "allocation:",
        })),
      ][0]![1];
      const originalExpiry = record.expiresAt;
      if (after) expect(originalExpiry).toBe(now + 600);
      else expect(originalExpiry).toBeNull();
      now += after ? 599 : 1200;
      service.restart();
      expect(await client.create(ROOT, { idempotencyKey: "finalize" })).toEqual(
        { id: record.config.id },
      );
      expect(
        (await service.registryStore.get<CreationRecord>(
          `allocation:${record.config.id}`,
        ))!.expiresAt,
      ).toBe(after ? originalExpiry : now + 600);
    }
  });

  it("adopts provisional v2 retries conservatively instead of leaving old successful records immortal", async () => {
    const { service, client } = await world();
    const first = await client.create(ROOT, { idempotencyKey: "old-create" });
    const allocation = `allocation:${first.id}`;
    const sample =
      (await service.registryStore.get<CreationRecord>(allocation))!;
    await service.registryStore.put(allocation, sample.config);
    await service.registryStore.put(sample.retryKey, {
      fingerprint: sample.fingerprint,
      config: sample.config,
    });
    expect(await client.create(ROOT, { idempotencyKey: "old-create" })).toEqual(
      first,
    );
    expect(
      (await service.registryStore.get<CreationRecord>(allocation))!.expiresAt,
    ).toBe(now + 600);
    const write = await client.write(first.id, ROOT2, {
      ifRevision: "1",
      idempotencyKey: "old-write",
    });
    const store = service.pointerStores.get(`pointer-v2:${first.id}`)!;
    const [key, retry] = [
      ...(await store.list<{ fingerprint: string; result: unknown }>({
        prefix: "retry:",
      })),
    ][0]!;
    await store.put(key, {
      fingerprint: retry.fingerprint,
      result: retry.result,
    });
    service.restart();
    expect(
      await client.write(first.id, ROOT2, {
        ifRevision: "1",
        idempotencyKey: "old-write",
      }),
    ).toEqual(write);
    now += 600;
    service.restart();
    expect(
      (await client.create(ROOT, { idempotencyKey: "old-create" })).id,
    ).not.toBe(first.id);
    expect(
      (
        await client.write(first.id, ROOT, {
          ifRevision: "2",
          idempotencyKey: "old-write",
        })
      ).revision,
    ).toBe("3");
  });
});
