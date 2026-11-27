import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import * as dagPb from "@ipld/dag-pb";
import { UnixFS } from "ipfs-unixfs";
import { encodeSchema } from "@ipab/bundle";
import { CarBlockIterator } from "@ipld/car/iterator";
import { encodeBundleCar, memoryTree } from "@ipab/bundle-builder";
import { IpfsStore } from "@ipab/ipfs-store";
import { addPin, deletePin, pinDetails, renamePin } from "../src/pins.js";
import { State, type NamedPin, type PinMetadata } from "../src/state.js";
import { appSchema, appSchemaCid } from "../src/app-definition.js";
import { builtinContent } from "../src/builtins.js";
import {
  Ownership,
  recoverInactive,
  removeHistory,
  saveHistory,
} from "../src/history.js";
import { app, cli, content, fixture, importFiles, record } from "./helpers.js";

function gatewayFixture() {
  const gateway = "http://pin-fixture.invalid";
  const blocks = new Map<string, Uint8Array>();
  const calls: string[] = [];
  const original = globalThis.fetch;
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, options) => {
      const url =
        input instanceof URL
          ? input
          : new URL(input instanceof Request ? input.url : input);
      if (url.origin !== gateway) return original(input, options);
      expect(options?.method ?? "GET").toBe("GET");
      expect(url.pathname).toMatch(/^\/ipfs\//);
      calls.push(url.pathname);
      const bytes = blocks.get(url.pathname.split("/").at(-1)!);
      return bytes
        ? new Response(Buffer.from(bytes))
        : new Response("missing", { status: 404 });
    });
  return {
    gateway,
    blocks,
    calls,
    close() {
      fetch.mockRestore();
    },
  };
}

describe("named pins", { tags: ["release-e2e"] }, () => {
  let work: Awaited<ReturnType<typeof fixture>>;
  let state: State;
  let builtinPins: ReturnType<typeof pinDetails>[];
  let pendingProcess: Promise<unknown> | undefined;
  beforeEach(async () => {
    work = await fixture();
    pendingProcess = undefined;
    state = new State(work.stateDir);
    builtinPins = (await builtinContent()).pins.map(pinDetails);
    const config = join(work.root, "store.json");
    await writeFile(config, JSON.stringify(work.store.configuration));
    vi.stubEnv("TASK_CONTENT_CONFIG", config);
  });
  afterEach(async () => {
    if (pendingProcess) await Promise.allSettled([pendingProcess]);
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    state.close();
    await work.cleanup();
  });
  const jsonCli = async (args: string[]) => {
    const response = await cli(work.stateDir, ["--json", ...args]);
    expect(response.code, response.err).toBe(0);
    return JSON.parse(response.out) as unknown;
  };
  async function put(bytes: Uint8Array, codec = 0x55) {
    const cid = CID.createV1(codec, await sha256.digest(bytes));
    await work.store.put(cid, bytes);
    return cid.toString();
  }
  async function bundle(value: string) {
    const encoded = await encodeBundleCar(
      memoryTree(
        new Map([
          [
            ".bundle.yaml",
            new TextEncoder().encode(
              JSON.stringify({
                name: "File",
                entry: { path: "file.txt", contentType: "text/plain" },
              }),
            ),
          ],
          ["file.txt", new TextEncoder().encode(value)],
        ]),
      ),
    );
    try {
      const blocks = await CarBlockIterator.fromIterable(encoded.stream);
      for await (const block of blocks)
        await work.store.put(block.cid, block.bytes);
      return encoded.cid.toString();
    } finally {
      await encoded.close();
    }
  }
  async function publish(
    root: string,
    upstream: ReturnType<typeof gatewayFixture>,
  ) {
    const pending = [root];
    while (pending.length) {
      const cid = pending.pop()!;
      if (upstream.blocks.has(cid)) continue;
      const bytes = await work.store.block.get(cid);
      upstream.blocks.set(cid, bytes);
      if (CID.parse(cid).code === 0x70)
        pending.push(
          ...dagPb.decode(bytes).Links.map((link) => link.Hash.toString()),
        );
    }
  }

  it("requires a Bundle and gives every usable pin its verified type name", async () => {
    const root = await app(work.store, "throw new Error('must not execute');");
    const schema = await encodeSchema(appSchema);
    await work.store.put(schema.cid, schema.bytes);
    const raw = await put(Buffer.from("ordinary file"));
    const space = await importFiles(work.store, { file: "ordinary Space" });
    const generic = await put(Buffer.from("a1646e616d656367656e", "hex"), 0x71);
    const fileBytes = dagPb.encode(
      dagPb.prepare({
        Data: new UnixFS({
          type: "file",
          data: Buffer.from("UnixFS file"),
        }).marshal(),
        Links: [],
      }),
    );
    const file = await put(fileBytes, 0x70);
    const empty = await put(
      dagPb.encode(
        dagPb.prepare({
          Data: new UnixFS({ type: "directory" }).marshal(),
          Links: [],
        }),
      ),
      0x70,
    );
    expect(
      (await cli(work.stateDir, ["pin", "add", "reader", root])).code,
    ).toBe(0);
    const retain = vi.spyOn(IpfsStore.prototype, "retain");
    for (const [name, cid] of [
      ["node-type", schema.cid.toString()],
      ["file", raw],
      ["space", space],
      ["generic", generic],
      ["unixfs-file", file],
      ["empty", empty],
    ])
      expect((await cli(work.stateDir, ["pin", "add", name!, cid!])).code).toBe(
        1,
      );
    expect(retain).not.toHaveBeenCalled();
    const listing = await jsonCli(["pin", "list"]);
    expect(listing).toMatchObject({
      items: [
        {
          name: "reader",
          cid: root,
          kind: "bundle",
          typeName: "IPAB Node App",
          schemaCid: schema.cid.toString(),
        },
        ...builtinPins,
      ],
      pending: [
        { name: "empty" },
        { name: "file" },
        { name: "generic" },
        { name: "node-type" },
        { name: "space" },
        { name: "unixfs-file" },
      ],
      invalid: [],
    });
    const human = await cli(work.stateDir, ["pin", "list"]);
    expect(human.out).toContain("BUNDLE TYPE");
    expect(human.out).not.toContain("Fixture App");
    const details = await cli(work.stateDir, ["pin", "show", "reader"]);
    expect(details.out).toContain(`Schema CID: ${schema.cid.toString()}`);
    expect(details.out).toContain("local registration");
    expect(await jsonCli(["pin", "show", "reader"])).toEqual({
      name: "reader",
      cid: root,
      kind: "bundle",
      typeName: "IPAB Node App",
      schemaCid: schema.cid.toString(),
    });
    expect((await cli(work.stateDir, ["pin", "show", "file"])).code).toBe(1);
  }, 15_000);

  it("filters by exact type CID or a Bundle pin name without Store access", async () => {
    const root = await app(work.store, "");
    const other = await content(work.store);
    const schema = await encodeSchema(appSchema);
    await addPin(state, "reader", root, work.store.configuration);
    await addPin(state, "note", other.root, work.store.configuration);
    // Queries must not invoke the Store, including with an unreachable current backend.
    const reads = vi
      .spyOn(IpfsStore.prototype, "prepare")
      .mockRejectedValue(new Error("unexpected network"));
    for (const type of [schema.cid.toString(), "reader"])
      expect(
        await jsonCli([
          "--store-gateway",
          "http://127.0.0.1:1",
          "pin",
          "list",
          "--type",
          type,
        ]),
      ).toMatchObject({ items: [{ name: "reader", cid: root }] });
    expect(await jsonCli(["pin", "list", "--type", "reader"])).toMatchObject({
      items: [
        { name: "reader" },
        ...builtinPins.filter((pin) => pin.schemaCid === schema.cid.toString()),
      ],
    });
    expect(
      (await cli(work.stateDir, ["pin", "list", "--kind", "bundle"])).code,
    ).toBe(2);
    expect(
      await jsonCli(["pin", "list", "--type", other.schema]),
    ).toMatchObject({ items: [{ name: "note" }] });
    expect(
      (await cli(work.stateDir, ["pin", "list", "--type", "ordinary"])).code,
    ).toBe(1);
    expect(
      (await cli(work.stateDir, ["pin", "list", "--type", "missing"])).code,
    ).toBe(1);
    expect((await cli(work.stateDir, ["pin", "show", "reader"])).code).toBe(0);
    expect(reads).not.toHaveBeenCalled();
  }, 15_000);

  it("quarantines legacy non-Bundle pins without releasing retention or rewriting records", async () => {
    const type = await encodeSchema(appSchema);
    await work.store.put(type.cid, type.bytes);
    const raw = await put(Buffer.from("legacy raw file"));
    const legacy: { name: string; cid: string; metadata: PinMetadata }[] = [
      {
        name: "raw",
        cid: raw,
        metadata: { kind: "content", typeName: null, schemaCid: null },
      },
      {
        name: "type",
        cid: type.cid.toString(),
        metadata: {
          kind: "schema",
          typeName: appSchema.name,
          schemaCid: type.cid.toString(),
        },
      },
    ];
    for (const pin of legacy) {
      const owner = `legacy:${pin.name}`;
      await work.store.retain(owner, [pin.cid]);
      await work.store.confirmRetained(owner, [pin.cid]);
      state.saveHold({
        owner,
        backend: work.store.configuration,
        roots: [pin.cid],
        pid: null,
        session: null,
        recordId: null,
      });
      state.savePin({ ...pin, owner, status: "ready" });
    }
    state.close();
    state = new State(work.stateDir);
    await recoverInactive(state);
    const listed = await cli(work.stateDir, ["--json", "pin", "list"]);
    expect(listed.code).toBe(0);
    expect(JSON.parse(listed.out) as unknown).toMatchObject({
      items: builtinPins,
      invalid: [
        { name: "raw", cid: raw, kind: "content" },
        { name: "type", cid: type.cid.toString(), kind: "schema" },
      ],
      pending: [],
    });
    expect(listed.err).toContain("Retention is unchanged");
    for (const pin of legacy) {
      expect(state.pin(pin.name)?.metadata).toEqual(pin.metadata);
      expect(state.hold(`legacy:${pin.name}`)?.roots).toEqual([pin.cid]);
      expect(work.store.pins()).toContain(pin.cid);
      expect(() => state.resolve(pin.name)).toThrow("not a Bundle pin");
      expect(() => state.resolvePin(pin.name)).toThrow("not a Bundle pin");
      expect(() => state.resolve(pin.name, true)).toThrow("not a Bundle pin");
      expect(() => renamePin(state, pin.name, "new")).toThrow(
        "not a Bundle pin",
      );
      expect((await cli(work.stateDir, ["pin", "show", pin.name])).code).toBe(
        1,
      );
      expect(
        (await cli(work.stateDir, ["pin", "list", "--type", pin.name])).code,
      ).toBe(1);
      await deletePin(state, pin.name);
      expect(state.pin(pin.name)).toBeUndefined();
      expect(work.store.pins()).not.toContain(pin.cid);
    }
  });

  it("rejects conflicts, chains and missing names and atomically renames without Store calls or CID rewrites", async () => {
    const root = await app(work.store, "");
    await addPin(state, "reader", root, work.store.configuration);
    await addPin(state, "other", root, work.store.configuration);
    const original = state.pin("reader")!;
    const hold = state.hold(original.owner);
    state.setAssociation(appSchemaCid.toString(), "reader", ["%"], false);
    state.saveRun(record("pin-run", root));
    expect(
      (await cli(work.stateDir, ["pin", "add", "reader", root])).code,
    ).toBe(1);
    expect(
      (await cli(work.stateDir, ["pin", "add", "chain", "reader"])).code,
    ).toBe(2);
    for (const command of [
      ["show", "missing"],
      ["delete", "missing"],
      ["rename", "missing", "new"],
      ["rename", "reader", "other"],
    ])
      expect((await cli(work.stateDir, ["pin", ...command])).code).toBe(1);
    const retaining = vi.spyOn(IpfsStore.prototype, "retain");
    const releasing = vi.spyOn(IpfsStore.prototype, "reconcile");
    const acquiring = vi.spyOn(IpfsStore.prototype, "recoverOwner");
    expect(
      await jsonCli(["pin", "rename", "reader", "my-reader"]),
    ).toMatchObject({ name: "my-reader", cid: root });
    expect(state.pin("reader")).toBeUndefined();
    expect(state.pin("my-reader")).toEqual({ ...original, name: "my-reader" });
    expect(state.resolve("my-reader")).toBe(root);
    expect(() => state.resolve("reader")).toThrow("Unknown");
    expect(state.hold(original.owner)).toEqual(hold);
    expect(state.association(appSchemaCid.toString())?.appCid).toBe(root);
    expect(state.run("pin-run").appCid).toBe(root);
    expect((await cli(work.stateDir, ["history", "list"])).out).toContain(
      "my-reader",
    );
    expect(renamePin(state, "my-reader", "my-reader").name).toBe("my-reader");
    expect(retaining).not.toHaveBeenCalled();
    expect(releasing).not.toHaveBeenCalled();
    expect(acquiring).not.toHaveBeenCalled();
  });

  it("keeps independent owners after restart and execution/history cleanup, and deletes only its own responsibility", async () => {
    const root = await bundle("shared content");
    const rootBytes = await work.store.block.get(root);
    await addPin(state, "first", root, work.store.configuration);
    await addPin(state, "second", root, work.store.configuration);
    const first = state.pin("first")!;
    const second = state.pin("second")!;
    expect(first.owner).not.toBe(second.owner);
    const run = await Ownership.create(state, work.store, "active", null);
    await run.retain([root]);
    const saved = record("history-owner", root, { outputCid: root });
    await saveHistory(state, work.store, saved, true);
    state.close();
    state = new State(work.stateDir);
    await recoverInactive(state);
    expect(state.hold(first.owner)?.roots).toEqual([root]);
    expect(state.hold(second.owner)?.roots).toEqual([root]);
    await removeHistory(state, [saved.id]);
    await deletePin(state, "first");
    expect(state.pin("first")).toBeUndefined();
    expect(state.resolve("second")).toBe(root);
    expect(work.store.pins()).toContain(root);
    await new Ownership(state, work.store, run.owner).release();
    expect(work.store.pins()).toContain(root);
    expect(await jsonCli(["pin", "delete", "second"])).toEqual({
      removed: ["second"],
      retentionClaimsReleased: true,
      garbageCollectionGuaranteed: false,
    });
    expect(work.store.pins()).not.toContain(root);
    expect(await work.store.block.get(root)).toEqual(rootBytes);
  });

  it("fails on unavailable content and explicit invalid Bundle/schema declarations without downgrading", async () => {
    const missing = CID.createV1(
      0x55,
      await sha256.digest(Buffer.from("not imported")),
    ).toString();
    const badBundle = await importFiles(work.store, {
      ".bundle.yaml": "name: Broken\nentry: invalid",
      file: "valid block",
    });
    const badSchema = await put(Buffer.from("a165656e747279f6", "hex"), 0x71);
    for (const [name, cid] of [
      ["missing", missing],
      ["broken", badBundle],
      ["schema", badSchema],
    ]) {
      const added = await cli(work.stateDir, [
        "--json",
        "pin",
        "add",
        name!,
        cid!,
      ]);
      expect(added.code).toBe(1);
      expect(added.out).toBe("");
      expect(state.pin(name!)?.status).toBe("pending");
      expect((await cli(work.stateDir, ["pin", "show", name!])).code).toBe(1);
      expect(() => state.resolve(name!)).toThrow("pending");
      expect(
        (await cli(work.stateDir, ["pin", "rename", name!, "renamed"])).code,
      ).toBe(1);
    }
    const result = await cli(work.stateDir, ["--json", "pin", "list"]);
    expect(JSON.parse(result.out) as unknown).toMatchObject({
      items: builtinPins,
      pending: [{ name: "broken" }, { name: "missing" }, { name: "schema" }],
    });
    expect(result.err).toContain("not usable pins");
    await expect(
      addPin(state, "missing", badSchema, work.store.configuration),
    ).rejects.toThrow("occupied");
    await deletePin(state, "missing");
    expect(state.pin("missing")).toBeUndefined();
  });

  it("verifies every DAG link and migrates old Alias metadata only through a real retain", async () => {
    const leaf = CID.createV1(
      0x55,
      await sha256.digest(Buffer.from("missing leaf")),
    );
    const incomplete = await put(
      dagPb.encode(
        dagPb.prepare({
          Data: new UnixFS({ type: "directory" }).marshal(),
          Links: [{ Name: "file", Hash: leaf, Tsize: 12 }],
        }),
      ),
      0x70,
    );
    await expect(
      addPin(state, "incomplete", incomplete, work.store.configuration),
    ).rejects.toThrow("incomplete");
    expect(state.pin("incomplete")?.status).toBe("pending");
    await deletePin(state, "incomplete");
    const root = await bundle("migrate");
    expect(() => state.resolve("legacy")).toThrow("Unknown");
    expect(state.pins()).toEqual([]);
    await addPin(state, "legacy", root, work.store.configuration);
    expect(state.resolve("legacy")).toBe(root);
    expect(work.store.pins()).toContain(root);
  });

  it.each(["recoverOwner", "retain", "confirmRetained", "close"] as const)(
    "preserves and retries failed add at %s using its stable owner and original backend",
    async (method) => {
      const root = await bundle("retry");
      vi.spyOn(IpfsStore.prototype, method).mockRejectedValueOnce(
        new Error("injected failure"),
      );
      await expect(
        addPin(state, "retry", root, work.store.configuration),
      ).rejects.toThrow("incomplete");
      const pin = state.pin("retry")!;
      expect(pin.status).toBe("pending");
      expect(state.hold(pin.owner)?.pid).toBeNull();
      vi.restoreAllMocks();
      const different = {
        backend: "local" as const,
        dataDir: join(work.root, "different"),
      };
      await addPin(state, "retry", root, different);
      expect(state.pin("retry")?.owner).toBe(pin.owner);
      expect(state.hold(pin.owner)?.backend).toEqual(work.store.configuration);
      expect(state.resolve("retry")).toBe(root);
    },
  );

  it.each(["recoverOwner", "reconcile", "close"] as const)(
    "does not report a failed delete at %s as complete and supports retry",
    async (method) => {
      const root = await bundle("delete retry");
      await addPin(state, "retry", root, work.store.configuration);
      const owner = state.pin("retry")!.owner;
      vi.spyOn(IpfsStore.prototype, method).mockRejectedValueOnce(
        new Error("release failure"),
      );
      expect((await cli(work.stateDir, ["pin", "delete", "retry"])).code).toBe(
        1,
      );
      expect(state.pin("retry")?.status).toBe("deleting");
      expect(state.hold(owner)).toMatchObject({ roots: [], pid: null });
      expect(() => state.resolve("retry")).toThrow("deleting");
      vi.restoreAllMocks();
      await deletePin(state, "retry");
      expect(state.pin("retry")).toBeUndefined();
      expect(state.hold(owner)).toBeUndefined();
    },
  );

  it("reserves names transactionally under concurrency and protects active operations", async () => {
    const root = await bundle("concurrent");
    const competing = new State(work.stateDir);
    let resume!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const original = Object.getOwnPropertyDescriptor(
      IpfsStore.prototype,
      "retain",
    )!.value as IpfsStore["retain"];
    vi.spyOn(IpfsStore.prototype, "retain").mockImplementationOnce(
      async function (this: IpfsStore, ...args) {
        entered();
        await gate;
        return original.apply(this, args);
      },
    );
    try {
      const adding = addPin(
        state,
        "concurrent",
        root,
        work.store.configuration,
      );
      await started;
      await expect(
        addPin(competing, "concurrent", root, work.store.configuration),
      ).rejects.toThrow("active");
      await expect(deletePin(competing, "concurrent")).rejects.toThrow(
        "active",
      );
      expect(() => renamePin(competing, "concurrent", "new")).toThrow(
        "pending",
      );
      resume();
      await adding;
      expect(competing.pins()).toHaveLength(1);
      const pin = state.pin("concurrent")!;
      state.saveHold({ ...state.hold(pin.owner)!, pid: process.pid });
      expect(() => renamePin(competing, "concurrent", "new")).toThrow("active");
      state.saveHold({ ...state.hold(pin.owner)!, pid: null });
      const originalSave = state.savePin.bind(state);
      const saving = vi.spyOn(state, "savePin").mockImplementationOnce(() => {
        throw new Error("database write failure");
      });
      expect(() => renamePin(state, "concurrent", "new")).toThrow(
        "database write",
      );
      expect(state.pin("concurrent")).toEqual(pin);
      saving.mockImplementation(originalSave);
    } finally {
      resume();
      competing.close();
    }
  });

  it("recovers add after interrupted metadata/ready commits without losing Store intents", async () => {
    const root = await bundle("commit recovery");
    const save = state.savePin.bind(state);
    vi.spyOn(state, "savePin").mockImplementation((pin) => {
      if (pin.status === "ready") throw new Error("ready commit failed");
      save(pin);
    });
    await expect(
      addPin(state, "recover", root, work.store.configuration),
    ).rejects.toThrow("commit failed");
    const pin = state.pin("recover")!;
    expect(pin.metadata?.kind).toBe("bundle");
    expect(state.hold(pin.owner)?.roots).toEqual([root]);
    vi.restoreAllMocks();
    state.close();
    state = new State(work.stateDir);
    const hold = state.hold(pin.owner)!;
    state.saveHold({ ...hold, pid: 2_147_483_647 });
    await recoverInactive(state);
    expect(state.pin("recover")?.status).toBe("pending");
    await addPin(state, "recover", root, work.store.configuration);
    expect(state.pin("recover")?.owner).toBe(pin.owner);
    const db = new DatabaseSync(
      join(work.store.configuration.dataDir, "retention", "retention.sqlite"),
    );
    expect(
      db
        .prepare("SELECT count(*) AS count FROM intents WHERE id=?")
        .get(pin.owner)?.count,
    ).toBe(0);
    db.close();
  });

  it("lists a consistent local snapshot when another connection deletes a name during the read", async () => {
    const root = await bundle("snapshot");
    await addPin(state, "snapshot", root, work.store.configuration);
    const pin = state.pin("snapshot")!;
    const competing = new State(work.stateDir);
    const prepare = state.db.prepare.bind(state.db);
    vi.spyOn(state.db, "prepare").mockImplementationOnce((sql) => {
      const statement = prepare(sql);
      const all = statement.all.bind(statement);
      vi.spyOn(statement, "all").mockImplementationOnce(() => {
        const rows = all();
        competing.deletePin("snapshot");
        return rows;
      });
      return statement;
    });
    try {
      expect(state.pins()).toEqual([pin]);
      expect(state.pin("snapshot")).toBeUndefined();
    } finally {
      competing.close();
    }
  });

  it("recovers after an actual child process exits between reference commit and confirmation", async ({
    signal,
  }) => {
    const root = await bundle("process interruption");
    pendingProcess = promisify(execFile)(
      process.execPath,
      [
        fileURLToPath(new URL("./fixtures/pin-recovery.mjs", import.meta.url)),
        work.stateDir,
        root,
        JSON.stringify(work.store.configuration),
      ],
      { signal },
    );
    await expect(pendingProcess).rejects.toMatchObject({ code: 42 });
    const pin = state.pin("interrupted")!;
    expect(pin.status).toBe("pending");
    expect(state.hold(pin.owner)?.roots).toEqual([root]);
    await recoverInactive(state);
    expect(state.hold(pin.owner)).toBeDefined();
    await addPin(state, "interrupted", root, work.store.configuration);
    expect(state.pin("interrupted")?.owner).toBe(pin.owner);
    expect(state.resolve("interrupted")).toBe(root);
  });

  it("preserves journals on Store construction failure and blocks missing/corrupt retention metadata", async () => {
    const root = await bundle("construction");
    const fail = () => {
      throw new Error("Store configuration failure");
    };
    await expect(
      addPin(state, "recover", root, work.store.configuration, fail),
    ).rejects.toThrow("incomplete");
    await expect(deletePin(state, "recover", fail)).rejects.toThrow(
      "incomplete",
    );
    await deletePin(state, "recover");
    await addPin(state, "valid", root, work.store.configuration);
    const pin = state.pin("valid")!;
    state.deleteHold(pin.owner);
    await expect(deletePin(state, "valid")).rejects.toThrow(
      "metadata is missing",
    );
    expect(() => renamePin(state, "valid", "new")).toThrow(
      "metadata is missing",
    );
    const conflicting: NamedPin = { ...pin, owner: "not-the-owner" };
    expect(() => {
      state.savePin(conflicting);
    }).toThrow("occupied");
    expect(() => pinDetails({ ...pin, metadata: null })).toThrow("Retry");
    for (const change of [
      { status: "unknown" },
      { owner: "wrong" },
      { cid: 2 },
      { metadata: null },
      { metadata: { kind: "wrong" } },
      { metadata: { kind: "content", typeName: "invented", schemaCid: null } },
      { metadata: { kind: "schema", typeName: null, schemaCid: root } },
    ]) {
      state.db
        .prepare("UPDATE named_pins SET value=? WHERE name=?")
        .run(JSON.stringify({ ...pin, ...change }), pin.name);
      expect(() => state.pin(pin.name)).toThrow();
    }
    state.db
      .prepare("UPDATE named_pins SET value=? WHERE name=?")
      .run(JSON.stringify(pin), pin.name);
  });

  it("replicates from a read-only gateway, pins locally and keeps the original local Store after configuration changes", async () => {
    const upstream = gatewayFixture();
    const config = {
      backend: "local" as const,
      dataDir: join(work.root, "replica"),
      gateway: upstream.gateway,
    };
    const replica = new IpfsStore(config);
    try {
      const root = await bundle("LAN shared");
      await publish(root, upstream);
      const bytes = [...upstream.blocks.values()].reduce(
        (sum, block) => sum + block.length,
        0,
      );
      await addPin(state, "first", root, config);
      await addPin(state, "second", root, config);
      expect(await replica.usage()).toEqual({
        cachedBytes: bytes,
        pinnedBytes: bytes,
      });
      const calls = upstream.calls.length;
      renamePin(state, "first", "renamed");
      expect(upstream.calls).toHaveLength(calls);
      state.setConfig("store.gateway", null);
      expect(
        (await cli(work.stateDir, ["pin", "delete", "renamed"])).code,
      ).toBe(0);
      expect(replica.pins()).toContain(root);
      expect(state.resolve("second")).toBe(root);
      await deletePin(state, "second");
      expect(replica.pins()).toEqual([]);
      expect(upstream.blocks.has(root)).toBe(true);
      expect(await replica.gc()).toEqual({
        removedBlocks: upstream.blocks.size,
        reclaimedBytes: bytes,
      });
      expect(upstream.calls).toHaveLength(calls);
    } finally {
      await replica.close();
      upstream.close();
    }
  });

  it("preserves retry metadata when a gateway serves corrupt or missing blocks", async () => {
    const upstream = gatewayFixture();
    const config = {
      backend: "local" as const,
      dataDir: join(work.root, "replica"),
      gateway: upstream.gateway,
    };
    try {
      const root = await bundle("uncertain");
      await publish(root, upstream);
      upstream.blocks.set(root, Buffer.from("wrong hash"));
      await expect(addPin(state, "uncertain", root, config)).rejects.toThrow(
        "incomplete",
      );
      const owner = state.pin("uncertain")!.owner;
      upstream.blocks.set(root, await work.store.block.get(root));
      await addPin(state, "uncertain", root, config);
      expect(state.pin("uncertain")?.owner).toBe(owner);
      await deletePin(state, "uncertain");
      const missing = await bundle("missing upstream");
      await expect(addPin(state, "offline", missing, config)).rejects.toThrow(
        "incomplete",
      );
      expect(state.pin("offline")?.status).toBe("pending");
    } finally {
      upstream.close();
    }
  });
  it("refuses legacy Kubo retention cleanup without changing the original responsibility or calling RPC", async () => {
    const root = await bundle("legacy");
    await addPin(state, "legacy", root, work.store.configuration);
    const pin = state.pin("legacy")!;
    const hold = state.hold(pin.owner)!;
    const legacy = {
      ...hold,
      backend: { backend: "kubo", apiUrl: "http://legacy.invalid" },
    };
    state.db
      .prepare("UPDATE holds SET value=? WHERE owner=?")
      .run(JSON.stringify(legacy), pin.owner);
    const fetch = vi.spyOn(globalThis, "fetch");
    await expect(deletePin(state, "legacy")).rejects.toThrow(
      "not migrated or released",
    );
    expect(state.pin("legacy")?.status).toBe("ready");
    expect(
      String(
        state.db.prepare("SELECT value FROM holds WHERE owner=?").get(pin.owner)
          ?.value,
      ),
    ).toBe(JSON.stringify(legacy));
    expect(fetch).not.toHaveBeenCalled();
  });
});
