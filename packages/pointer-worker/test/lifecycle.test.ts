import { describe, expect, it } from "vitest";
import { uniqueId } from "@ipab/bundle/pointer/scope";
import { scopeWorld } from "./helpers.ts";

describe(
  "Scope atomic lifecycle and durable retries",
  { tags: ["mock"] },
  () => {
    it("linearizes freeze and write and preserves every last confirmed write", async () => {
      for (let i = 0; i < 12; i++) {
        const w = await scopeWorld();
        const write = w.memberClient.write(
          w.scope.id,
          w.variable.id,
          { final: i },
          w.variable.cid,
          uniqueId(),
        );
        const freeze = w.client.freeze(w.scope.id, w.variable.id, uniqueId());
        const [written, frozen] = await Promise.allSettled([write, freeze]);
        expect(frozen.status).toBe("fulfilled");
        const final = await w.reader.read(w.scope.id, w.variable.id);
        expect(final.status).toBe("frozen");
        if (written.status === "fulfilled")
          expect(final.cid).toBe(written.value.cid);
        else expect(written.reason).toMatchObject({ status: 423 });
        await expect(
          w.client.write(w.scope.id, w.variable.id, {}, final.cid, uniqueId()),
        ).rejects.toMatchObject({ status: 423 });
      }
    });
    it("recovers ambiguous write/create/freeze/delete commits after object eviction with the same operation", async () => {
      const w = await scopeWorld(),
        storage = w.service.stores.get(`scope:${w.scope.id}`)!;
      const key = uniqueId();
      storage.failAfterCommit = true;
      await expect(
        w.client.write(
          w.scope.id,
          w.variable.id,
          { root: "B" },
          w.variable.cid,
          key,
        ),
      ).rejects.toMatchObject({ status: 500 });
      storage.failAfterCommit = false;
      w.service.restart();
      expect(
        (
          await w.client.write(
            w.scope.id,
            w.variable.id,
            { root: "B" },
            w.variable.cid,
            key,
          )
        ).value,
      ).toEqual({ root: "B" });
      const allocation = uniqueId();
      storage.failAfterCommit = true;
      await expect(
        w.client.create(w.scope.id, {}, allocation),
      ).rejects.toMatchObject({ status: 500 });
      storage.failAfterCommit = false;
      w.service.restart();
      const created = await w.client.create(w.scope.id, {}, allocation);
      expect(await w.client.create(w.scope.id, {}, allocation)).toEqual(
        created,
      );
      const freeze = uniqueId();
      await w.client.freeze(w.scope.id, created.id, freeze);
      w.service.restart();
      expect(
        (await w.client.freeze(w.scope.id, created.id, freeze)).status,
      ).toBe("frozen");
      const deletion = uniqueId();
      await w.client.delete(w.scope.id, created.id, deletion);
      w.service.restart();
      expect(
        (await w.client.delete(w.scope.id, created.id, deletion)).status,
      ).toBe("deleted");
    });
    it("persists allocation retry identity forever and does not allocate a replacement after failure", async () => {
      const w = await scopeWorld(),
        key = uniqueId();
      const first = await w.client.createScope(key);
      w.service.restart();
      expect(await w.client.createScope(key)).toEqual(first);
    });
  },
);
