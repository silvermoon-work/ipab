import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test, vi } from "vitest";
import { importer } from "ipfs-unixfs-importer";
import { fixedSize } from "ipfs-unixfs-importer/chunker";
import { exporter } from "ipfs-unixfs-exporter";
import { CID } from "multiformats/cid";
import { acquireBlock, contentLinks, ContentBlocks } from "../src/dag.js";
import * as dagCbor from "@ipld/dag-cbor";
import { sha256 } from "multiformats/hashes/sha2";

test(
  "DAG inspection rejects unsupported codecs, noncanonical maps and exceeded structure budgets",
  { tags: ["unit"] },
  async () => {
    const bytes = dagCbor.encode({ nested: [[1]] });
    const cid = CID.createV1(dagCbor.code, await sha256.digest(bytes));
    for (const limits of [
      { nodes: -1 },
      { depth: -1 },
      { nodes: 1 },
      { depth: 0 },
    ]) {
      assert.throws(() => contentLinks(cid, bytes, limits), /capacity|limit/);
    }
    assert.throws(
      () => contentLinks(CID.createV1(0x72, cid.multihash), bytes),
      /Unsupported/,
    );
    const noncanonical = Uint8Array.of(0xa2, 0x61, 0x62, 1, 0x61, 0x61, 2);
    const noncanonicalCid = CID.createV1(
      dagCbor.code,
      await sha256.digest(noncanonical),
    );
    assert.throws(() => contentLinks(noncanonicalCid, noncanonical));
    for (const timeoutMs of [-1, Infinity, 4_294_967_296]) {
      await assert.rejects(
        acquireBlock(new ContentBlocks(), cid, { timeoutMs }),
        /timeout/,
      );
    }
  },
);

test(
  "nondefault UnixFS file chunks and directory metadata survive a fresh-store transfer",
  { tags: ["mock"] },
  async () => {
    const original = new ContentBlocks();
    const payload = Uint8Array.from({ length: 10_001 }, (_, i) => i % 251);
    let imported: CID | undefined;
    for await (const entry of importer(
      [
        {
          path: "model.bin",
          content: payload,
          mode: 0o640,
          mtime: { secs: 123n, nsecs: 456 },
        },
        {
          path: "nested/notes.txt",
          content: Buffer.from("original\r\nbytes\r\n"),
        },
      ],
      original,
      {
        wrapWithDirectory: true,
        cidVersion: 1,
        rawLeaves: false,
        chunker: fixedSize({ chunkSize: 777 }),
      },
    ))
      imported = entry.cid;
    assert.ok(imported);
    const restored = new ContentBlocks();
    // Transfer only reachable blocks into a new store with no source or original cache.
    const reachable = new ContentBlocks(original);
    await reachable.prepare(imported);
    for (const [cid, bytes] of reachable.blocks)
      await restored.put(CID.parse(cid), bytes);
    const file = await exporter(`${imported.toString()}/model.bin`, restored);
    assert.equal(file.type, "file");
    {
      assert.equal(file.unixfs.mode, 0o640);
      assert.deepEqual(file.unixfs.mtime, { secs: 123n, nsecs: 456 });
      const parts: Uint8Array[] = [];
      for await (const part of file.content()) parts.push(part);
      assert.deepEqual(Buffer.concat(parts), Buffer.from(payload));
    }
    const bad = new ContentBlocks();
    await assert.rejects(
      bad.put(imported, Buffer.from("corrupt")),
      /verification/,
    );
    const missing = new ContentBlocks();
    await missing.put(imported, await restored.block.get(imported.toString()));
    await assert.rejects(missing.prepare(imported), /Missing local content/);
    const limited = new ContentBlocks(restored, { blocks: 1 });
    await assert.rejects(limited.prepare(imported), /capacity/);
  },
);

test(
  "acquisition timeout keeps an idle event loop alive and aborts an uncooperative source",
  { tags: ["release-e2e"] },
  () => {
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `
        import assert from "node:assert/strict";
        import { CID } from "multiformats/cid";
        import { acquireBlock } from ${JSON.stringify(new URL("../dist/dag.js", import.meta.url).href)};
        const cid = CID.parse("bafkreigh2akiscaildcjlywwfme6ngynt5kwhr6bpcf3r7nnbyurphdisi");
        let sourceSignal;
        const source = { block: { get: async (_, { signal }) => {
          sourceSignal = signal;
          return new Promise(() => {});
        } } };
        await assert.rejects(acquireBlock(source, cid, { timeoutMs: 10 }), { name: "TimeoutError" });
        assert.equal(sourceSignal.aborted, true);
        assert.equal(sourceSignal.reason.name, "TimeoutError");
        console.log("deadline observed");
      `,
      ],
      {
        encoding: "utf8",
        timeout: 10_000,
        cwd: new URL("..", import.meta.url),
      },
    );
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /deadline observed/);
  },
);

test(
  "injected uncooperative content ports cannot defeat cancellation",
  { tags: ["mock"] },
  async () => {
    const cid = CID.parse(
      "bafkreigh2akiscaildcjlywwfme6ngynt5kwhr6bpcf3r7nnbyurphdisi",
    );
    const controller = new AbortController();
    const reason = new Error("stop acquisition");
    let sourceSignal: AbortSignal | undefined;
    const source = {
      block: {
        get: async (
          _cid: string,
          { signal }: { signal?: AbortSignal } = {},
        ) => {
          sourceSignal = signal;
          controller.abort(reason);
          return new Promise<Uint8Array>(() => {});
        },
      },
    };
    await assert.rejects(
      acquireBlock(source, cid, { signal: controller.signal }),
      (error) => error === reason,
    );
    assert.equal(sourceSignal?.aborted, true);
    assert.equal(sourceSignal.reason, reason);
    await assert.rejects(
      acquireBlock(
        {
          block: {
            get: () => Promise.reject(new Error("source called after abort")),
          },
        },
        cid,
        {
          signal: controller.signal,
        },
      ),
      (error) => error === reason,
    );
  },
);

test(
  "in-flight acquisition preserves Error reasons and reports non-Error cancellation causes",
  { tags: ["mock"] },
  async () => {
    const cid = CID.parse(
      "bafkreigh2akiscaildcjlywwfme6ngynt5kwhr6bpcf3r7nnbyurphdisi",
    );
    for (const reason of [new Error("caller cancelled"), "caller cancelled"]) {
      const controller = new AbortController();
      const source = {
        block: {
          get: () =>
            new Promise<Uint8Array>(() => {
              controller.abort(reason);
            }),
        },
      };
      await assert.rejects(
        acquireBlock(source, cid, { signal: controller.signal }),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          if (typeof reason === "string") assert.equal(error.cause, reason);
          else assert.equal(error, reason);
          return true;
        },
      );
    }
  },
);

test(
  "acquisition clears its deadline after success or source failure",
  { tags: ["mock"] },
  async (t) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    t.onTestFinished(() => {
      vi.useRealTimers();
    });
    const original = new ContentBlocks();
    let cid: CID | undefined;
    for await (const entry of importer(
      [{ content: Buffer.from("verified") }],
      original,
    ))
      cid = entry.cid;
    assert.ok(cid);
    for (const fail of [false, true]) {
      const reason = new Error("source failed");
      let sourceSignal: AbortSignal | undefined;
      const source = {
        block: {
          get: async (
            value: string,
            { signal }: { signal?: AbortSignal } = {},
          ) => {
            sourceSignal = signal;
            if (fail) throw reason;
            return original.block.get(value);
          },
        },
      };
      const acquired = acquireBlock(source, cid, { timeoutMs: 10 });
      if (fail) await assert.rejects(acquired, (error) => error === reason);
      else
        assert.deepEqual(
          await acquired,
          await original.block.get(cid.toString()),
        );
      vi.advanceTimersByTime(10);
      assert.equal(
        sourceSignal?.aborted,
        false,
        "settled acquisition retained its deadline",
      );
    }
  },
);
