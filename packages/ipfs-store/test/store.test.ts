import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { test, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { importer } from "ipfs-unixfs-importer";
import { fixedSize } from "ipfs-unixfs-importer/chunker";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import { encodeDagCbor } from "@silvermoon-work/ipfs-payload/dag-cbor";
import { ContentBlocks } from "../src/dag.js";
import { IpfsStore } from "../src/index.js";
import { Retention } from "../src/retention.js";

async function bytes(store: IpfsStore, cid: string, signal?: AbortSignal) {
  const node = await store.read(cid, signal ? { signal } : {});
  assert.ok(node.type === "file" || node.type === "raw");
  const parts: Uint8Array[] = [];
  for await (const part of node.content(signal ? { signal } : {}))
    parts.push(part);
  return Buffer.concat(parts);
}

test("usage counts mixed recursive pin closures once and GC collects only unprotected block bytes", async (t) => {
  const directory = resolve(".cache", `usage-${randomUUID()}`);
  const graph = new ContentBlocks();
  let root!: CID;
  for await (const entry of importer(
    [{ path: "nested/file", content: Buffer.alloc(1001, 42) }],
    graph,
    {
      cidVersion: 1,
      rawLeaves: true,
      wrapWithDirectory: true,
      chunker: fixedSize({ chunkSize: 100 }),
    },
  ))
    root = entry.cid;
  const parentBytes = encodeDagCbor({ first: root, repeated: root });
  const parent = CID.createV1(0x71, await sha256.digest(parentBytes));
  await graph.put(parent, parentBytes);
  const pinnedBytes = [...graph.blocks.values()].reduce(
    (sum, block) => sum + block.byteLength,
    0,
  );
  const orphan = Buffer.from("unprotected cache");
  const orphanCid = CID.createV1(0x55, await sha256.digest(orphan));
  const store = new IpfsStore({ dataDir: directory });
  const reopened = new IpfsStore({ dataDir: directory });
  const scope = reopened.scope();
  t.onTestFinished(async () => {
    await scope.close();
    await reopened.close();
    await store.close();
    await graph.close();
    await rm(directory, { recursive: true, force: true });
  });
  for (const [cid, block] of graph.blocks)
    await store.put(CID.parse(cid), block);
  await store.put(orphanCid, orphan);
  await store.pin(parent);
  await store.pin(root);
  await store.pin(root.toV0());
  await writeFile(join(directory, "blocks", ".pending-foreign"), "temporary");
  await writeFile(join(directory, "blocks", "custom-note"), "custom");
  assert.deepEqual(await store.usage(), {
    cachedBytes: pinnedBytes + orphan.length,
    pinnedBytes,
  });
  await store.close();
  assert.deepEqual(await scope.gc(), {
    removedBlocks: 1,
    reclaimedBytes: orphan.length,
  });
  assert.deepEqual(await reopened.usage(), {
    cachedBytes: pinnedBytes,
    pinnedBytes,
  });
  await assert.rejects(
    readFile(join(directory, "blocks", orphanCid.toString())),
    { code: "ENOENT" },
  );
  assert.equal(
    await readFile(join(directory, "blocks", ".pending-foreign"), "utf8"),
    "temporary",
  );
  await reopened.prepare(parent);
  await reopened.unpin(parent);
  assert.deepEqual(await reopened.gc(), {
    removedBlocks: 1,
    reclaimedBytes: parentBytes.length,
  });
  await reopened.unpin(root);
  const remaining = pinnedBytes - parentBytes.length;
  assert.deepEqual(await reopened.gc(), {
    removedBlocks: graph.blocks.size - 1,
    reclaimedBytes: remaining,
  });
  assert.deepEqual(await reopened.usage(), { cachedBytes: 0, pinnedBytes: 0 });
});

test("GC protects owner references, unfinished pins and incomplete imports without treating staged parents as complete DAGs", async (t) => {
  const directory = resolve(".cache", `gc-references-${randomUUID()}`);
  const store = new IpfsStore({ dataDir: directory });
  t.onTestFinished(async () => {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const ownerBytes = Buffer.from("owner");
  const owner = CID.createV1(0x55, await sha256.digest(ownerBytes));
  const childBytes = Buffer.from("late child");
  const child = CID.createV1(0x55, await sha256.digest(childBytes));
  const parentBytes = encodeDagCbor({ child });
  const parent = CID.createV1(0x71, await sha256.digest(parentBytes));
  await store.put(owner, ownerBytes);
  store.registerOwner("other-participant", [owner.toString()]);
  await store.stageBlock("import", parent, parentBytes);
  assert.deepEqual(await store.gc(), { removedBlocks: 0, reclaimedBytes: 0 });
  assert.deepEqual(await store.usage(), {
    cachedBytes: ownerBytes.length + parentBytes.length,
    pinnedBytes: 0,
  });
  await store.discardImport("import");
  assert.deepEqual(await store.gc(), {
    removedBlocks: 1,
    reclaimedBytes: parentBytes.length,
  });
  await store.stageBlock("retry", parent, parentBytes);
  await assert.rejects(store.retain("pending-owner", [parent.toString()]));
  await assert.rejects(store.gc(), { code: "retention_unfinished" });
  assert.deepEqual(
    await readFile(join(directory, "blocks", owner.toString())),
    ownerBytes,
  );
  await store.stageBlock("retry", child, childBytes);
  await store.finishImport("retry", parent, "pending-owner");
  await store.confirmRetained("pending-owner", [parent.toString()]);
  assert.deepEqual(await store.gc(), { removedBlocks: 0, reclaimedBytes: 0 });
  await store.recoverOwner("pending-owner", []);
  await store.reconcile("pending-owner", []);
  assert.deepEqual(await store.gc(), {
    removedBlocks: 2,
    reclaimedBytes: parentBytes.length + childBytes.length,
  });
  assert.deepEqual(await store.usage(), {
    cachedBytes: ownerBytes.length,
    pinnedBytes: ownerBytes.length,
  });
});

test("maintenance verifies fresh local blocks and never fetches a missing protected DAG or deletes before marking succeeds", async (t) => {
  const directory = resolve(".cache", `gc-invalid-${randomUUID()}`);
  let fetches = 0;
  const base = new IpfsStore({ dataDir: directory });
  const store = base.withLocalSource({
    block: {
      get: () => {
        fetches++;
        return Promise.reject(new Error("unexpected fetch"));
      },
    },
  });
  t.onTestFinished(async () => {
    await store.close();
    await base.close();
    await rm(directory, { recursive: true, force: true });
  });
  const block = Buffer.from("protected");
  const cid = CID.createV1(0x55, await sha256.digest(block));
  const orphan = Buffer.from("orphan");
  const orphanCid = CID.createV1(0x55, await sha256.digest(orphan));
  await store.put(cid, block);
  await store.put(orphanCid, orphan);
  await store.pin(cid);
  await store.block.get(cid.toString());
  const path = join(directory, "blocks", cid.toString());
  await writeFile(path, "corrupt");
  for (const operation of [() => store.usage(), () => store.gc()])
    await assert.rejects(operation(), { code: "retention_unfinished" });
  await rm(path);
  for (const operation of [() => store.usage(), () => store.gc()])
    await assert.rejects(operation(), { code: "retention_unfinished" });
  assert.equal(fetches, 0);
  assert.deepEqual(
    await readFile(join(directory, "blocks", orphanCid.toString())),
    orphan,
  );
});

test("GC serializes with another local participant's in-flight retain", async (t) => {
  const directory = resolve(".cache", `gc-lock-${randomUUID()}`);
  const block = Buffer.from("concurrent retain");
  const cid = CID.createV1(0x55, await sha256.digest(block));
  let started!: () => void;
  const fetching = new Promise<void>((resolve) => {
    started = resolve;
  });
  let finish!: (bytes: Uint8Array) => void;
  const source = new Promise<Uint8Array>((resolve) => {
    finish = resolve;
  });
  const base = new IpfsStore({ dataDir: directory });
  const writer = base.withLocalSource({
    block: {
      get: () => {
        started();
        return source;
      },
    },
  });
  const collector = new IpfsStore({ dataDir: directory });
  t.onTestFinished(async () => {
    finish(block);
    await writer.close();
    await collector.close();
    await base.close();
    await rm(directory, { recursive: true, force: true });
  });
  const retaining = writer.retain("concurrent-owner", [cid.toString()]);
  await fetching;
  const collecting = collector.gc();
  finish(block);
  await retaining;
  assert.deepEqual(await collecting, { removedBlocks: 0, reclaimedBytes: 0 });
  await collector.prepare(cid);
});

test("local retention recovery preserves active owners and removes only abandoned imports before GC", async (t) => {
  const directory = resolve(".cache", `local-recovery-${randomUUID()}`);
  const store = new IpfsStore({ dataDir: directory });
  t.onTestFinished(async () => {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const bytes = Buffer.from("owner block");
  const cid = CID.createV1(0x55, await sha256.digest(bytes));
  await store.put(cid, bytes);
  await store.retain("owner", [cid.toString()]);
  await store.retain("owner", [cid.toString()]);
  await store.confirmRetained("owner", [cid.toString()]);
  await store.confirmRetained("owner", [cid.toString()]);
  await assert.rejects(store.unpin(cid), { code: "retention_unfinished" });
  await store.stageBlock("owner/abandoned", cid, bytes);
  await store.recoverOwner("owner", () => [], { isIdle: () => false });
  assert.deepEqual(await store.gc(), { removedBlocks: 0, reclaimedBytes: 0 });
  await store.recoverOwner("owner", () => [], { isIdle: () => true });
  await store.reconcile("owner", () => []);
  assert.deepEqual(await store.gc(), {
    removedBlocks: 1,
    reclaimedBytes: bytes.length,
  });
  await store.unpin(cid);
  for (const owner of ["", "x".repeat(4097)])
    assert.throws(() => {
      store.registerOwner(owner, []);
    }, /stable retention owner/);

  await store.put(cid, bytes);
  store.registerOwner("corrupt", [cid.toString()]);
  const db = new DatabaseSync(join(directory, "retention", "retention.sqlite"));
  try {
    db.prepare("UPDATE owners SET roots=? WHERE id=?").run(
      '["valid",1]',
      "corrupt",
    );
    await assert.rejects(store.gc(), /unfinished/);
    assert.deepEqual(
      await readFile(join(directory, "blocks", cid.toString())),
      bytes,
    );
  } finally {
    db.close();
  }
});

test("local coordination reports lock deadlines and canceled acquisition without successful pin results", async (t) => {
  const directory = resolve(".cache", `local-lock-${randomUUID()}`);
  const cid = CID.createV1(
    0x55,
    await sha256.digest(Buffer.from("block")),
  ).toString();
  let failure: Error | undefined;
  let cancel: AbortController | undefined;
  const coordinator = new Retention(directory, {
    prepare: () => {
      cancel?.abort(new Error("cancel pin acquisition"));
      return failure ? Promise.reject(failure) : Promise.resolve();
    },
  });
  let closed = false;
  const mutex = new DatabaseSync(join(directory, "mutex.sqlite"));
  t.onTestFinished(async () => {
    vi.restoreAllMocks();
    mutex.close();
    if (!closed) await coordinator.close();
    await rm(directory, { recursive: true, force: true });
  });
  mutex.exec("BEGIN IMMEDIATE");
  assert.throws(() => {
    coordinator.register("owner", []);
  }, /coordination is unavailable/);
  const clock = vi
    .spyOn(Date, "now")
    .mockReturnValueOnce(0)
    .mockReturnValue(30_001);
  await assert.rejects(coordinator.pin(cid), /coordination is unavailable/);
  clock.mockRestore();
  mutex.exec("ROLLBACK");
  failure = new DOMException("upstream timed out", "TimeoutError");
  await assert.rejects(coordinator.pin(cid), /TimeoutError/);
  assert.deepEqual(coordinator.pins(), []);
  cancel = new AbortController();
  failure = new Error("acquisition interrupted");
  await assert.rejects(
    coordinator.pin(cid, cancel.signal),
    /cancel pin acquisition/,
  );
  cancel = undefined;
  failure = undefined;
  await coordinator.pin(cid);
  assert.deepEqual(coordinator.pins(), [cid]);
  await coordinator.close();
  closed = true;
  assert.throws(() => {
    coordinator.register("owner", []);
  }, /coordination is unavailable/);
  await assert.rejects(coordinator.pin(cid), /coordination is unavailable/);
});

test("maintenance rejects unsupported stores, cancellation and invalid block directory entries", async (t) => {
  const directory = resolve(".cache", `gc-boundaries-${randomUUID()}`);
  const store = new IpfsStore({ dataDir: directory });
  const adapter = IpfsStore.fromClient({
    block: { get: () => Promise.resolve(new Uint8Array()) },
  });
  t.onTestFinished(async () => {
    await store.close();
    await adapter.close();
    await rm(directory, { recursive: true, force: true });
  });
  assert.deepEqual(await store.usage(), { cachedBytes: 0, pinnedBytes: 0 });
  assert.deepEqual(await store.gc(), { removedBlocks: 0, reclaimedBytes: 0 });
  for (const unsupported of [adapter]) {
    await assert.rejects(unsupported.usage(), { code: "unsupported_content" });
    await assert.rejects(unsupported.gc(), { code: "unsupported_content" });
  }
  const controller = new AbortController();
  controller.abort(new Error("stop maintenance"));
  await assert.rejects(
    store.gc({ signal: controller.signal }),
    /stop maintenance/,
  );
  await writeFile(join(directory, "blocks"), "not a directory");
  await assert.rejects(store.usage(), { code: "retention_unfinished" });
  await rm(join(directory, "blocks"));
  const cid = CID.createV1(0x55, await sha256.digest(Buffer.from("directory")));
  await mkdir(join(directory, "blocks", cid.toString()), { recursive: true });
  await assert.rejects(store.gc(), { code: "retention_unfinished" });
});

test("local source overrides share scoped retention, validate ranges and keep borrowed ports open", async (t) => {
  const directory = resolve(".cache", `scoped-source-${randomUUID()}`);
  const source = new ContentBlocks();
  const payload = Buffer.from("scoped source");
  const cid = CID.createV1(0x55, await sha256.digest(payload));
  await source.put(cid, payload);
  const parent = new IpfsStore({ dataDir: directory });
  const reader = parent.withLocalSource(source);
  const scope = reader.scope();
  const adapter = IpfsStore.fromClient(source);
  t.onTestFinished(async () => {
    await scope.close();
    await reader.close();
    await parent.close();
    await adapter.close();
    await source.close();
    await rm(directory, { recursive: true, force: true });
  });
  assert.deepEqual(await bytes(scope, cid.toString()), payload);
  await scope.retain("scoped-owner", [cid.toString()]);
  await scope.confirmRetained("scoped-owner", [cid.toString()]);
  assert.equal(await scope.reconcile("scoped-owner", []), 1);
  const file = await scope.read(cid);
  assert.ok(file.type === "file" || file.type === "raw");
  for (const options of [
    { offset: -1 },
    { length: -1 },
    { offset: 0.5 },
    { length: 100 },
  ]) {
    await assert.rejects(async () => {
      for await (const chunk of file.content(options))
        assert.fail(`Invalid range produced ${chunk.length} bytes.`);
    }, /range/);
  }
  const access = await scope.readContent(cid);
  assert.ok(access.kind === "file");
  await access.content.cancel();
  assert.throws(() => adapter.withLocalSource(source), { code: "read_only" });
  for (const value of [null, {}, { block: {} }, { block: { get: 1 } }]) {
    assert.throws(() => IpfsStore.fromClient(value as never), /block port/);
  }
  await reader.close();
  assert.deepEqual(
    Buffer.from(await source.block.get(cid.toString())),
    payload,
  );
});

test("cold verified UnixFS nodes stream files, traverse generic names, cache originals and then stay offline", async (t) => {
  const directory = resolve(".cache", `store-${randomUUID()}`);
  const graph = new ContentBlocks();
  const payload = Buffer.alloc(20_001, 123);
  let root = "";
  for await (const node of importer(
    [{ path: "CON", content: payload, mode: 0o640, mtime: { secs: 123n } }],
    graph,
    {
      wrapWithDirectory: true,
      cidVersion: 1,
      rawLeaves: false,
      chunker: fixedSize({ chunkSize: 777 }),
    },
  ))
    root = node.cid.toString();
  let calls = 0;
  let corrupt = false;
  const server = createServer((request, response) => {
    calls++;
    const cid = new URL(request.url!, "http://localhost").pathname
      .split("/")
      .at(-1)!;
    const block = graph.blocks.get(cid);
    response
      .writeHead(block ? 200 : 404)
      .end(corrupt ? Buffer.from("corrupt") : block);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const gateway = `http://127.0.0.1:${address.port}/gateway`;
  const store = new IpfsStore({ dataDir: directory, gateway });
  t.onTestFinished(async () => {
    await store.close();
    server.closeAllConnections();
    await new Promise<void>((done) =>
      server.close(() => {
        done();
      }),
    );
    await rm(directory, { recursive: true, force: true });
  });
  await store.prepare(root);
  assert.equal(calls, graph.blocks.size, "One acquisition per unique CID.");
  const node = await store.read(root);
  assert.equal(node.type, "directory");
  const entries = [];
  for await (const entry of node.entries()) entries.push(entry);
  assert.deepEqual(
    entries.map((entry) => entry.name),
    ["CON"],
    "No task portable-path policy.",
  );
  const canceledDirectory = new AbortController();
  canceledDirectory.abort(new Error("stop directory reader"));
  await assert.rejects(
    node.entries({ signal: canceledDirectory.signal }).next(),
    /stop directory reader/,
  );
  assert.deepEqual(await bytes(store, `${root}/CON`), payload);
  for (const [cid, block] of graph.blocks)
    assert.deepEqual(
      await readFile(join(directory, "blocks", cid)),
      Buffer.from(block),
    );
  const warmed = calls;
  await store.pin(root);
  const pinnedBytes = [...graph.blocks.values()].reduce(
    (sum, block) => sum + block.byteLength,
    0,
  );
  assert.deepEqual(await store.usage(), {
    cachedBytes: pinnedBytes,
    pinnedBytes,
  });
  assert.deepEqual(await store.gc(), { removedBlocks: 0, reclaimedBytes: 0 });
  assert.equal(
    calls,
    warmed,
    "Local pin, usage and GC never contact the upstream.",
  );
  corrupt = true;
  const independent = new IpfsStore({ dataDir: directory, gateway });
  try {
    await independent.prepare(root);
    assert.deepEqual(await bytes(independent, `${root}/CON`), payload);
    assert.equal(
      calls,
      warmed,
      "Local disk hits never contact a configured gateway.",
    );
  } finally {
    await independent.close();
  }
  const badBytes = Buffer.from("not published");
  const missing = CID.createV1(0x55, await sha256.digest(badBytes));
  await graph.put(missing, badBytes);
  await assert.rejects(store.block.get(missing.toString()), /verification/);
  assert.equal(
    (await readdir(join(directory, "blocks"))).includes(missing.toString()),
    false,
  );
  const local = new IpfsStore({ dataDir: directory });
  try {
    await local.prepare(root);
    await assert.rejects(local.read(missing), /Missing local content block/);
    assert.equal(calls, warmed + 1);
  } finally {
    await local.close();
  }
});

test("canceling a file stream does not interrupt another stream of its shared chunk", async () => {
  const graph = new ContentBlocks();
  const payload = Buffer.alloc(600_001, 123);
  let root = "";
  for await (const entry of importer([{ content: payload }], graph, {
    cidVersion: 1,
    rawLeaves: true,
  }))
    root = entry.cid.toString();
  const chunk = [...graph.blocks.keys()].find(
    (cid) => CID.parse(cid).code === 0x55,
  )!;
  let release = () => {},
    began = () => {};
  const started = new Promise<void>((done) => {
    began = done;
  });
  const source = {
    block: {
      get: async (cid: string) => {
        if (cid === chunk) {
          began();
          await new Promise<void>((done) => {
            release = done;
          });
        }
        return graph.block.get(cid);
      },
    },
  };
  const store = IpfsStore.fromClient(source);
  const canceled = new AbortController();
  const first = assert.rejects(
    bytes(store, root, canceled.signal),
    /stop file reader/,
  );
  const second = bytes(store, root);
  try {
    await started;
    canceled.abort(new Error("stop file reader"));
    await first;
    release();
    assert.deepEqual(await second, payload);
    assert.deepEqual(await bytes(store, root), payload);
  } finally {
    release();
    await store.close();
  }
});

test("store close cancels even an uncooperative source without owning its close", async () => {
  const cid = CID.createV1(0x55, await sha256.digest(Buffer.from("absent")));
  let began = () => {};
  const started = new Promise<void>((done) => {
    began = done;
  });
  let closed = 0;
  const source = {
    block: {
      get: async () => {
        began();
        return new Promise<Uint8Array>(() => {});
      },
    },
    close() {
      closed++;
      return Promise.resolve();
    },
  };
  const store = IpfsStore.fromClient(source);
  const reading = assert.rejects(store.read(cid), /closed/);
  await started;
  await Promise.all([store.close(), store.close(), reading]);
  assert.equal(closed, 0);
});

test("concurrent close waits for owned publications and preserves previously shared blocks", async () => {
  const directory = resolve(".cache", `store-close-${randomUUID()}`);
  const store = new IpfsStore({ dataDir: directory });
  const original = Buffer.from("published before closing");
  const cid = CID.createV1(0x55, await sha256.digest(original));
  try {
    await store.put(cid, original);
    const data = Buffer.alloc(100_001, 123);
    const next = CID.createV1(0x55, await sha256.digest(data));
    const pending = store.put(next, data).then(
      () => undefined,
      (error: unknown) => error,
    );
    const a = store.close(),
      b = store.close();
    assert.equal(a, b);
    await Promise.all([a, b, pending]);
    assert.ok(
      (await readdir(join(directory, "blocks"))).every(
        (name) => !name.startsWith(".pending"),
      ),
    );
    const other = new IpfsStore({ dataDir: directory });
    try {
      assert.deepEqual(await bytes(other, cid.toString()), original);
    } finally {
      await other.close();
    }
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("reader cancellation and scope close do not own shared acquisition or caller resources", async () => {
  const payload = Buffer.from("one immutable node");
  const cid = CID.createV1(0x55, await sha256.digest(payload));
  let calls = 0,
    closed = 0;
  let release = () => {};
  const source = {
    block: {
      get: async () => {
        calls++;
        await new Promise<void>((done) => {
          release = done;
        });
        return payload;
      },
    },
    close() {
      closed++;
      return Promise.resolve();
    },
  };
  const store = IpfsStore.fromClient(source);
  const first = store.scope(),
    second = store.scope();
  const controller = new AbortController();
  const canceled = assert.rejects(
    bytes(first, cid.toString(), controller.signal),
    /reader canceled/,
  );
  const survivor = bytes(second, cid.toString());
  try {
    const deadline = Date.now() + 2000;
    while (!calls) {
      assert.ok(Date.now() < deadline);
      await new Promise((done) => setTimeout(done, 5));
    }
    controller.abort(new Error("reader canceled"));
    await canceled;
    await first.close();
    release();
    assert.deepEqual(await survivor, payload);
    assert.equal(calls, 1);
    const a = store.close(),
      b = store.close();
    assert.equal(a, b);
    await Promise.all([a, b, second.close()]);
    assert.equal(closed, 0, "Injected sources remain caller-owned.");
    await assert.rejects(store.read(cid), /closed/);
  } finally {
    release();
    await Promise.all([first.close(), second.close(), store.close()]);
  }
});

test("reader budgets account unique blocks, while a narrower full-prepare budget fails explicitly", async () => {
  const graph = new ContentBlocks();
  let root = "";
  for await (const entry of importer(
    [
      { path: "a", content: Buffer.from("shared") },
      { path: "b", content: Buffer.from("shared") },
    ],
    graph,
    { cidVersion: 1, rawLeaves: true, wrapWithDirectory: true },
  ))
    root = entry.cid.toString();
  const store = IpfsStore.fromClient(graph);
  try {
    await store.prepare(root);
    assert.equal(store.retainedBytes, graph.retainedBytes);
    await store.prepare(root);
    assert.equal(store.retainedBytes, graph.retainedBytes);
    const limited = store.scope({ blocks: 1 });
    try {
      await assert.rejects(limited.prepare(root), /capacity/);
    } finally {
      await limited.close();
    }
    assert.deepEqual(await bytes(store, `${root}/a`), Buffer.from("shared"));
  } finally {
    await store.close();
  }
});

test("structured block preparation does not expand the file/directory resource profile", async () => {
  const directory = resolve(".cache", `store-codec-${randomUUID()}`);
  const store = new IpfsStore({ dataDir: directory });
  const bytes = Uint8Array.of(0xa0);
  const cid = CID.createV1(0x71, await sha256.digest(bytes));
  try {
    await store.put(cid, bytes);
    assert.deepEqual(await store.block.get(cid.toString()), bytes);
    await store.prepare(cid);
    await assert.rejects(store.read(cid), /regular UnixFS files/);
    await assert.rejects(store.readContent(cid), /regular UnixFS files/);
    await assert.rejects(store.resolveContent(cid, ""), /regular UnixFS files/);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("builtin local store is not a public distribution endpoint", async () => {
  const directory = resolve(".cache", `store-private-${randomUUID()}`);
  const store = new IpfsStore({ dataDir: directory });
  try {
    assert.equal(store.configuration.backend, "local");
    assert.equal("gateway" in store.configuration, false);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
