import { describe, expect, it } from "vitest";
import { importer } from "ipfs-unixfs-importer";
import * as dagPb from "@ipld/dag-pb";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import {
  bundleLimits,
  canonicalJson,
  ContentBundleError,
  inspectSchemaBundle,
  openBundle,
  openSchemaBundle,
  parseBundleManifest,
  parseData,
  safePath,
  SCHEMA_PROFILE,
  validateContentBundle,
} from "../src/index.js";
import type { BundleLimits, JsonSchema } from "../src/index.js";

const text = (value: string) => new TextEncoder().encode(value);
const mainId = "urn:example:main";
const targetId = "https://example.test/types:target";
const manifest = (
  schema = "/schema",
  path = "data.json",
  contentType = "application/json",
) => canonicalJson({ entry: { schema, path, contentType } });
const json = (value: unknown) => canonicalJson(value);
function schemaFiles(
  schema: JsonSchema,
  extra: Record<string, unknown> = {},
  prefix = "schema/",
) {
  const definitions = {
    "main.json":
      typeof schema === "boolean"
        ? { $id: mainId, anyOf: [schema] }
        : { $id: mainId, ...schema },
    ...extra,
  };
  return Object.fromEntries([
    [`${prefix}.bundle.yaml`, manifest(SCHEMA_PROFILE, "schema.json")],
    [
      `${prefix}schema.json`,
      json({ schemas: Object.keys(definitions), main: mainId }),
    ],
    ...Object.entries(definitions).map(([path, value]) => [
      `${prefix}${path}`,
      json(value),
    ]),
  ]) as Record<string, Uint8Array>;
}
async function tree(files: Record<string, Uint8Array>) {
  const blocks = new Map<string, Uint8Array>();
  let root: CID | undefined;
  for await (const item of importer(
    Object.entries(files).map(([path, content]) => ({ path, content })),
    {
      put(cid, bytes) {
        if (!(bytes instanceof Uint8Array))
          throw new Error("Unexpected bytes.");
        blocks.set(cid.toString(), bytes);
        return Promise.resolve(cid);
      },
    },
    { cidVersion: 1, rawLeaves: true, wrapWithDirectory: true },
  ))
    root = item.cid;
  if (!root) throw new Error("Empty tree.");
  const calls: string[] = [];
  const resolveCid = (cid: CID, options: { signal?: AbortSignal } = {}) => {
    options.signal?.throwIfAborted();
    calls.push(cid.toString());
    const bytes = blocks.get(cid.toString());
    if (!bytes) throw new Error("Missing block.");
    return Promise.resolve(bytes);
  };
  return { root, blocks, resolveCid, calls };
}
async function fixture(
  schema: JsonSchema,
  value: unknown,
  files: Record<string, Uint8Array> = {},
  extra: Record<string, unknown> = {},
  type = "application/json",
) {
  return tree({
    ".bundle.yaml": manifest("/schema", "data.json", type),
    "data.json":
      type === "application/json" ? json(value) : text(String(value)),
    ...schemaFiles(schema, extra),
    ...files,
  });
}
async function read(stream: ReadableStream<Uint8Array>) {
  const parts: Uint8Array[] = [];
  for await (const part of stream) parts.push(part);
  const result = new Uint8Array(
    parts.reduce((sum, part) => sum + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}
describe("unified immutable Bundle runtime", () => {
  it("validates entire DAG, indexes exact embedded schema CID and streams unchanged attachments", async () => {
    const attachment = new Uint8Array(700_000).fill(17);
    const f = await fixture(
      {
        type: "object",
        required: ["name"],
        properties: { name: { type: "string" } },
      },
      { name: "example" },
      { "assets/photo.bin": attachment },
    );
    const bundle = await openBundle(f.root, f);
    expect(bundle.kind).toBe("content");
    expect(bundle.schemaKey).toBe(bundle.schemaBundle!.cid.toString());
    expect(bundle.schemaBundle!.descriptor.main).toBe(mainId);
    expect(
      parseData(
        await read(await bundle.readFile("data.json")),
        "application/json",
      ),
    ).toEqual({ name: "example" });
    const stream = await bundle.readFile("assets/photo.bin");
    const before = f.calls.length;
    const reader = stream.getReader();
    expect((await reader.read()).value?.length).toBeLessThanOrEqual(262_144);
    expect(f.calls.length).toBeGreaterThan(before);
    await reader.cancel();
    expect(await read(await bundle.readFile("assets/photo.bin"))).toEqual(
      attachment,
    );
    bundle.cid.bytes.fill(0);
    bundle.schemaBundle!.cid.bytes.fill(0);
    expect(bundle.cid.equals(f.root)).toBe(true);
    expect(bundle.schemaKey).toBe(bundle.schemaBundle!.cid.toString());
    await expect(bundle.readFile("../data.json")).rejects.toMatchObject({
      code: "PATH_INVALID",
    });
    await expect(bundle.readFile("missing")).rejects.toMatchObject({
      code: "CONTENT_UNAVAILABLE",
    });
    await expect(bundle.readFile("assets")).rejects.toMatchObject({
      code: "CONTENT_UNAVAILABLE",
    });
    await expect(openSchemaBundle(f.root, f)).rejects.toMatchObject({
      code: "SCHEMA_INVALID",
    });
    await expect(
      validateContentBundle(f.root, bundle.schemaBundle!, f),
    ).resolves.toHaveProperty("schemaKey", bundle.schemaKey);
    const other = await tree(schemaFiles({ type: "string" }, {}, ""));
    const otherSchema = await openSchemaBundle(other.root, other);
    await expect(
      validateContentBundle(f.root, otherSchema, f),
    ).rejects.toMatchObject({ code: "SCHEMA_INVALID" });
  });
  it.each([
    [true, null],
    [{ type: "array", items: { type: "integer" } }, [1, 2]],
    [{ type: "number" }, 1.25],
    [{ type: "boolean" }, true],
    [{ type: "null" }, null],
    [
      {
        type: "object",
        properties: { x: true },
        additionalProperties: { type: "string" },
      },
      { x: false, y: "yes" },
    ],
    [
      {
        type: "object",
        properties: { x: { enum: [{ a: [1] }, "b"], const: { a: [1] } } },
      },
      { x: { a: [1] } },
    ],
    [{ anyOf: [{ type: "string" }, { type: "integer" }] }, 3],
  ] satisfies [JsonSchema, unknown][])(
    "supports structural JSON semantics",
    async (schema, value) => {
      const f = await fixture(schema, value);
      await expect(openBundle(f.root, f)).resolves.toHaveProperty(
        "kind",
        "content",
      );
    },
  );
  it.each([
    [false, null],
    [{ type: "string" }, 2],
    [{ type: "integer" }, 2.3],
    [{ const: { a: 1 } }, { b: 1 }],
    [{ enum: [[1], 2] }, [2]],
    [{ type: "object", required: ["x"] }, {}],
    [{ additionalProperties: false }, { x: 1 }],
    [{ items: false }, [1]],
    [{ properties: { x: false } }, { x: 1 }],
    [{ anyOf: [false, { type: "string" }] }, 1],
  ] satisfies [JsonSchema, unknown][])(
    "rejects structurally invalid data",
    async (schema, value) => {
      const f = await fixture(schema, value);
      await expect(openBundle(f.root, f)).rejects.toMatchObject({
        code: "CONTENT_INVALID",
      });
    },
  );
  it("checks unused definitions, exact IDs, boolean children and productive recursion", async () => {
    const recursive = {
      type: "object",
      properties: { next: { $ref: mainId } },
      additionalProperties: false,
    };
    const f = await fixture(recursive, { next: { next: {} } });
    await expect(openBundle(f.root, f)).resolves.toHaveProperty(
      "kind",
      "content",
    );
    const unused = await fixture(
      {},
      {},
      {},
      { "unused.json": { $id: targetId, $ref: "urn:missing" } },
    );
    await expect(openBundle(unused.root, unused)).rejects.toMatchObject({
      code: "SCHEMA_INVALID",
    });
    const cycle = await fixture(
      { $ref: targetId },
      {},
      {},
      { "target.json": { $id: targetId, $ref: mainId } },
    );
    await expect(openBundle(cycle.root, cycle)).rejects.toMatchObject({
      code: "SCHEMA_INVALID",
    });
    const anyCycle = await fixture({ anyOf: [{ $ref: mainId }, true] }, {});
    await expect(openBundle(anyCycle.root, anyCycle)).rejects.toMatchObject({
      code: "SCHEMA_INVALID",
    });
  });
  it("uses the fixed profile only for complete Schema Bundles", async () => {
    const f = await tree(schemaFiles({ type: "object" }, {}, ""));
    const schema = await openSchemaBundle(f.root, f);
    expect(schema.schemaKey).toBe(SCHEMA_PROFILE);
    expect(schema.definitions.get(mainId)).toMatchObject({ $id: mainId });
    expect(await read(await schema.readFile("main.json"))).toEqual(
      json({ $id: mainId, type: "object" }),
    );
    await expect(
      validateContentBundle(f.root, schema, f),
    ).rejects.toMatchObject({ code: "SCHEMA_INVALID" });
    const bypass = await fixture(
      {},
      {},
      { ".bundle.yaml": manifest(SCHEMA_PROFILE) },
    );
    await expect(openBundle(bypass.root, bypass)).rejects.toMatchObject({
      code: "SCHEMA_INVALID",
    });
    const file = await fixture(
      {},
      {},
      { ".bundle.yaml": manifest("/data.json") },
    );
    await expect(openBundle(file.root, file)).rejects.toMatchObject({
      code: "REFERENCE_INVALID",
    });
    const ordinary = await fixture(
      {},
      {},
      {
        "schema/.bundle.yaml": manifest("/other"),
        "schema/data.json": json({}),
      },
    );
    await expect(openBundle(ordinary.root, ordinary)).rejects.toMatchObject({
      code: "SCHEMA_INVALID",
    });
  });
  it("reads YAML and complete JSONL entries through unions and full IDs", async () => {
    const yaml = await fixture(
      { type: "object" },
      "n: 2",
      {},
      {},
      "application/yaml",
    );
    await expect(openBundle(yaml.root, yaml)).resolves.toHaveProperty(
      "manifest",
    );
    const empty = await fixture(
      { $ref: targetId },
      "",
      {},
      { "target.json": { $id: targetId, type: "array" } },
      "application/jsonl",
    );
    await expect(openBundle(empty.root, empty)).resolves.toHaveProperty(
      "manifest",
    );
    const lines = await fixture(
      { $ref: targetId },
      "1\r\n2\r\n",
      {},
      {
        "target.json": {
          $id: targetId,
          anyOf: [false, { type: "array", items: { type: "integer" } }],
        },
      },
      "application/jsonl",
    );
    await expect(openBundle(lines.root, lines)).resolves.toHaveProperty(
      "kind",
      "content",
    );
  });
  it("preserves JSONL entry depth errors and their line context", async () => {
    const f = await fixture(
      { anyOf: [true, { type: "array" }] },
      `1\n${"[".repeat(65)}0${"]".repeat(65)}\n`,
      {},
      {},
      "application/jsonl",
    );
    await expect(openBundle(f.root, f)).rejects.toMatchObject({
      code: "LIMIT_EXCEEDED",
      path: "data.json",
      pointer: "/1",
      message: expect.stringContaining("JSONL line 2") as unknown,
    });
  });

  it("leaves dependency formats, paths and child contracts to the application", async () => {
    const f = await fixture(
      {
        type: "object",
        required: ["file", "missing", "child"],
        properties: {
          file: { type: "string" },
          missing: { anyOf: [{ type: "integer" }, { type: "string" }] },
          child: { type: "string" },
        },
      },
      {
        file: "json:/invalid.json",
        missing: "yaml:/../absent.yaml",
        child: "/child",
      },
      {
        "invalid.json": new Uint8Array(1024).fill(255),
        "child/.bundle.yaml": manifest(),
        "child/data.json": json("not an integer"),
        ...schemaFiles({ type: "integer" }, {}, "child/schema/"),
      },
    );
    const bundle = await openBundle(f.root, f);
    expect(await read(await bundle.readFile("invalid.json"))).toEqual(
      new Uint8Array(1024).fill(255),
    );
    expect(await read(await bundle.readFile("child/data.json"))).toEqual(
      json("not an integer"),
    );
    await expect(
      openBundle(f.root, { ...f, limits: { documentBytes: 128 } }),
    ).resolves.toHaveProperty("kind", "content");
  });
  it.each([true, "bundle", `file:${targetId}`])(
    "rejects removed x-content-ref rules %s",
    async (rule) => {
      const f = await fixture(
        { type: "string", "x-content-ref": rule },
        "json:/target.json",
        {},
        { "target.json": { $id: targetId } },
      );
      await expect(openBundle(f.root, f)).rejects.toMatchObject({
        code: "SCHEMA_INVALID",
        message: "Unsupported schema keyword x-content-ref.",
      });
    },
  );
  it("preserves unavailable, corrupt and cancellation failures and checks opaque storage", async () => {
    const f = await fixture(
      {},
      {},
      { "opaque.bin": new Uint8Array(600_000).fill(19) },
    );
    const attachment = [...f.blocks].find(
      ([, bytes]) => bytes.length === 262_144,
    )!;
    f.blocks.delete(attachment[0]);
    await expect(openBundle(f.root, f)).rejects.toMatchObject({
      code: "CONTENT_UNAVAILABLE",
    });
    const corrupt = await fixture({}, {});
    corrupt.blocks.get(corrupt.root.toString())!.fill(0);
    await expect(openBundle(corrupt.root, corrupt)).rejects.toMatchObject({
      code: "CONTENT_UNAVAILABLE",
    });
    const fresh = await fixture({}, {});
    const abort = new AbortController();
    abort.abort(new Error("cancelled"));
    await expect(
      openBundle(fresh.root, { ...fresh, signal: abort.signal }),
    ).rejects.toMatchObject({ code: "ABORTED" });
    const valid = await openBundle(fresh.root, fresh);
    await expect(
      valid.readFile("data.json", { signal: abort.signal }),
    ).rejects.toMatchObject({ code: "ABORTED" });
    const during = new AbortController();
    const stream = await valid.readFile("data.json", { signal: during.signal });
    during.abort(new Error("during read"));
    await expect(read(stream)).rejects.toMatchObject({ code: "ABORTED" });
  });
  it("rejects non-directory roots and invalid UnixFS descendants", async () => {
    const f = await fixture({}, {});
    const raw = CID.parse(
      [...f.blocks].find(([, bytes]) => bytes[0] === 123)![0],
    );
    if (raw.code === 0x55)
      await expect(openBundle(raw, f)).rejects.toMatchObject({
        code: "CONTENT_INVALID",
      });
    const bytes = dagPb.encode(
      dagPb.prepare({ Data: Uint8Array.of(255), Links: [] }),
    );
    const cid = CID.createV1(dagPb.code, await sha256.digest(bytes));
    f.blocks.set(cid.toString(), bytes);
    await expect(openBundle(cid, f)).rejects.toMatchObject({
      code: "CONTENT_UNAVAILABLE",
    });
  });
  it.each([
    "bytes",
    "blocks",
    "blockBytes",
    "parsingBytes",
    "files",
    "depth",
    "jsonDepth",
    "validationDepth",
    "manifestBytes",
    "descriptorBytes",
    "schemaBytes",
    "documentBytes",
    "schemas",
    "nodes",
  ] satisfies (keyof BundleLimits)[])(
    "shares and enforces the %s budget",
    async (key) => {
      const f = await fixture(
        {
          properties: {
            x: {
              anyOf: [{ $ref: targetId }],
            },
          },
        },
        { x: "json:/extra.json" },
        { "extra.json": json(2) },
        { "target.json": { $id: targetId } },
      );
      await expect(
        openBundle(f.root, { ...f, limits: { [key]: 1 } }),
      ).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
    },
  );
  it.each([0, -1, 1.2, Number.MAX_SAFE_INTEGER + 1, Infinity])(
    "rejects invalid budget overrides",
    async (bytes) => {
      const f = await fixture({}, {});
      await expect(
        openBundle(f.root, { ...f, limits: { bytes } }),
      ).rejects.toMatchObject({ code: "OPTIONS_INVALID" });
    },
  );
  it("accepts explicit larger parsing limits and rejects unknown options", async () => {
    const f = await fixture({}, {});
    await expect(
      openBundle(f.root, {
        ...f,
        limits: { schemaBytes: bundleLimits.schemaBytes + 1 },
      }),
    ).resolves.toHaveProperty("kind");
    await expect(
      openBundle(f.root, {
        ...f,
        limits: { unknown: 1 } as Partial<BundleLimits>,
      }),
    ).rejects.toMatchObject({ code: "OPTIONS_INVALID" });
    await expect(
      openBundle(f.root, { resolveCid: null } as unknown as Parameters<
        typeof openBundle
      >[1]),
    ).rejects.toMatchObject({ code: "OPTIONS_INVALID" });
  });
});
describe("closed schema profile and safe parsing", () => {
  const inspect = (schema: unknown) =>
    inspectSchemaBundle(
      { schemas: ["main.json"], main: mainId },
      new Map([["main.json", { $id: mainId, ...(schema as object) }]]),
    );
  it.each([
    { pattern: "x" },
    { $defs: {} },
    { $schema: "https://json-schema.org/schema" },
    { type: ["string"] },
    { type: "unknown" },
    { oneOf: [true] },
    { allOf: [true] },
    { examples: [] },
    { default: 1 },
    { properties: { x: { $id: targetId } } },
    { properties: [] },
    { items: [] },
    { required: ["x", "x"] },
    { required: [1] },
    { required: "x" },
    { anyOf: [] },
    { anyOf: true },
    { enum: [] },
    { enum: [1, 1] },
    { title: 2 },
    { description: null },
    { $ref: "#/properties/a" },
    { $ref: "relative" },
    { $ref: "urn:bad%ZZ" },
    { $ref: "urn:未编码" },
    { $ref: `${mainId}#fragment` },
    { $ref: targetId },
    { "x-content-ref": true, type: "string" },
    { "x-content-ref": `file:${mainId}`, type: "string" },
    { "x-content-ref": "bundle", type: "string" },
    { "x-content-ref": "file:relative", type: "string" },
    { "x-content-ref": "unknown", type: "string" },
    { additionalProperties: null },
  ])("rejects unsupported or malformed schema nodes", (schema) => {
    expect(() => inspect(schema)).toThrow(ContentBundleError);
  });
  it("does not inspect enum/const data or property names as schema keywords", () => {
    expect(
      inspect({
        title: "t",
        description: "d",
        properties: { $defs: true, pattern: false },
        enum: [{ $defs: 1 }],
        const: { $schema: "annotation-data" },
        additionalProperties: true,
      }),
    ).toHaveProperty("descriptor.main", mainId);
    expect(() =>
      inspectSchemaBundle(
        { schemas: ["a", "b"], main: mainId },
        new Map([
          ["a", { $id: mainId }],
          ["b", { $id: mainId }],
        ]),
      ),
    ).toThrow("Duplicate schema ID");
    expect(() =>
      inspectSchemaBundle(
        { schemas: ["a", "a"], main: mainId },
        new Map([["a", { $id: mainId }]]),
      ),
    ).toThrow("Duplicate schema file");
    expect(() =>
      inspectSchemaBundle(
        { schemas: ["a"], main: targetId },
        new Map([["a", { $id: mainId }]]),
      ),
    ).toThrow("main");
    expect(() =>
      inspectSchemaBundle(
        { schemas: ["a"], main: mainId, title: 2 },
        new Map(),
      ),
    ).toThrow("title");
    expect(() =>
      inspectSchemaBundle({ schemas: [1], main: mainId }, new Map()),
    ).toThrow();
    expect(() =>
      inspectSchemaBundle(
        { schemas: ["a"], main: mainId },
        new Map([["a", true]]),
      ),
    ).toThrow("$id");
    expect(() =>
      inspectSchemaBundle(
        { schemas: ["a"], main: mainId },
        new Map([["a", { $id: "relative" }]]),
      ),
    ).toThrow("$id");
    expect(() =>
      inspectSchemaBundle({ schemas: ["a", "b"], main: mainId }, new Map(), {
        schemas: 1,
      }),
    ).toThrow("count");
    expect(() =>
      inspectSchemaBundle(
        { schemas: ["a"], main: mainId },
        new Map([
          [
            "a",
            { $id: mainId, properties: { x: { properties: { y: true } } } },
          ],
        ]),
        { depth: 1 },
      ),
    ).toThrow("depth");
  });
  it("bounds reference-only chains in unused definitions and validates helper overrides", () => {
    const files = new Map<string, unknown>([
      ["a", { $id: "urn:a", $ref: "urn:b" }],
      ["b", { $id: "urn:b", $ref: "urn:c" }],
      ["c", { $id: "urn:c", $ref: "urn:d" }],
      ["d", { $id: "urn:d" }],
    ]);
    const descriptor = { schemas: [...files.keys()], main: "urn:d" };
    expect(() => inspectSchemaBundle(descriptor, files, { depth: 2 })).toThrow(
      "reference depth",
    );
    expect(() => inspectSchemaBundle(descriptor, files, { depth: 0 })).toThrow(
      "positive",
    );
    expect(() =>
      inspectSchemaBundle(descriptor, files, { depth: NaN }),
    ).toThrow("positive");
    expect(() =>
      inspectSchemaBundle(descriptor, files, {
        unknown: 1,
      } as unknown as Parameters<typeof inspectSchemaBundle>[2]),
    ).toThrow("positive");
    expect(
      inspectSchemaBundle(
        { schemas: ["a"], main: "urn:name%20encoded" },
        new Map([["a", { $id: "urn:name%20encoded" }]]),
      ),
    ).toHaveProperty("descriptor.main", "urn:name%20encoded");
  });
  it.each([
    "",
    "/x",
    "../x",
    "x//y",
    "x\\y",
    "x%20",
    "x:y",
    "x?y",
    "x#y",
    "x\u0000y",
    "x\u007fy",
    "\uD800",
    "x".repeat(1025),
  ])("rejects unsafe paths", (path) => {
    expect(() => safePath(path)).toThrow();
  });
  it("rejects the old manifest, external schema URIs and root escapes", () => {
    for (const entry of [
      { path: "x", schemaCid: "old", contentType: "application/json" },
      { path: "x", schema: "ipfs://cid", contentType: "application/json" },
      { path: "x", schema: "/", contentType: "application/json" },
      { path: "x", schema: "/../schema", contentType: "application/json" },
      { path: 2, schema: "/schema", contentType: "application/json" },
      { path: "x", schema: "/schema", contentType: "text/plain" },
    ])
      expect(() => parseBundleManifest(json({ entry }))).toThrow(
        "Invalid .bundle.yaml",
      );
    expect(() => parseBundleManifest(text("entry: {}\nextra: true"))).toThrow();
    expect(() => parseBundleManifest(text("entry: {}"), 1)).toThrow("manifest");
  });
  it("enforces duplicate keys, Unicode, finite safe JSON and deterministic JCS", () => {
    expect(
      new TextDecoder().decode(
        canonicalJson({ z: -0, a: [1e-7, 1e10], "\u20ac": "€", "\r": "line" }),
      ),
    ).toBe('{"\\r":"line","a":[1e-7,10000000000],"z":0,"€":"€"}');
    expect(() => canonicalJson({ x: "\uD800" })).toThrow("surrogate");
    expect(() => canonicalJson({ "\uDC00": "x" })).toThrow("surrogate");
    expect(() => canonicalJson({ x: Infinity })).toThrow("finite");
    const cycle: Record<string, unknown> = {};
    cycle.x = cycle;
    expect(() => canonicalJson(cycle)).toThrow("acyclic");
    expect(() => canonicalJson(new Date())).toThrow();
    expect(() => canonicalJson(undefined)).toThrow();
    expect(() => canonicalJson(new Array(2))).toThrow("dense");
    expect(() => canonicalJson({}, NaN)).toThrow("positive");
    expect(() =>
      parseData(text("{}"), "application/json", 100, Infinity),
    ).toThrow("positive");
    for (const source of [
      '{"a":1,"a":2}',
      '{"a":{"x":1,"x":2}}',
      '{"a":}',
      "[1,]",
      "true false",
      '"unterminated',
      '{"x" 1}',
      '{"x":1 "y":2}',
      "01",
      "1e999",
      "9007199254740992",
      '"\\ud800"',
    ])
      expect(() => parseData(text(source), "application/json")).toThrow();
    expect(
      parseData(
        text('{"__proto__":{"x":1},"a":[true,null,"x",-1.5]}'),
        "application/json",
      ),
    ).toEqual({ ["__proto__"]: { x: 1 }, a: [true, null, "x", -1.5] });
    expect(() => parseData(text("[[[]]]"), "application/json", 100, 1)).toThrow(
      "depth",
    );
    expect(() => parseData(text("[1,2]"), "application/json", 1)).toThrow(
      "limits",
    );
    expect(() => parseData(text("1\nbad\n"), "application/jsonl")).toThrow(
      "line 2",
    );
    expect(() => parseData(Uint8Array.of(255), "application/json")).toThrow(
      "UTF-8",
    );
    expect(() => parseData(text("a: 1\na: 2"), "application/yaml")).toThrow();
    expect(() =>
      parseData(text("a: 1\n---\nb: 2"), "application/yaml"),
    ).toThrow("one YAML");
    expect(() =>
      parseData(
        text(`${"[".repeat(66)}0${"]".repeat(66)}`),
        "application/yaml",
      ),
    ).toThrow("depth");
    expect(() => parseData(text("a: 1"), "application/yaml", 1)).toThrow(
      "node",
    );
    expect(parseData(text('"a\\"b"'), "application/json")).toBe('a"b');
  });
});
