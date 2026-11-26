import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IpfsStore } from "@ipab/ipfs-store";
import { State } from "../src/state.js";
import {
  alive,
  filters,
  listHistory,
  selectedIds,
  Ownership,
  recoverInactive,
  removeHistory,
  saveHistory,
  timestamp,
} from "../src/history.js";
import { appSchemaCid } from "../src/space.js";
import {
  fixture,
  importFiles,
  record,
  cli,
  seedDisplayPin,
} from "./helpers.js";

describe("history and durable retention", { tags: ["release-e2e"] }, () => {
  let work: Awaited<ReturnType<typeof fixture>>;
  let state: State;
  beforeEach(async () => {
    work = await fixture();
    state = new State(work.stateDir);
  });
  afterEach(async () => {
    state.close();
    await work.cleanup();
    vi.restoreAllMocks();
  });
  const cid = appSchemaCid.toString();

  it("list filters share endedAt boundaries, AND matching and stable cursor order", () => {
    for (let index = 0; index < 26; index++)
      state.saveRun(record(`run-${index.toString().padStart(2, "0")}`, cid));
    state.saveRun(
      record("early", cid, {
        endedAt: "2026-11-22T23:59:59Z",
        status: "failed",
      }),
    );
    state.saveRun(
      record("late", cid, {
        endedAt: "2026-11-23T00:00:02Z",
        status: "failed",
      }),
    );
    seedDisplayPin(state, "app", cid);
    const first = listHistory(
      state,
      filters(state, {
        app: "app",
        since: "2026-11-23T00:00:01Z",
        until: "2026-11-23T00:00:02Z",
        status: "succeeded",
      }),
      20,
    );
    expect(first.items).toHaveLength(20);
    expect(first.items[0]?.id).toBe("run-25");
    expect(first.nextBefore).toBe("run-06");
    const second = listHistory(
      state,
      { app: cid, status: "succeeded" },
      20,
      first.nextBefore!,
    );
    expect(second.items.map((item) => item.id)).toEqual([
      "run-05",
      "run-04",
      "run-03",
      "run-02",
      "run-01",
      "run-00",
    ]);
    expect(second.nextBefore).toBeNull();
    expect(
      listHistory(state, { since: timestamp("2026-11-24T00:00:00+08:00") }, 1)
        .items,
    ).toEqual([]);
    expect(() => listHistory(state, {}, 20, "missing")).toThrow(
      "does not exist",
    );
    expect(
      selectedIds(state, {
        status: "failed",
        until: timestamp("2026-11-23T00:00:02Z"),
      }),
    ).toEqual(["early"]);
    expect(timestamp("2026-11-23T08:00:01+08:00")).toBe(
      timestamp("2026-11-23T00:00:01Z"),
    );
  });

  it.each([
    "2026-11-23",
    "2026-11-23T00:00:00",
    "2026-02-30T00:00:00Z",
    "2026-13-01T00:00:00Z",
    "2026-01-00T00:00:00Z",
    "2026-01-01T25:00:00Z",
    "2026-01-01T00:61:00Z",
    "2026-01-01T00:00:61Z",
  ])("rejects invalid time %s", (value) => {
    expect(() => timestamp(value)).toThrow();
  });

  it.each(["list", "remove"] as const)(
    "rejects sub-millisecond %s filters without changing recorded history",
    async (action) => {
      state.saveRun(record("boundary", cid));
      const result = await cli(work.stateDir, [
        "history",
        action,
        "--since",
        "2026-11-23T00:00:01.0001Z",
        "--until",
        "2026-11-23T00:00:01.0011Z",
        ...(action === "remove" ? ["--yes"] : []),
      ]);
      expect(result.code).toBe(2);
      expect(result.out).toBe("");
      expect(state.runs().map((run) => run.id)).toEqual(["boundary"]);
    },
  );

  it("deletes all 26 filtered ended records, never the default list page", async () => {
    for (let index = 0; index < 26; index++)
      state.saveRun(record(`run-${index}`, cid, { status: "failed" }));
    state.saveRun(
      record("outside", cid, {
        endedAt: "2026-11-23T00:00:02Z",
        status: "failed",
      }),
    );
    const result = await cli(work.stateDir, [
      "--json",
      "history",
      "remove",
      "--status",
      "failed",
      "--since",
      "2026-11-23T00:00:01Z",
      "--until",
      "2026-11-23T00:00:02Z",
      "--yes",
    ]);
    expect(result.code).toBe(0);
    expect(
      (JSON.parse(result.out) as { removed: string[] }).removed,
    ).toHaveLength(26);
    expect(state.runs().map((record) => record.id)).toEqual(["outside"]);
    expect(
      (
        await cli(work.stateDir, [
          "--json",
          "history",
          "remove",
          "--status",
          "succeeded",
          "--yes",
        ])
      ).out,
    ).toBe(
      '{"removed":[],"retentionClaimsReleased":true,"garbageCollectionGuaranteed":false}',
    );
    expect(
      (await cli(work.stateDir, ["history", "remove", "missing", "--yes"]))
        .code,
    ).toBe(1);
  });

  it("freezes selection before TTY confirmation and keeps cancellation mutation-free", async () => {
    state.saveRun(record("one", cid));
    const cancelled = await cli(
      work.stateDir,
      ["history", "remove", "--status", "succeeded"],
      { tty: true },
    );
    expect(cancelled.code).toBe(1);
    expect(state.runs()).toHaveLength(1);
    const result = await cli(
      work.stateDir,
      ["--json", "history", "remove", "--status", "succeeded"],
      {
        tty: true,
        confirm: (text) => {
          expect(text).toContain("1 ended records");
          expect(text).toContain("no GC");
          state.saveRun(record("new", cid));
          return Promise.resolve(true);
        },
      },
    );
    expect(result.code).toBe(0);
    expect(result.out).toContain('"removed":["one"]');
    expect(state.runs().map((record) => record.id)).toEqual(["new"]);
    expect((await cli(work.stateDir, ["history", "remove", "new"])).code).toBe(
      2,
    );
  });

  it("invalid shared filters fail before deletion; show failed records succeeds offline", async () => {
    state.saveRun(
      record("failed", cid, {
        status: "failed",
        error: { phase: "execution", code: "APP_EXIT", message: "failed" },
        appExitCode: 7,
      }),
    );
    for (const args of [
      ["--since", "2026-11-23T01:00:00Z", "--until", "2026-11-23T01:00:00Z"],
      ["--status", "invalid"],
      ["--app", "missing"],
      ["--until", "2026-11-23"],
    ]) {
      const result = await cli(work.stateDir, [
        "history",
        "remove",
        ...args,
        "--yes",
      ]);
      expect(result.code).not.toBe(0);
      expect(state.runs()).toHaveLength(1);
    }
    const shown = await cli(work.stateDir, [
      "--store-gateway",
      "http://localhost:1",
      "--json",
      "history",
      "show",
      "failed",
    ]);
    expect(shown.code).toBe(0);
    expect(shown.out).toContain('"appExitCode":7');
    expect(shown.out).not.toContain("contentCid");
    expect(
      (
        await cli(work.stateDir, [
          "--json",
          "history",
          "list",
          "--status",
          "cancelled",
        ])
      ).out,
    ).toBe('{"items":[],"nextBefore":null}');
  });

  it("shared roots survive removal of one owner; backend identity ignores current configuration", async () => {
    const root = await importFiles(work.store, { "a.txt": "shared" });
    await saveHistory(
      state,
      work.store,
      record("first", cid, { outputCid: root }),
      true,
    );
    await saveHistory(
      state,
      work.store,
      record("second", cid, { outputCid: root }),
      true,
    );
    const active = await Ownership.create(state, work.store, "active", null);
    await active.retain([root]);
    await active.retain([root]);
    await work.store.reconcile("fixtures", []);
    expect(work.store.pins()).toContain(root);
    expect(
      (
        await cli(work.stateDir, [
          "--store-gateway",
          "http://localhost:1",
          "--json",
          "history",
          "remove",
          "first",
          "--yes",
        ])
      ).code,
    ).toBe(0);
    expect(work.store.pins()).toContain(root);
    await removeHistory(state, ["second"]);
    expect(work.store.pins()).toContain(root);
    await active.release();
    expect(work.store.pins()).not.toContain(root);
    const node = await work.store.read(`${root}/a.txt`);
    expect(node.type).not.toBe("directory");
  });

  it("release failures remain retryable and batch reports actual completed/remaining IDs", async () => {
    const root = await importFiles(work.store, { file: "kept" });
    state.saveRun(record("unowned", cid));
    await saveHistory(
      state,
      work.store,
      record("owned", cid, { outputCid: root }),
      true,
    );
    const factory = () => {
      const store = new IpfsStore(work.store.configuration);
      vi.spyOn(store, "reconcile").mockRejectedValue(
        new Error("release unavailable"),
      );
      return store;
    };
    await expect(
      removeHistory(state, ["unowned", "owned"], factory),
    ).rejects.toThrow('Completed: ["unowned"]; remaining: ["owned"]');
    expect(state.runs()).toHaveLength(1);
    expect(state.run("owned").retention.state).toBe("releasing");
    expect(
      state.holds().find((hold) => hold.recordId === "owned")?.roots,
    ).toEqual([]);
    expect((await removeHistory(state, ["owned"])).removed).toEqual(["owned"]);
    expect(state.runs()).toEqual([]);
    state.saveRun(
      record("broken", cid, { retention: { owned: true, state: "retained" } }),
    );
    await expect(removeHistory(state, ["broken"])).rejects.toThrow(
      "metadata is missing",
    );
  });

  it("never recovers active owners, but reclaims idle staged imports and pending history commits", async () => {
    const root = await importFiles(work.store, { file: "fixture" });
    const active = await Ownership.create(
      state,
      work.store,
      "active",
      "active-stage",
    );
    await active.retain([root]);
    const factory = vi.fn(
      (config: IpfsStore["configuration"]) => new IpfsStore(config),
    );
    await recoverInactive(state, factory);
    expect(factory).not.toHaveBeenCalled();
    expect(state.hold(active.owner)?.roots).toContain(root);
    const hold = state.hold(active.owner)!;
    state.saveHold({ ...hold, pid: null });
    await recoverInactive(state, factory);
    expect(state.hold(active.owner)).toBeUndefined();
    expect(alive(process.pid)).toBe(true);
    expect(alive(2_147_483_647)).toBe(false);
    const confirm = vi
      .spyOn(work.store, "confirmRetained")
      .mockRejectedValueOnce(new Error("confirm failed"));
    await expect(
      saveHistory(
        state,
        work.store,
        record("pending", cid, { outputCid: root }),
        true,
      ),
    ).rejects.toThrow("confirm failed");
    expect(state.run("pending").retention.state).toBe("pending");
    expect(state.holds()[0]?.pid).toBeNull();
    confirm.mockRestore();
    await removeHistory(state, ["pending"]);
    expect(state.holds()).toEqual([]);
  });

  it("owner registration retries coordinator contention but exposes permanent registration failures", async () => {
    const original = work.store.registerOwner.bind(work.store);
    const register = vi
      .spyOn(work.store, "registerOwner")
      .mockImplementationOnce(() => {
        throw Object.assign(new Error("busy"), {
          code: "retention_unfinished",
        });
      })
      .mockImplementation(original);
    const owner = await Ownership.create(state, work.store, "retry", null);
    expect(register).toHaveBeenCalledTimes(2);
    await owner.release();
    await owner.release();
    register.mockImplementationOnce(() => {
      throw new Error("invalid coordination");
    });
    await expect(
      Ownership.create(state, work.store, "failed-register", null),
    ).rejects.toThrow("invalid coordination");
    expect(state.holds()[0]?.pid).toBeNull();
    register.mockRestore();
    const kill = vi.spyOn(process, "kill").mockImplementationOnce(() => {
      throw Object.assign(new Error("denied"), { code: "EPERM" });
    });
    expect(alive(123)).toBe(true);
    kill.mockRestore();
  });
  it("blocks deletion while publication is active and survives concurrent histories", async () => {
    const root = await importFiles(work.store, { file: "shared" });
    let finish: (() => void) | undefined;
    const original = work.store.confirmRetained.bind(work.store);
    const confirm = vi
      .spyOn(work.store, "confirmRetained")
      .mockImplementation(async (owner, roots, options) => {
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        await original(owner, roots, options);
      });
    const saving = saveHistory(
      state,
      work.store,
      record("active-commit", cid, { outputCid: root }),
      true,
    );
    for (let attempt = 0; attempt < 100 && !finish; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    await expect(removeHistory(state, ["active-commit"])).rejects.toThrow(
      "commit is active",
    );
    finish!();
    await saving;
    confirm.mockRestore();
    const secondState = new State(work.stateDir);
    const secondStore = new IpfsStore(work.store.configuration);
    try {
      await Promise.all([
        saveHistory(
          state,
          work.store,
          record("left", cid, { outputCid: root }),
          true,
        ),
        saveHistory(
          secondState,
          secondStore,
          record("right", cid, { outputCid: root }),
          true,
        ),
      ]);
      expect(state.runs()).toHaveLength(3);
      await Promise.all([
        removeHistory(state, ["left"]),
        removeHistory(secondState, ["right"]),
      ]);
      expect(state.runs().map((record) => record.id)).toEqual([
        "active-commit",
      ]);
    } finally {
      secondState.close();
      await secondStore.close();
    }
  });

  it("malformed durable roots block cleanup instead of being interpreted as an empty owner", async () => {
    const owner = await Ownership.create(state, work.store, "protected", null);
    const valid = state.hold(owner.owner)!;
    const invalid = [
      { ...valid, roots: undefined },
      { ...valid, roots: [123] },
      { ...valid, roots: ["invalid"] },
      { ...valid, owner: "wrong" },
      { ...valid, pid: -1 },
      { ...valid, session: 123 },
      { ...valid, recordId: 123 },
      { ...valid, backend: null },
    ];
    for (const value of invalid) {
      state.db
        .prepare("UPDATE holds SET value=? WHERE owner=?")
        .run(JSON.stringify(value), owner.owner);
      expect(() => state.hold(owner.owner)).toThrow("cleanup is blocked");
      await expect(recoverInactive(state)).rejects.toThrow(
        "cleanup is blocked",
      );
    }
    state.saveHold(valid);
    await owner.release();
  });
});
