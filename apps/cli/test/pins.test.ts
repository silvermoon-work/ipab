import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import * as dagPb from "@ipld/dag-pb";
import { UnixFS } from "ipfs-unixfs";
import { encodeSchema } from "@ipab/bundle";
import { IpfsStore } from "@ipab/ipfs-store";
import { addPin, deletePin, pinDetails, renamePin } from "../src/pins.js";
import { State, type NamedPin } from "../src/state.js";
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

describe("named pins", () => {
  let work: Awaited<ReturnType<typeof fixture>>;
  let state: State;
  let builtinPins: ReturnType<typeof pinDetails>[];
  beforeEach(async () => {
    work = await fixture();
    state = new State(work.stateDir);
    builtinPins = (await builtinContent()).pins.map(pinDetails);
    const config = join(work.root, "store.json");
    await writeFile(config, JSON.stringify(work.store.configuration));
    vi.stubEnv("TASK_CONTENT_CONFIG", config);
  });
  afterEach(async () => {
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

  it("classifies Bundle, standalone Schema and ordinary content without substituting App names", async () => {
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
    for (const [name, cid] of [
      ["reader", root],
      ["node-type", schema.cid.toString()],
      ["file", raw],
      ["space", space],
      ["generic", generic],
      ["unixfs-file", file],
      ["empty", empty],
    ])
      expect((await cli(work.stateDir, ["pin", "add", name!, cid!])).code).toBe(
        0,
      );
    const listing = await jsonCli(["pin", "list"]);
    expect(listing).toMatchObject({
      items: [
        { name: "empty", kind: "content", typeName: null, schemaCid: null },
        { name: "file", cid: raw, kind: "content" },
        { name: "generic", kind: "content" },
        {
          name: "node-type",
          kind: "schema",
          typeName: "IPAB Node App",
          schemaCid: schema.cid.toString(),
        },
        {
          name: "reader",
          cid: root,
          kind: "bundle",
          typeName: "IPAB Node App",
          schemaCid: schema.cid.toString(),
        },
        { name: "space", kind: "content" },
        { name: "unixfs-file", kind: "content" },
        ...builtinPins,
      ],
      pending: [],
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
    expect((await cli(work.stateDir, ["pin", "show", "file"])).out).toContain(
      "no Bundle type metadata",
    );
  }, 15_000);

  it("filters local metadata by kind and exact type or Schema pin/builtin name, with AND semantics", async () => {
    const root = await app(work.store, "");
    const other = await content(work.store);
    const schema = await encodeSchema(appSchema);
    await work.store.put(schema.cid, schema.bytes);
    await addPin(state, "reader", root, work.store.configuration);
    await addPin(
      state,
      "node-type",
      schema.cid.toString(),
      work.store.configuration,
    );
    await addPin(state, "note", other.root, work.store.configuration);
    await addPin(
      state,
      "ordinary",
      await put(Buffer.from("file")),
      work.store.configuration,
    );
    // Queries must not invoke the Store, including with an unreachable current backend.
    const reads = vi
      .spyOn(IpfsStore.prototype, "prepare")
      .mockRejectedValue(new Error("unexpected network"));
    for (const type of [
      schema.cid.toString(),
      "node-type",
      "builtin:node-app.v1",
    ])
      expect(
        await jsonCli([
          "--store-gateway",
          "http://127.0.0.1:1",
          "pin",
          "list",
          "--kind",
          "bundle",
          "--type",
          type,
        ]),
      ).toMatchObject({ items: [{ name: "reader", cid: root }] });
    expect(await jsonCli(["pin", "list", "--type", "node-type"])).toMatchObject(
      {
        items: [
          { name: "node-type" },
          { name: "reader" },
          ...builtinPins.filter(
            (pin) => pin.schemaCid === schema.cid.toString(),
          ),
        ],
      },
    );
    expect(await jsonCli(["pin", "list", "--kind", "schema"])).toMatchObject({
      items: [
        { name: "node-type" },
        ...builtinPins.filter((pin) => pin.kind === "schema"),
      ],
    });
    expect(
      await jsonCli([
        "pin",
        "list",
        "--kind",
        "schema",
        "--type",
        other.schema,
      ]),
    ).toMatchObject({ items: [] });
    expect(
      (await cli(work.stateDir, ["pin", "list", "--type", "ordinary"])).code,
    ).toBe(1);
    expect(
      (await cli(work.stateDir, ["pin", "list", "--type", "reader"])).err,
    ).toContain("Schema pin");
    expect(
      (await cli(work.stateDir, ["pin", "list", "--type", "missing"])).code,
    ).toBe(1);
    expect((await cli(work.stateDir, ["pin", "show", "reader"])).code).toBe(0);
    expect(reads).not.toHaveBeenCalled();
  }, 15_000);

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
    const root = await put(Buffer.from("shared content"));
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
    expect(await work.store.block.get(root)).toEqual(
      Uint8Array.from(Buffer.from("shared content")),
    );
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
    const root = await put(Buffer.from("migrate"));
    expect(() => state.resolve("legacy")).toThrow("Unknown");
    expect(state.pins()).toEqual([]);
    await addPin(state, "legacy", root, work.store.configuration);
    expect(state.resolve("legacy")).toBe(root);
    expect(work.store.pins()).toContain(root);
  });

  it.each(["recoverOwner", "retain", "confirmRetained", "close"] as const)(
    "preserves and retries failed add at %s using its stable owner and original backend",
    async (method) => {
      const root = await put(Buffer.from("retry"));
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
      const root = await put(Buffer.from("delete retry"));
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
    const root = await put(Buffer.from("concurrent"));
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
    const root = await put(Buffer.from("commit recovery"));
    const save = state.savePin.bind(state);
    vi.spyOn(state, "savePin").mockImplementation((pin) => {
      if (pin.status === "ready") throw new Error("ready commit failed");
      save(pin);
    });
    await expect(
      addPin(state, "recover", root, work.store.configuration),
    ).rejects.toThrow("commit failed");
    const pin = state.pin("recover")!;
    expect(pin.metadata?.kind).toBe("content");
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
    const root = await put(Buffer.from("snapshot"));
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

  it("recovers after an actual child process exits between reference commit and confirmation", async () => {
    const root = await put(Buffer.from("process interruption"));
    const script = `
      import { IpfsStore } from ${JSON.stringify(new URL("../../../packages/ipfs-store/dist/index.js", import.meta.url).href)};
      import { State } from ${JSON.stringify(new URL("../dist/state.js", import.meta.url).href)};
      import { addPin } from ${JSON.stringify(new URL("../dist/pins.js", import.meta.url).href)};
      const state = new State(${JSON.stringify(work.stateDir)});
      await addPin(state, "interrupted", ${JSON.stringify(root)}, ${JSON.stringify(work.store.configuration)}, config => {
        const store = new IpfsStore(config);
        store.confirmRetained = async () => { process.exit(42); };
        return store;
      });
    `;
    await expect(
      promisify(execFile)(process.execPath, [
        "--input-type=module",
        "--eval",
        script,
      ]),
    ).rejects.toMatchObject({ code: 42 });
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
    const root = await put(Buffer.from("construction"));
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
      const root = await put(Buffer.from("LAN shared"));
      upstream.blocks.set(root, await work.store.block.get(root));
      await addPin(state, "first", root, config);
      await addPin(state, "second", root, config);
      expect(await replica.usage()).toEqual({
        cachedBytes: 10,
        pinnedBytes: 10,
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
        removedBlocks: 1,
        reclaimedBytes: 10,
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
      const root = await put(Buffer.from("uncertain"));
      upstream.blocks.set(root, Buffer.from("wrong hash"));
      await expect(addPin(state, "uncertain", root, config)).rejects.toThrow(
        "incomplete",
      );
      const owner = state.pin("uncertain")!.owner;
      upstream.blocks.set(root, await work.store.block.get(root));
      await addPin(state, "uncertain", root, config);
      expect(state.pin("uncertain")?.owner).toBe(owner);
      await deletePin(state, "uncertain");
      const missing = await put(Buffer.from("missing upstream"));
      await expect(addPin(state, "offline", missing, config)).rejects.toThrow(
        "incomplete",
      );
      expect(state.pin("offline")?.status).toBe("pending");
    } finally {
      upstream.close();
    }
  });
  it("refuses legacy Kubo retention cleanup without changing the original responsibility or calling RPC", async () => {
    const root = await put(Buffer.from("legacy"));
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
