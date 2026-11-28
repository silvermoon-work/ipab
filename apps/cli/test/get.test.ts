import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { IpfsStore, type IpfsStoreOptions } from "@ipab/ipfs-store";
import type * as StoreModule from "@ipab/ipfs-store";
import { jsonBundle, artifactType } from "../src/swarm.js";
import * as authoring from "../src/authoring.js";
import { cli } from "./helpers.js";

const ports = vi.hoisted(() => ({ store: undefined as IpfsStore | undefined }));
vi.mock("@ipab/ipfs-store", async () => {
  const actual = await vi.importActual<typeof StoreModule>("@ipab/ipfs-store");
  return {
    ...actual,
    IpfsStore: class extends actual.IpfsStore {
      constructor(options: IpfsStoreOptions) {
        super(options);
        if (ports.store) return ports.store;
      }
    },
  };
});

describe("get with a mocked content Store", { tags: ["mock"] }, () => {
  const noteType = {
    contentType: "application/json",
    schema: { type: "object" },
  } as const;
  let work: string, store: IpfsStore;
  const exports: string[] = [];
  beforeEach(async () => {
    await mkdir(resolve(".test-work"), { recursive: true });
    work = await mkdtemp(join(resolve(".test-work"), "get-mock-"));
    store = IpfsStore.fromClient({
      block: { get: () => Promise.reject(new Error("Missing mocked content")) },
    });
    ports.store = store;
    vi.spyOn(store, "close").mockResolvedValue(undefined);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    ports.store = undefined;
    await store.close();
    for (const directory of exports.splice(0))
      await rm(directory, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  });
  it("exports unique temporary directories with path-only stdout and JSON metadata", async () => {
    const payload = await jsonBundle(store, noteType, { text: "Temporary" });
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await cli(work, ["get", payload]);
      expect(result.code, result.err).toBe(0);
      exports.push(result.out);
      expect(isAbsolute(result.out)).toBe(true);
      expect(dirname(result.out)).toBe(await realpath(tmpdir()));
      expect(result.out).not.toContain("\n");
      expect(
        JSON.parse(await readFile(join(result.out, "entry.json"), "utf8")),
      ).toEqual({ text: "Temporary" });
    }
    expect(exports[0]).not.toBe(exports[1]);
    expect(existsSync(resolve(payload))).toBe(false);
    const result = await cli(work, ["--json", "get", payload]);
    expect(result.code, result.err).toBe(0);
    const downloaded = JSON.parse(result.out) as { directory: string };
    exports.push(downloaded.directory);
    expect(JSON.parse(result.out)).toEqual({
      targetCid: payload,
      cid: payload,
      directory: downloaded.directory,
    });
    await readFile(join(downloaded.directory, "entry.json"));
  });
  it("exports raw Artifacts to explicit directories containing spaces", async () => {
    const payload = await jsonBundle(store, noteType, {});
    const artifact = await jsonBundle(store, artifactType, {
      value: payload,
      timestamp: new Date().toISOString(),
    });
    const directory = join(work, "raw get");
    const result = await cli(work, ["get", "--raw", artifact, "-o", directory]);
    expect(result.code, result.err).toBe(0);
    expect(result.out).toBe(directory);
    expect(
      JSON.parse(await readFile(join(directory, "entry.json"), "utf8")),
    ).toMatchObject({ value: payload });
  });
  it("reports failures without stdout and removes a failed temporary export", async () => {
    for (const reference of [
      "not-a-cid",
      "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku",
    ]) {
      const result = await cli(work, ["get", reference]);
      expect(result.code).not.toBe(0);
      expect(result.out).toBe("");
      expect(result.err).toContain("Error:");
    }
    const payload = await jsonBundle(store, noteType, {});
    let directory = "";
    vi.spyOn(authoring, "scaffoldFiles").mockImplementation((target) => {
      directory = target;
      return Promise.reject(new Error("Export write failed"));
    });
    const failed = await cli(work, ["get", payload]);
    expect(failed.code).toBe(1);
    expect(failed.out).toBe("");
    expect(failed.err).toContain("Export write failed");
    expect(isAbsolute(directory)).toBe(true);
    expect(existsSync(directory)).toBe(false);
  });
  it("does not print a successful result when Store close fails", async () => {
    const payload = await jsonBundle(store, noteType, {});
    vi.spyOn(store, "close").mockRejectedValueOnce(
      new Error("Store close failed"),
    );
    const result = await cli(work, [
      "get",
      payload,
      "-o",
      join(work, "close-failed"),
    ]);
    expect(result.code).toBe(1);
    expect(result.out).toBe("");
    expect(result.err).toContain("Store close failed");
  });
});
