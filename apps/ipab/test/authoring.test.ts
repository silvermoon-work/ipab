import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stringify } from "yaml";
import { CarBlockIterator } from "@ipld/car/iterator";
import {
  createWriter,
  headerLength,
  blockLength,
} from "@ipld/car/buffer-writer";
import type { CID } from "multiformats/cid";
import { encodeSchema, openBundle, openSchema, parseData } from "@ipab/bundle";
import { encodeSchemaCar } from "@ipab/bundle-builder";
import { IpfsStore } from "@ipab/ipfs-store";
import { initBundle, writeCar } from "../src/authoring.js";
import { State } from "../src/state.js";
import { object } from "../src/errors.js";
import { cli, fixture } from "./helpers.js";

const definition = {
  name: "Note",
  entry: {
    path: "data.json",
    schema: {
      type: "object",
      required: ["title"],
      properties: { title: { type: "string" } },
    },
    contentType: "application/json",
    defaultValue: { title: "Untitled" },
  },
};
async function car(path: string) {
  const bytes = await readFile(path);
  const iterator = await CarBlockIterator.fromIterable(
    ReadableStream.from([bytes]),
  );
  const roots = await iterator.getRoots();
  const blocks = new Map<string, Uint8Array>();
  for await (const block of iterator)
    blocks.set(block.cid.toString(), block.bytes);
  return {
    root: roots[0]!,
    blocks,
    resolveCid: (cid: CID) => {
      const bytes = blocks.get(cid.toString());
      if (!bytes) throw new Error("Missing test block.");
      return Promise.resolve(bytes);
    },
  };
}
describe("bundle development CLI", () => {
  let work: Awaited<ReturnType<typeof fixture>>;
  let source: string;
  beforeEach(async () => {
    work = await fixture();
    source = join(work.root, "source");
    await mkdir(source);
    await writeFile(join(source, ".bundle.yaml"), stringify(definition));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await work.cleanup();
  });
  const result = (out: string) =>
    object(JSON.parse(out) as unknown, "CLI result");
  it("discovers all commands and rejects bad syntax before Store access", async () => {
    for (const path of [
      [],
      ["bundle"],
      ["bundle", "init"],
      ["bundle", "build"],
      ["bundle", "inspect"],
    ]) {
      const response = await cli(work.stateDir, [...path, "--help"]);
      expect(response.code).toBe(0);
      expect(response.out).toContain(
        path.length > 1 ? path.join(" ") : "bundle",
      );
    }
    for (const args of [
      ["bundle", "build"],
      ["bundle", "init", source],
      ["bundle", "inspect"],
      ["bundle", "unknown"],
      ["bundle", "build", source, "--output", "-"],
      ["bundle", "build", source, "--schema-only", "--schema-only"],
      ["bundle", "build", source, "-o", "a.car", "--output", "b.car"],
      ["bundle", "inspect", source, "--replace"],
    ])
      expect((await cli(work.stateDir, args)).code).toBe(2);
  });
  it("builds a one-block type CAR without an actual entry or a reachable Store", async () => {
    const response = await cli(work.stateDir, [
      "--json",
      "--store-rpc",
      "http://127.0.0.1:1",
      "bundle",
      "build",
      join(source, ".bundle.yaml"),
      "--schema-only",
    ]);
    expect(response.code, response.err).toBe(0);
    expect(result(response.out)).toMatchObject({
      kind: "bundle-schema",
      output: join(source, "dist", "schema.car"),
    });
    const artifact = await car(join(source, "dist", "schema.car"));
    expect(artifact.blocks.size).toBe(1);
    const loaded = await openSchema(artifact.root, artifact);
    expect(loaded.manifest).toEqual({ ...definition, description: "" });
    expect(result(response.out).cid).toBe(artifact.root.toString());
    expect(result(response.out).bytes).toBe(
      (await readFile(join(source, "dist", "schema.car"))).length,
    );
    expect(existsSync(join(source, "data.json"))).toBe(false);
  });
  it.each([
    "application/json",
    "application/yaml",
    "application/jsonl",
  ] as const)(
    "initializes %s from a local type CAR and validates the generated entry",
    async (contentType) => {
      const value =
        contentType === "application/jsonl"
          ? [{ title: "First" }, { title: "Second" }]
          : { title: "Untitled" };
      const schema =
        contentType === "application/jsonl"
          ? { type: "array", items: definition.entry.schema }
          : definition.entry.schema;
      const path =
        contentType === "application/jsonl"
          ? "nested/events.jsonl"
          : "nested/data";
      const input = {
        ...definition,
        entry: { path, schema, contentType, defaultValue: value },
      };
      await writeFile(join(source, ".bundle.yaml"), stringify(input));
      expect(
        (await cli(work.stateDir, ["bundle", "build", source, "--schema-only"]))
          .code,
      ).toBe(0);
      const directory = join(work.root, "initialized");
      await mkdir(directory);
      const response = await cli(work.stateDir, [
        "--json",
        "bundle",
        "init",
        join(source, "dist", "schema.car"),
        directory,
      ]);
      expect(response.code, response.err).toBe(0);
      expect(result(response.out)).toMatchObject({
        kind: "bundle-init",
        directory,
        entry: { path, contentType },
      });
      expect(await readFile(join(directory, ".bundle-ignore"), "utf8")).toBe(
        "/dist/\n",
      );
      expect(
        parseData(
          await readFile(join(directory, ...path.split("/"))),
          contentType,
        ),
      ).toEqual(value);
      expect(
        (await cli(work.stateDir, ["bundle", "build", directory])).code,
      ).toBe(0);
      const built = await car(join(directory, "dist", "bundle.car"));
      expect((await openBundle(built.root, built)).schemaKey).toBe(
        result(response.out).schemaCid,
      );
    },
  );
  it("filters ignored dependencies, preserves intentional CAR resources and produces stable repeated roots", async () => {
    await writeFile(
      join(source, "data.json"),
      JSON.stringify({ title: "Actual" }),
    );
    await writeFile(
      join(source, ".bundle-ignore"),
      "/dist/\n/node_modules/\n*.tmp\nassets/*.bin\n!assets/keep.bin\n",
    );
    await mkdir(join(source, "assets"));
    await mkdir(join(source, "node_modules"));
    await symlink(
      join(work.root, "blocks"),
      join(source, "node_modules", "linked"),
      "junction",
    );
    await writeFile(join(source, "assets", "keep.bin"), Buffer.from([0, 255]));
    await writeFile(join(source, "assets", "other.bin"), "excluded");
    await writeFile(join(source, "extra.car"), "intentional opaque resource");
    await writeFile(join(source, "private.tmp"), "excluded");
    const first = await cli(work.stateDir, [
      "--json",
      "bundle",
      "build",
      source,
    ]);
    expect(first.code, first.err).toBe(0);
    const decoded = await car(join(source, "dist", "bundle.car"));
    const bundle = await openBundle(decoded.root, decoded);
    expect(decoded.blocks.get(bundle.schemaKey)).toEqual(bundle.schema.bytes);
    const resource = await bundle.readFile("extra.car");
    expect(resource).toBeInstanceOf(ReadableStream);
    await resource.cancel();
    for (const path of [
      ".bundle-ignore",
      "private.tmp",
      "assets/other.bin",
      "dist/bundle.car",
    ])
      await expect(bundle.readFile(path)).rejects.toMatchObject({
        code: "CONTENT_UNAVAILABLE",
      });
    const second = await cli(work.stateDir, [
      "--json",
      "bundle",
      "build",
      source,
      "--replace",
    ]);
    expect(second.code, second.err).toBe(0);
    expect(result(second.out).cid).toBe(result(first.out).cid);
  });
  it("excludes the active default output directory even without an ignore file", async () => {
    await writeFile(
      join(source, "data.json"),
      JSON.stringify(definition.entry.defaultValue),
    );
    const first = await cli(work.stateDir, [
      "--json",
      "bundle",
      "build",
      source,
    ]);
    const second = await cli(work.stateDir, [
      "--json",
      "bundle",
      "build",
      source,
      "--replace",
    ]);
    expect(first.code, first.err).toBe(0);
    expect(second.code, second.err).toBe(0);
    expect(result(second.out).cid).toBe(result(first.out).cid);
  });
  it("inspects local definitions, directories and both CAR roots without writing or executing Apps", async () => {
    const standalone = await cli(work.stateDir, [
      "--json",
      "bundle",
      "inspect",
      join(source, ".bundle.yaml"),
    ]);
    expect(standalone.code, standalone.err).toBe(0);
    expect(result(standalone.out)).toMatchObject({
      kind: "bundle-schema",
      sourceKind: "definition",
      description: "",
    });
    const target = join(work.root, "new");
    expect(
      (
        await cli(work.stateDir, [
          "bundle",
          "init",
          join(source, ".bundle.yaml"),
          target,
        ])
      ).code,
    ).toBe(0);
    const directory = await cli(work.stateDir, [
      "--json",
      "bundle",
      "inspect",
      target,
    ]);
    expect(result(directory.out)).toMatchObject({
      sourceKind: "directory",
      cid: null,
      validation: { status: "valid" },
    });
    expect(existsSync(join(target, "dist"))).toBe(false);
    expect((await cli(work.stateDir, ["bundle", "build", target])).code).toBe(
      0,
    );
    expect(
      (await cli(work.stateDir, ["bundle", "build", target, "--schema-only"]))
        .code,
    ).toBe(0);
    for (const file of ["bundle.car", "schema.car"]) {
      const inspected = await cli(work.stateDir, [
        "--json",
        "bundle",
        "inspect",
        join(target, "dist", file),
      ]);
      expect(inspected.code, inspected.err).toBe(0);
      expect(result(inspected.out)).toMatchObject({
        sourceKind: "car",
        validation: { status: "valid" },
      });
    }
    const state = new State(work.stateDir);
    expect(state.runs()).toEqual([]);
    expect(state.holds()).toEqual([]);
    state.close();
  });
  it("shares output-directory configuration, task overrides and reset without rewriting ignore files", async () => {
    expect(
      (
        await cli(work.stateDir, [
          "config",
          "set",
          "bundle.outputDir",
          "artifacts",
        ])
      ).code,
    ).toBe(0);
    const response = await cli(work.stateDir, [
      "--json",
      "bundle",
      "build",
      source,
      "--schema-only",
    ]);
    expect(result(response.out).output).toBe(
      join(source, "artifacts", "schema.car"),
    );
    const explicit = join(work.root, "explicit.car");
    expect(
      (
        await cli(work.stateDir, [
          "bundle",
          "build",
          source,
          "--schema-only",
          "-o",
          explicit,
        ])
      ).code,
    ).toBe(0);
    const environment = await cli(
      work.stateDir,
      ["--json", "bundle", "build", source, "--schema-only"],
      {
        env: { IPAB_BUNDLE_OUTPUT_DIR: "environment" },
      },
    );
    expect(result(environment.out).output).toBe(
      join(source, "environment", "schema.car"),
    );
    expect(
      (await cli(work.stateDir, ["config", "reset", "bundle.outputDir"])).code,
    ).toBe(0);
    expect(
      (await cli(work.stateDir, ["config", "set", "bundle.outputDir", ""]))
        .code,
    ).toBe(2);
  });
  it("rejects ignored/invalid/missing entries, nonempty init directories and unsafe output replacement", async () => {
    await writeFile(join(source, "data.json"), '{"title":1}');
    const invalid = await cli(work.stateDir, [
      "--json",
      "bundle",
      "build",
      source,
    ]);
    expect(invalid.code).toBe(1);
    expect(invalid.out).toBe("");
    expect(invalid.err).toContain("/title");
    expect(existsSync(join(source, "dist", "bundle.car"))).toBe(false);
    await writeFile(join(source, "data.json"), '{"title":"Valid"}');
    for (const pattern of ["data.json\n", ".bundle.yaml\n"]) {
      await writeFile(join(source, ".bundle-ignore"), pattern);
      const response = await cli(work.stateDir, ["bundle", "build", source]);
      expect(response.code).toBe(1);
      expect(response.err).toContain("excluded");
    }
    await writeFile(join(source, ".bundle-ignore"), "/dist/\n");
    const output = join(work.root, "output.car");
    await writeFile(output, "existing");
    const conflict = await cli(work.stateDir, [
      "bundle",
      "build",
      source,
      "--output",
      output,
    ]);
    expect(conflict.code).toBe(1);
    expect(await readFile(output, "utf8")).toBe("existing");
    for (const file of [".bundle.yaml", ".bundle-ignore", "data.json"]) {
      const before = await readFile(join(source, file));
      for (const mode of [[], ["--schema-only"]]) {
        const response = await cli(work.stateDir, [
          "bundle",
          "build",
          source,
          ...mode,
          "--replace",
          "--output",
          join(source, file),
        ]);
        expect(response.code).toBe(1);
        expect(await readFile(join(source, file))).toEqual(before);
      }
    }
    expect(
      (
        await cli(work.stateDir, [
          "bundle",
          "init",
          join(source, ".bundle.yaml"),
          source,
        ])
      ).code,
    ).toBe(1);
    expect(
      (
        await cli(work.stateDir, [
          "bundle",
          "build",
          join(source, ".bundle.yaml"),
        ])
      ).code,
    ).toBe(1);
    expect(
      (
        await cli(work.stateDir, [
          "bundle",
          "inspect",
          join(work.root, "missing"),
        ])
      ).code,
    ).toBe(1);
  });
  it("reads type CIDs through the existing Store and emits no success if Store cleanup fails", async () => {
    const schema = await encodeSchema(definition);
    await work.store.put(schema.cid, schema.bytes);
    const config = join(work.root, "store.json");
    await writeFile(config, JSON.stringify(work.store.configuration));
    vi.stubEnv("TASK_CONTENT_CONFIG", config);
    const env = { TASK_CONTENT_CONFIG: config };
    const inspected = await cli(
      work.stateDir,
      ["--json", "bundle", "inspect", schema.cid.toString()],
      { env },
    );
    expect(inspected.code, inspected.err).toBe(0);
    expect(result(inspected.out)).toMatchObject({
      sourceKind: "cid",
      schemaCid: schema.cid.toString(),
    });
    const directory = join(work.root, "cid-init");
    expect(
      (
        await cli(
          work.stateDir,
          ["bundle", "init", schema.cid.toString(), directory],
          { env },
        )
      ).code,
    ).toBe(0);
    const original = Object.getOwnPropertyDescriptor(
      IpfsStore.prototype,
      "close",
    )!.value as (this: IpfsStore) => Promise<void>;
    vi.spyOn(IpfsStore.prototype, "close").mockImplementationOnce(
      async function (this: IpfsStore) {
        await original.call(this);
        throw new Error("close failed");
      },
    );
    const failed = await cli(
      work.stateDir,
      ["--json", "bundle", "inspect", schema.cid.toString()],
      { env },
    );
    expect(failed.code).toBe(1);
    expect(failed.out).toBe("");
    expect(failed.err).toContain("close failed");
  });
  it("rejects corrupt, incomplete and multi-root CARs", async () => {
    const schema = await encodeSchema(definition);
    const path = join(work.root, "bad.car");
    const roots = [schema.cid, schema.cid];
    await writeFile(
      path,
      createWriter(new ArrayBuffer(headerLength({ roots })), { roots }).close(),
    );
    expect(
      (await cli(work.stateDir, ["bundle", "inspect", path])).err,
    ).toContain("exactly one root");
    const block = { cid: schema.cid, bytes: Uint8Array.of(255) };
    const writer = createWriter(
      new ArrayBuffer(
        headerLength({ roots: [schema.cid] }) + blockLength(block),
      ),
      { roots: [schema.cid] },
    );
    writer.write(block);
    await writeFile(path, writer.close());
    expect(
      (await cli(work.stateDir, ["bundle", "inspect", path])).err,
    ).toContain("Corrupt");
    await writeFile(
      path,
      createWriter(new ArrayBuffer(headerLength({ roots: [schema.cid] })), {
        roots: [schema.cid],
      }).close(),
    );
    expect(
      (await cli(work.stateDir, ["bundle", "inspect", path])).err,
    ).toContain("missing block");
    await writeFile(path, Buffer.from([1, 2, 3]));
    expect((await cli(work.stateDir, ["bundle", "inspect", path])).code).toBe(
      1,
    );
  });
  it("leaves old CARs intact and cleans owned temporary files when a stream fails or is cancelled", async () => {
    const output = join(work.root, "kept.car");
    await writeFile(output, "old artifact");
    const encoded = await encodeSchemaCar(definition);
    const broken = {
      ...encoded,
      stream: ReadableStream.from(
        (async function* () {
          await Promise.resolve();
          yield Uint8Array.of(1, 2);
          throw new Error("stream failed");
        })(),
      ),
    };
    await expect(writeCar(broken, output, true)).rejects.toThrow(
      "stream failed",
    );
    expect(await readFile(output, "utf8")).toBe("old artifact");
    expect(
      (await readdir(work.root)).filter((name) => name.startsWith(".ipab-")),
    ).toEqual([]);
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(
      writeCar(await encodeSchemaCar(definition), output, true, {
        signal: controller.signal,
      }),
    ).rejects.toThrow("cancelled");
  });
  it.each([false, true])(
    "rolls back cancelled init without deleting an existing empty target (%s)",
    async (existing) => {
      const target = join(work.root, "cancelled-init");
      if (existing) await mkdir(target);
      const controller = new AbortController();
      const original = controller.signal.throwIfAborted.bind(controller.signal);
      vi.spyOn(controller.signal, "throwIfAborted").mockImplementation(() => {
        if (existsSync(join(target, ".bundle.yaml")))
          controller.abort(new Error("cancel init"));
        original();
      });
      await expect(
        initBundle(join(source, ".bundle.yaml"), target, {
          signal: controller.signal,
        }),
      ).rejects.toThrow();
      expect(existsSync(target)).toBe(existing);
      if (existing) expect(await readdir(target)).toEqual([]);
    },
  );
  it.each([
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const)(
    "cancels CLI initialization on %s and removes signal handlers",
    async (signal, exitCode) => {
      const target = join(work.root, "signal-init");
      const listeners = process.listenerCount(signal);
      const original = Object.getOwnPropertyDescriptor(
        AbortSignal.prototype,
        "throwIfAborted",
      )!.value as (this: AbortSignal) => void;
      let sent = false;
      vi.spyOn(AbortSignal.prototype, "throwIfAborted").mockImplementation(
        function (this: AbortSignal) {
          if (!sent && existsSync(join(target, ".bundle.yaml"))) {
            sent = true;
            process.emit(signal);
          }
          original.call(this);
        },
      );
      const response = await cli(work.stateDir, [
        "--json",
        "bundle",
        "init",
        join(source, ".bundle.yaml"),
        target,
      ]);
      expect(response.code, response.err).toBe(exitCode);
      expect(response.out).toBe("");
      expect(existsSync(target)).toBe(false);
      expect(process.listenerCount(signal)).toBe(listeners);
    },
  );
  it("refuses symlink sources, non-file outputs, invalid defaults and content CAR initialization", async () => {
    const type = await encodeSchema(definition);
    await expect(
      initBundle(type.cid.toString(), join(work.root, "missing-store")),
    ).rejects.toThrow("configured Store");
    const linked = join(work.root, "linked");
    await symlink(source, linked, "junction");
    expect((await cli(work.stateDir, ["bundle", "build", linked])).code).toBe(
      1,
    );
    await writeFile(
      join(source, "data.json"),
      JSON.stringify(definition.entry.defaultValue),
    );
    const directory = await cli(work.stateDir, [
      "bundle",
      "build",
      source,
      "--output",
      source,
      "--replace",
    ]);
    expect(directory.code).toBe(1);
    expect(directory.err).toContain("regular artifact");
    expect((await cli(work.stateDir, ["bundle", "build", source])).code).toBe(
      0,
    );
    const content = await cli(work.stateDir, [
      "bundle",
      "init",
      join(source, "dist", "bundle.car"),
      join(work.root, "not-type"),
    ]);
    expect(content.code).toBe(1);
    expect(content.err).toContain("not a content bundle");
    await writeFile(
      join(source, ".bundle.yaml"),
      stringify({
        ...definition,
        entry: {
          ...definition.entry,
          path: "dist/data.json",
        },
      }),
    );
    const ignored = await cli(work.stateDir, [
      "bundle",
      "init",
      join(source, ".bundle.yaml"),
      join(work.root, "ignored-default"),
    ]);
    expect(ignored.code).toBe(1);
    expect(ignored.err).toContain("ignore rule");
    await writeFile(
      join(source, ".bundle.yaml"),
      stringify({
        ...definition,
        entry: {
          ...definition.entry,
          defaultValue: { title: 1 },
        },
      }),
    );
    const invalid = await cli(work.stateDir, [
      "--json",
      "bundle",
      "build",
      source,
      "--schema-only",
      "--replace",
    ]);
    expect(invalid.code).toBe(1);
    expect(invalid.out).toBe("");
    expect(invalid.err).toContain("defaultValue");
  });
});
