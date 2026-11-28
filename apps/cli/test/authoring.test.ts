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
import { encodeSchema, openBundle, openSchema } from "@ipab/bundle";
import { encodeSchemaCar } from "@ipab/bundle-builder";
import { IpfsStore } from "@ipab/ipfs-store";
import { importBundle, scaffoldFiles, writeCar } from "../src/authoring.js";
import { State } from "../src/state.js";
import { object } from "../src/errors.js";
import { cli, fixture } from "./helpers.js";

const definition = {
  schema: {
    type: "object",
    required: ["title"],
    properties: { title: { type: "string" } },
  },
  contentType: "application/json",
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
describe("bundle development CLI", { tags: ["release-e2e"] }, () => {
  let work: Awaited<ReturnType<typeof fixture>>;
  let source: string;
  beforeEach(async () => {
    work = await fixture();
    const config = join(work.root, "store.json");
    await writeFile(config, JSON.stringify(work.store.configuration));
    vi.stubEnv("TASK_CONTENT_CONFIG", config);
    source = join(work.root, "source");
    await mkdir(source);
    await writeFile(
      join(source, ".bundle.yaml"),
      stringify({
        title: "Note",
        entry: "data.json",
        type: ".bundle-type.yaml",
      }),
    );
    await writeFile(join(source, ".bundle-type.yaml"), stringify(definition));
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
      ["bundle", "build"],
      ["bundle", "inspect"],
      ["bundle", "import"],
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
      ["bundle", "import"],
      ["bundle", "unknown"],
      ["bundle", "build", source, "--output", "-"],
      ["bundle", "build", source, "--schema-only", "--schema-only"],
      ["bundle", "build", source, "--no-import", "--no-import"],
      ["bundle", "build", source, "-o", "a.car", "--output", "b.car"],
      ["bundle", "inspect", source, "--replace"],
      ["bundle", "import", source, "--replace"],
      ["bundle", "import", source, "extra.car"],
    ])
      expect((await cli(work.stateDir, args)).code).toBe(2);
  });
  it("builds a one-block type CAR without an actual entry or a reachable Store", async () => {
    const response = await cli(work.stateDir, [
      "--json",
      "--store-gateway",
      "http://127.0.0.1:1",
      "bundle",
      "build",
      join(source, ".bundle-type.yaml"),
      "--schema-only",
      "--no-import",
    ]);
    expect(response.code, response.err).toBe(0);
    expect(result(response.out)).toMatchObject({
      kind: "bundle-schema",
      output: join(source, "dist", "schema.car"),
    });
    const artifact = await car(join(source, "dist", "schema.car"));
    expect(artifact.blocks.size).toBe(1);
    const loaded = await openSchema(artifact.root, artifact);
    expect(loaded.type).toEqual(definition);
    expect(result(response.out).cid).toBe(artifact.root.toString());
    expect(result(response.out).bytes).toBe(
      (await readFile(join(source, "dist", "schema.car"))).length,
    );
    expect(existsSync(join(source, "data.json"))).toBe(false);
  });
  it("removes bundle init from help and rejects it before creating files", async () => {
    const help = await cli(work.stateDir, ["bundle", "--help"]);
    expect(help.out).not.toContain("bundle init");
    const target = join(work.root, "obsolete-init");
    for (const args of [
      ["bundle", "init", join(source, ".bundle.yaml"), target],
      ["bundle", "init", "--help"],
    ]) {
      const response = await cli(work.stateDir, args);
      expect(response.code).toBe(2);
      expect(response.out).toBe("");
    }
    expect(existsSync(target)).toBe(false);
  });
  it.each([
    "text/plain",
    "image/png",
    "application/cbor",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ])(
    "builds and inspects an opaque %s entry without a schema",
    async (contentType) => {
      const entry = { contentType };
      await writeFile(
        join(source, ".bundle.yaml"),
        stringify({
          title: "Opaque",
          entry: "payload",
          type: ".bundle-type.yaml",
        }),
      );
      await writeFile(join(source, ".bundle-type.yaml"), stringify(entry));
      const bytes = Buffer.from([0, 255, 128, 10]);
      await writeFile(join(source, "payload"), bytes);
      const built = await cli(work.stateDir, [
        "--json",
        "bundle",
        "build",
        source,
        "--no-import",
      ]);
      expect(built.code, built.err).toBe(0);
      expect(result(built.out).validation).toEqual({
        status: "unsupported",
        contentType,
      });
      const encoded = await car(String(result(built.out).output));
      const loaded = await openBundle(encoded.root, encoded);
      expect(loaded.manifest.entry).toBe("payload");
      expect(
        Buffer.from(
          await new Response(await loaded.readFile("payload")).arrayBuffer(),
        ),
      ).toEqual(bytes);
      const inspected = await cli(work.stateDir, [
        "--json",
        "bundle",
        "inspect",
        source,
      ]);
      expect(inspected.code, inspected.err).toBe(0);
      expect(result(inspected.out).type).toEqual(entry);
      expect(result(inspected.out).validation).toEqual({
        definition: "valid",
        storage: "verified",
        entry: {
          status: "unsupported",
          contentType,
        },
      });
      const fromCar = await cli(work.stateDir, [
        "--json",
        "bundle",
        "inspect",
        String(result(built.out).output),
      ]);
      expect(fromCar.code, fromCar.err).toBe(0);
      expect(result(fromCar.out).validation).toEqual(
        result(inspected.out).validation,
      );
      const human = await cli(work.stateDir, ["bundle", "inspect", source]);
      expect(human.code, human.err).toBe(0);
      expect(human.out).toContain("Entry validation: unsupported");
      const imported = await cli(work.stateDir, [
        "--json",
        "bundle",
        "import",
        String(result(built.out).output),
      ]);
      expect(imported.code, imported.err).toBe(0);
      expect(result(imported.out).validation).toEqual(
        result(built.out).validation,
      );
    },
  );
  it("validates a Draft 2020-12 entry schema and rejects malformed MIME strings", async () => {
    const entry = {
      contentType: "application/json",
      schema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "array",
        prefixItems: [{ type: "string" }],
        items: false,
        minItems: 1,
      },
    };
    await writeFile(join(source, ".bundle-type.yaml"), stringify(entry));
    await writeFile(join(source, "data.json"), '["valid"]');
    const valid = await cli(work.stateDir, [
      "bundle",
      "build",
      source,
      "--no-import",
    ]);
    expect(valid.code, valid.err).toBe(0);
    const inspected = await cli(work.stateDir, [
      "--json",
      "bundle",
      "inspect",
      source,
    ]);
    expect(result(inspected.out).validation).toMatchObject({
      entry: { status: "validated", contentType: "application/json" },
    });
    await writeFile(join(source, "data.json"), '["valid", "extra"]');
    const invalid = await cli(work.stateDir, [
      "bundle",
      "build",
      source,
      "--no-import",
      "--replace",
    ]);
    expect(invalid.code).toBe(1);
    expect(invalid.out).toBe("");
    await writeFile(
      join(source, ".bundle-type.yaml"),
      stringify({ contentType: "not a MIME type" }),
    );
    const malformed = await cli(work.stateDir, [
      "bundle",
      "build",
      source,
      "--schema-only",
      "--no-import",
    ]);
    expect(malformed.code).toBe(1);
    expect(malformed.out).toBe("");
  });
  it("keeps an absent schema distinct from explicit true without claiming entry validation for definitions", async () => {
    const ids: string[] = [];
    for (const schema of [undefined, true]) {
      await writeFile(
        join(source, ".bundle-type.yaml"),
        stringify({
          contentType: "image/png",
          ...(schema === undefined ? {} : { schema }),
        }),
      );
      const inspected = await cli(work.stateDir, [
        "--json",
        "bundle",
        "inspect",
        join(source, ".bundle-type.yaml"),
      ]);
      expect(inspected.code, inspected.err).toBe(0);
      ids.push(String(result(inspected.out).schemaCid));
      expect(result(inspected.out).validation).toEqual({
        definition: "valid",
        storage: "not-applicable",
        entry: null,
      });
    }
    expect(ids[0]).not.toBe(ids[1]);
  });
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
      JSON.stringify({ title: "Untitled" }),
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
      join(source, ".bundle-type.yaml"),
    ]);
    expect(standalone.code, standalone.err).toBe(0);
    expect(result(standalone.out)).toMatchObject({
      kind: "bundle-schema",
      sourceKind: "definition",
      type: definition,
    });
    expect(result(standalone.out)).not.toHaveProperty("manifest");
    const target = join(work.root, "new");
    await scaffoldFiles(
      target,
      new Map([
        [
          ".bundle.yaml",
          stringify({
            title: "Note",
            entry: "data.json",
            type: ".bundle-type.yaml",
          }),
        ],
        [".bundle-type.yaml", stringify(definition)],
        ["data.json", '{"title":"Untitled"}\n'],
      ]),
    );
    const directory = await cli(work.stateDir, [
      "--json",
      "bundle",
      "inspect",
      target,
    ]);
    expect(result(directory.out)).toMatchObject({
      sourceKind: "directory",
      cid: null,
      validation: { definition: "valid" },
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
        validation: { definition: "valid" },
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
  it("rejects ignored/invalid/missing entries and unsafe output replacement", async () => {
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
    for (const pattern of [
      "data.json\n",
      ".bundle.yaml\n",
      ".bundle-type.yaml\n",
    ]) {
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
    for (const file of [
      ".bundle.yaml",
      ".bundle-type.yaml",
      ".bundle-ignore",
      "data.json",
    ]) {
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
  it.each([false, true])(
    "defaults build to unpinned import, supports opting out and preserves CAR on Store failure (schema-only=%s)",
    async (schemaOnly) => {
      await writeFile(join(source, "data.json"), '{"title":"Valid"}');
      const blocks = new Map<string, Uint8Array>();
      const calls: string[] = [];
      const originalPut = Object.getOwnPropertyDescriptor(
        IpfsStore.prototype,
        "put",
      )!.value as IpfsStore["put"];
      const publications = vi
        .spyOn(IpfsStore.prototype, "put")
        .mockImplementation(async function (
          this: IpfsStore,
          cid,
          bytes,
          options,
        ) {
          calls.push(cid.toString());
          blocks.set(cid.toString(), Uint8Array.from(bytes));
          await originalPut.call(this, cid, bytes, options);
        });
      const upstream = vi
        .spyOn(globalThis, "fetch")
        .mockRejectedValue(new Error("upstream offline"));
      const args = [
        "--json",
        "bundle",
        "build",
        source,
        ...(schemaOnly ? ["--schema-only"] : []),
      ];
      const built = await cli(work.stateDir, [
        "--store-gateway",
        "http://127.0.0.1:1",
        ...args,
      ]);
      expect(built.code, built.err).toBe(0);
      expect(result(built.out).imported).toBe(true);
      const path = join(
        source,
        "dist",
        schemaOnly ? "schema.car" : "bundle.car",
      );
      const encoded = await car(path);
      expect(blocks).toEqual(encoded.blocks);
      expect(calls).toHaveLength(encoded.blocks.size);
      expect(upstream).not.toHaveBeenCalled();
      publications.mockRestore();
      const skipped = await cli(work.stateDir, [
        "--store-gateway",
        "http://127.0.0.1:1",
        ...args,
        "--replace",
        "--no-import",
      ]);
      expect(skipped.code, skipped.err).toBe(0);
      expect(result(skipped.out).imported).toBe(false);
      const original = await readFile(path);
      const failedPut = vi
        .spyOn(IpfsStore.prototype, "put")
        .mockRejectedValue(new Error("local publication failed"));
      const failed = await cli(work.stateDir, [
        "--store-gateway",
        "http://127.0.0.1:1",
        ...args,
        "--replace",
      ]);
      expect(failed.code).toBe(1);
      expect(failed.out).toBe("");
      expect(failed.err).toContain("CAR remains at");
      expect(failed.err).toContain("bundle import");
      expect(await readFile(path)).toEqual(original);
      failedPut.mockRestore();
      const imported = await cli(work.stateDir, ["bundle", "import", path]);
      expect(imported.code, imported.err).toBe(0);
      expect(work.store.pins()).toEqual([]);
    },
  );
  it.each([false, true])(
    "imports a self-contained CAR without pins, preserving its CID and bytes (schema-only=%s)",
    async (schemaOnly) => {
      await writeFile(
        join(source, "data.json"),
        JSON.stringify({ title: "Untitled" }),
      );
      const built = await cli(work.stateDir, [
        "--json",
        "bundle",
        "build",
        source,
        "--no-import",
        ...(schemaOnly ? ["--schema-only"] : []),
      ]);
      expect(built.code, built.err).toBe(0);
      const path = join(
        source,
        "dist",
        schemaOnly ? "schema.car" : "bundle.car",
      );
      const original = await readFile(path);
      const encoded = await car(path);
      const config = join(work.root, "store.json");
      await writeFile(config, JSON.stringify(work.store.configuration));
      vi.stubEnv("TASK_CONTENT_CONFIG", config);
      const imported = await cli(work.stateDir, [
        "--json",
        "bundle",
        "import",
        path,
      ]);
      expect(imported.code, imported.err).toBe(0);
      expect(result(imported.out)).toEqual({
        kind: "bundle-import",
        cid: encoded.root.toString(),
        schemaCid: result(built.out).schemaCid,
        source: path,
        blocks: encoded.blocks.size,
        bytes: original.length,
        validation: schemaOnly
          ? null
          : { status: "validated", contentType: "application/json" },
      });
      expect(imported.err).toContain("importing CAR");
      const repeated = await cli(work.stateDir, ["bundle", "import", path]);
      expect(repeated.code, repeated.err).toBe(0);
      expect(repeated.out).toContain(
        `Imported CID: ${encoded.root.toString()}`,
      );
      const reopened = new IpfsStore(work.store.configuration);
      try {
        for (const [cid, bytes] of encoded.blocks)
          expect(await reopened.block.get(cid)).toEqual(bytes);
        expect(reopened.pins()).toEqual([]);
      } finally {
        await reopened.close();
      }
      const inspected = await cli(work.stateDir, [
        "--json",
        "bundle",
        "inspect",
        encoded.root.toString(),
      ]);
      expect(inspected.code, inspected.err).toBe(0);
      expect(result(inspected.out)).toMatchObject({
        sourceKind: "cid",
        schemaCid: result(built.out).schemaCid,
      });
      expect(await readFile(path)).toEqual(original);
      const state = new State(work.stateDir);
      expect(state.registrations()).toEqual([]);
      expect(state.runs()).toEqual([]);
      expect(state.holds()).toEqual([]);
      state.close();
    },
  );
  it("rejects non-CAR inputs and missing DAG blocks before opening a Store", async () => {
    const getStore = vi.fn(() => Promise.resolve(work.store));
    const path = join(work.root, "incomplete.car");
    await symlink(join(source, ".bundle.yaml"), path);
    for (const input of [source, join(source, ".bundle.yaml"), path])
      await expect(importBundle(input, getStore)).rejects.toThrow(
        "regular .car",
      );
    await writeFile(join(source, "data.json"), '{"title":"Valid"}');
    await cli(work.stateDir, ["bundle", "build", source]);
    const encoded = await car(join(source, "dist", "bundle.car"));
    const block = {
      cid: encoded.root,
      bytes: encoded.blocks.get(encoded.root.toString())!,
    };
    const roots = [encoded.root];
    const writer = createWriter(
      new ArrayBuffer(headerLength({ roots }) + blockLength(block)),
      { roots },
    );
    writer.write(block);
    const incomplete = join(work.root, "missing-dag.car");
    await writeFile(incomplete, writer.close());
    await expect(importBundle(incomplete, getStore)).rejects.toThrow();
    expect(getStore).not.toHaveBeenCalled();
  });
  it("stops writes on cancellation and preserves existing content and pins", async () => {
    await writeFile(join(source, "data.json"), '{"title":"Valid"}');
    await cli(work.stateDir, ["bundle", "build", source]);
    const path = join(source, "dist", "bundle.car");
    const previous = await encodeSchema({
      ...definition,
      contentType: "application/yaml",
    });
    await work.store.put(previous.cid, previous.bytes);
    await work.store.retain("other-owner", [previous.cid.toString()]);
    await work.store.confirmRetained("other-owner", [previous.cid.toString()]);
    const controller = new AbortController();
    const original = work.store.put.bind(work.store);
    const put = vi
      .spyOn(work.store, "put")
      .mockImplementationOnce(async (...args) => {
        await original(...args);
        controller.abort(new Error("import cancelled"));
      });
    await expect(
      importBundle(path, () => Promise.resolve(work.store), {
        signal: controller.signal,
      }),
    ).rejects.toThrow("import cancelled");
    expect(work.store.pins()).toEqual([previous.cid.toString()]);
    expect(await work.store.block.get(previous.cid.toString())).toEqual(
      previous.bytes,
    );
    put.mockRejectedValueOnce(new Error("write failed"));
    await expect(
      importBundle(path, () => Promise.resolve(work.store)),
    ).rejects.toThrow("write failed");
  });
  it("imports locally with an offline gateway and reports write and close failures without emitting success", async () => {
    await cli(work.stateDir, ["bundle", "build", source, "--schema-only"]);
    const path = join(source, "dist", "schema.car");
    const upstream = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("upstream offline"));
    const unreachable = await cli(work.stateDir, [
      "--json",
      "--store-gateway",
      "http://127.0.0.1:1",
      "bundle",
      "import",
      path,
    ]);
    expect(unreachable.code).toBe(0);
    expect(result(unreachable.out).kind).toBe("bundle-import");
    expect(upstream).not.toHaveBeenCalled();
    const config = join(work.root, "store.json");
    await writeFile(config, JSON.stringify(work.store.configuration));
    vi.stubEnv("TASK_CONTENT_CONFIG", config);
    vi.spyOn(IpfsStore.prototype, "put").mockRejectedValueOnce(
      new Error("write failed"),
    );
    const unfinished = await cli(work.stateDir, [
      "--json",
      "bundle",
      "import",
      path,
    ]);
    expect(unfinished.code).toBe(1);
    expect(unfinished.out).toBe("");
    expect(unfinished.err).toContain("write failed");
    const descriptor: TypedPropertyDescriptor<IpfsStore["close"]> | undefined =
      Object.getOwnPropertyDescriptor(IpfsStore.prototype, "close");
    const original = descriptor?.value;
    if (!original) throw new Error("Missing Store close method.");
    vi.spyOn(IpfsStore.prototype, "close").mockImplementationOnce(
      async function (this: IpfsStore) {
        await original.call(this);
        throw new Error("close failed");
      },
    );
    const failed = await cli(work.stateDir, [
      "--json",
      "bundle",
      "import",
      path,
    ]);
    expect(failed.code).toBe(1);
    expect(failed.out).toBe("");
    expect(failed.err).toContain("close failed");
    const retry = await cli(work.stateDir, [
      "--json",
      "bundle",
      "import",
      path,
    ]);
    expect(retry.code, retry.err).toBe(0);
  });
  it("rejects corrupt, incomplete and multi-root CARs", async () => {
    const put = vi.spyOn(IpfsStore.prototype, "put");
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
    expect(
      (await cli(work.stateDir, ["bundle", "import", path])).err,
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
    expect(
      (await cli(work.stateDir, ["bundle", "import", path])).err,
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
    expect(
      (await cli(work.stateDir, ["bundle", "import", path])).err,
    ).toContain("missing block");
    await writeFile(path, Buffer.from([1, 2, 3]));
    expect((await cli(work.stateDir, ["bundle", "inspect", path])).code).toBe(
      1,
    );
    expect((await cli(work.stateDir, ["bundle", "import", path])).code).toBe(1);
    expect(put).not.toHaveBeenCalled();
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
        scaffoldFiles(
          target,
          new Map([
            [
              ".bundle.yaml",
              stringify({
                title: "Note",
                entry: "data.json",
                type: ".bundle-type.yaml",
              }),
            ],
            [".bundle-type.yaml", stringify(definition)],
            ["data.json", '{"title":"Untitled"}\n'],
          ]),
          {
            signal: controller.signal,
          },
        ),
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
        "init",
        "cancelled",
        target,
      ]);
      expect(response.code, response.err).toBe(exitCode);
      expect(response.out).toBe("");
      expect(existsSync(target)).toBe(false);
      expect(process.listenerCount(signal)).toBe(listeners);
    },
  );
  it("refuses symlink sources, non-file outputs and removed defaultValue", async () => {
    const linked = join(work.root, "linked");
    await symlink(source, linked, "junction");
    expect((await cli(work.stateDir, ["bundle", "build", linked])).code).toBe(
      1,
    );
    await writeFile(
      join(source, "data.json"),
      JSON.stringify({ title: "Untitled" }),
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
    await writeFile(
      join(source, ".bundle-type.yaml"),
      stringify({ ...definition, defaultValue: { title: "Untitled" } }),
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
    expect(invalid.err).toContain("Invalid bundle type definition");
  });
});
