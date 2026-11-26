import { describe, expect, it } from "vitest";
import { importer } from "ipfs-unixfs-importer";
import * as dagPb from "@ipld/dag-pb";
import * as dagCbor from "@ipld/dag-cbor";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import {
  canonicalJson,
  declaresBundleSchema,
  ContentBundleError,
  encodeSchema,
  inspectSchema,
  inspectBundleSchema,
  openBundle,
  openSchema,
  parseBundleManifest,
  parseData,
  safePath,
  schemaBlockBytes,
  validateContentBundle,
  validateSchemaValue,
  schemaDialect,
} from "../src/index.js";
import type { BundleLimits, JsonSchema } from "../src/index.js";

it("recognizes schema declarations without treating arbitrary DAG-CBOR as a schema", () => {
  expect(declaresBundleSchema(dagCbor.encode({ entry: null }))).toBe(true);
  expect(
    declaresBundleSchema(dagCbor.encode({ name: "ordinary object" })),
  ).toBe(false);
  expect(declaresBundleSchema(dagCbor.encode([]))).toBe(false);
  expect(() => declaresBundleSchema(Uint8Array.of(0xff))).toThrow();
});

const text = (value: string) => new TextEncoder().encode(value);
const json = (value: unknown) => canonicalJson(value);
const definition = (
  schema: JsonSchema,
  path = "data.json",
  contentType = "application/json",
) => ({
  name: "Fixture",
  description: "",
  entry: { schema, path, contentType },
});
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
  return { root, blocks, calls, resolveCid };
}
async function fixture(
  schema: JsonSchema,
  value: unknown,
  files: Record<string, Uint8Array> = {},
  type = "application/json",
) {
  // Raw encoding lets the loader tests exercise malformed schemas too.
  const typeDefinition = definition(schema, "data.json", type);
  const bytes = dagCbor.encode(typeDefinition);
  const cid = CID.createV1(dagCbor.code, await sha256.digest(bytes));
  const f = await tree({
    ".bundle.yaml": json(typeDefinition),
    "data.json":
      type === "application/json" ? json(value) : text(String(value)),
    ...files,
  });
  f.blocks.set(cid.toString(), bytes);
  return { ...f, schemaCid: cid };
}
async function read(stream: ReadableStream<Uint8Array>) {
  const parts: Uint8Array[] = [];
  for await (const part of stream) parts.push(part);
  const bytes = new Uint8Array(
    parts.reduce((sum, part) => sum + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}
describe("single-block schemas and immutable content", () => {
  it.each([
    "image/png",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/cbor",
    'application/vnd.example+binary; version="1"',
  ])(
    "opens a single opaque %s entry without inventing semantic validation",
    async (contentType) => {
      const entry = Uint8Array.of(0, 255, 17, 128);
      for (const extra of [{}, { schema: false }]) {
        const manifest = {
          name: "Binary",
          entry: { path: "file.bin", contentType, ...extra },
        };
        const f = await tree({
          ".bundle.yaml": json(manifest),
          "file.bin": entry,
        });
        const bundle = await openBundle(f.root, f);
        expect(bundle.validation).toEqual({
          status: "unsupported",
          contentType,
        });
        expect(bundle.manifest.entry).toEqual(manifest.entry);
        expect(await read(await bundle.readFile("file.bin"))).toEqual(entry);
      }
    },
  );
  it("checks structured syntax even without a schema and keeps missing entries invalid", async () => {
    const manifest = {
      name: "JSON",
      entry: { path: "data.json", contentType: "application/json" },
    };
    const good = await tree({
      ".bundle.yaml": json(manifest),
      "data.json": text("{}"),
    });
    expect((await openBundle(good.root, good)).validation.status).toBe(
      "schema-absent",
    );
    const bad = await tree({
      ".bundle.yaml": json(manifest),
      "data.json": text("{"),
    });
    await expect(openBundle(bad.root, bad)).rejects.toMatchObject({
      code: "CONTENT_INVALID",
      path: "data.json",
    });
    const missing = await tree({ ".bundle.yaml": json(manifest) });
    await expect(openBundle(missing.root, missing)).rejects.toMatchObject({
      code: "CONTENT_UNAVAILABLE",
      path: "data.json",
    });
  });
  it("verifies the entire storage DAG, exact schema block and unchanged streaming attachments", async () => {
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
    expect(bundle.schemaKey).toBe(f.schemaCid.toString());
    expect(bundle.schema.cid.equals(f.schemaCid)).toBe(true);
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
    bundle.schema.cid.bytes.fill(0);
    bundle.schema.bytes.fill(0);
    expect(bundle.cid.equals(f.root)).toBe(true);
    expect(bundle.schema.cid.equals(f.schemaCid)).toBe(true);
    expect(bundle.schema.bytes).toEqual(
      Uint8Array.from(f.blocks.get(f.schemaCid.toString())!),
    );
    await expect(bundle.readFile("../data.json")).rejects.toMatchObject({
      code: "PATH_INVALID",
    });
    for (const path of ["missing", "assets"])
      await expect(bundle.readFile(path)).rejects.toMatchObject({
        code: "CONTENT_UNAVAILABLE",
      });
    await expect(openSchema(f.root, f)).rejects.toMatchObject({
      code: "SCHEMA_INVALID",
    });
    await expect(
      validateContentBundle(f.root, bundle.schema, f),
    ).resolves.toHaveProperty("schemaKey", bundle.schemaKey);
    await expect(
      validateContentBundle(
        f.root,
        await encodeSchema(definition({ type: "string" })),
        f,
      ),
    ).rejects.toMatchObject({ code: "SCHEMA_INVALID" });
  });
  it.each([
    [true, null],
    [{ type: "array", items: { type: "integer" } }, [1, 2]],
    [{ type: "number" }, 1.25],
    [{ type: "boolean" }, true],
    [{ type: "null" }, null],
    [
      { properties: { x: true }, additionalProperties: { type: "string" } },
      { x: false, y: "yes" },
    ],
    [
      { properties: { x: { enum: [{ a: [1] }, "b"], const: { a: [1] } } } },
      { x: { a: [1] } },
    ],
    [{ anyOf: [{ type: "string" }, { type: "integer" }] }, 3],
    [{ $defs: { "a/b~c": { type: "integer" } }, $ref: "#/$defs/a~1b~0c" }, 3],
  ] satisfies [JsonSchema, unknown][])(
    "supports structural semantics and local definitions",
    async (schema, value) => {
      const f = await fixture(schema, value);
      await expect(openBundle(f.root, f)).resolves.toHaveProperty(
        "kind",
        "content",
      );
    },
  );
  it.each([
    [{ type: "string" }, 2],
    [{ type: "integer" }, 2.3],
    [{ const: { a: 1 } }, { b: 1 }],
    [{ enum: [[1], 2] }, [2]],
    [{ required: ["x"] }, {}],
    [{ additionalProperties: false }, { x: 1 }],
    [{ items: false }, [1]],
    [{ properties: { x: false } }, { x: 1 }],
    [{ anyOf: [false, { type: "string" }] }, 1],
    [{ $defs: { n: { type: "integer" } }, $ref: "#/$defs/n" }, "3"],
  ] satisfies [JsonSchema, unknown][])(
    "rejects invalid entry data",
    async (schema, value) => {
      const f = await fixture(schema, value);
      await expect(openBundle(f.root, f)).rejects.toMatchObject({
        code: "CONTENT_INVALID",
        path: "data.json",
      });
    },
  );
  it("checks unused definitions and rejects nonproductive cycles while allowing recursive data", async () => {
    const recursive = await fixture(
      {
        type: "object",
        properties: { next: { $ref: "#" } },
        additionalProperties: false,
      },
      { next: { next: {} } },
    );
    await expect(openBundle(recursive.root, recursive)).resolves.toHaveProperty(
      "kind",
    );
    const nullable = await fixture(
      {
        anyOf: [
          { type: "null" },
          {
            type: "object",
            required: ["next"],
            properties: { next: { $ref: "#" } },
          },
        ],
      },
      { next: { next: null } },
    );
    await expect(openBundle(nullable.root, nullable)).resolves.toHaveProperty(
      "kind",
    );
    for (const schema of [
      { $defs: { unused: { $ref: "ipfs://outside" } } },
      { $defs: { a: { $ref: "#/$defs/b" }, b: { $ref: "#/$defs/a" } } },
      { anyOf: [{ $ref: "#" }, true] },
      {
        $defs: { data: { const: { type: "integer" } } },
        $ref: "#/$defs/data/const",
      },
    ]) {
      const f = await fixture(schema, {});
      await expect(openBundle(f.root, f)).rejects.toMatchObject({
        code: "SCHEMA_INVALID",
      });
    }
  });
  it("reads YAML and complete JSONL arrays through local references", async () => {
    for (const [schema, value, type] of [
      [{ type: "object" }, "n: 2", "application/yaml"],
      [{ type: "array" }, "", "application/jsonl"],
      [
        {
          $defs: {
            values: {
              anyOf: [false, { type: "array", items: { type: "integer" } }],
            },
          },
          $ref: "#/$defs/values",
        },
        "1\r\n2\r\n",
        "application/jsonl",
      ],
    ] satisfies [JsonSchema, string, string][]) {
      const f = await fixture(schema, value, {}, type);
      await expect(openBundle(f.root, f)).resolves.toHaveProperty("kind");
    }
    const deep = await fixture(
      {},
      `1\n${"[".repeat(65)}0${"]".repeat(65)}\n`,
      {},
      "application/jsonl",
    );
    await expect(openBundle(deep.root, deep)).rejects.toMatchObject({
      code: "LIMIT_EXCEEDED",
      path: "data.json",
      pointer: "/1",
      message: expect.stringContaining("JSONL line 2") as unknown,
    });
  });
  it("validates Markdown metadata while preserving the entry body and type identity", async () => {
    const manifest = definition(
      {
        type: "object",
        required: ["title"],
        properties: { title: { type: "string" } },
        additionalProperties: false,
      },
      "note.md",
      "text/markdown",
    );
    const type = await encodeSchema(manifest);
    const sources = [
      "---\r\ntitle: Note\r\n---\r\n# Body\r\ninvalid: [\r\n",
      "---\ntitle: Other\n---\n# Different body\n",
    ];
    const roots: string[] = [];
    for (const source of sources) {
      const f = await tree({
        ".bundle.yaml": json(manifest),
        "note.md": text(source),
      });
      const bundle = await openBundle(f.root, f);
      roots.push(bundle.cid.toString());
      expect(bundle.schemaKey).toBe(type.cid.toString());
      expect(await read(await bundle.readFile("note.md"))).toEqual(
        text(source),
      );
      await expect(
        openBundle(f.root, {
          ...f,
          limits: { documentBytes: text(source).byteLength - 1 },
        }),
      ).rejects.toMatchObject({ code: "LIMIT_EXCEEDED", path: "note.md" });
    }
    expect(roots[0]).not.toBe(roots[1]);
    for (const [source, pointer] of [
      ["# No metadata\n", ""],
      ["---\ntitle: 1\n---\n", "/title"],
    ] satisfies [string, string][]) {
      const f = await tree({
        ".bundle.yaml": json(manifest),
        "note.md": text(source),
      });
      await expect(openBundle(f.root, f)).rejects.toMatchObject({
        code: "CONTENT_INVALID",
        path: "note.md",
        pointer,
      });
    }
  });
  it("leaves dependencies and nested manifests opaque without fetching their schemas", async () => {
    const missing = await encodeSchema(definition({ type: "integer" }));
    const f = await fixture(
      {
        properties: {
          file: { type: "string" },
          missing: { type: "string" },
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
        "child/.bundle.yaml": json(missing.manifest),
        "child/data.json": json("not an integer"),
      },
    );
    const bundle = await openBundle(f.root, {
      ...f,
      limits: { documentBytes: 128 },
    });
    expect(f.calls).not.toContain(missing.cid.toString());
    expect(await read(await bundle.readFile("invalid.json"))).toEqual(
      new Uint8Array(1024).fill(255),
    );
    expect(await read(await bundle.readFile("child/data.json"))).toEqual(
      json("not an integer"),
    );
  });
  it("reports missing/corrupt schemas, malformed CBOR and noncanonical encoding", async () => {
    const f = await fixture({}, {});
    f.blocks.delete(f.schemaCid.toString());
    await expect(openSchema(f.schemaCid, f)).rejects.toMatchObject({
      code: "CONTENT_UNAVAILABLE",
    });
    await expect(openBundle(f.root, f)).resolves.toHaveProperty(
      "schemaKey",
      f.schemaCid.toString(),
    );
    const schema = await encodeSchema(definition({}));
    await expect(
      openSchema(schema.cid, {
        resolveCid: () => Promise.resolve(Uint8Array.of(255)),
      }),
    ).rejects.toMatchObject({ code: "CONTENT_UNAVAILABLE" });
    for (const bytes of [Uint8Array.of(255), Uint8Array.of(0x18, 0x00)]) {
      const cid = CID.createV1(dagCbor.code, await sha256.digest(bytes));
      await expect(
        openSchema(cid, { resolveCid: () => Promise.resolve(bytes) }),
      ).rejects.toMatchObject({ code: "SCHEMA_INVALID" });
    }
    // Omitted description must be normalized before the block is encoded.
    const bytes = dagCbor.encode({
      name: "Fixture",
      entry: definition({}).entry,
    });
    const cid = CID.createV1(dagCbor.code, await sha256.digest(bytes));
    await expect(
      openSchema(cid, { resolveCid: () => Promise.resolve(bytes) }),
    ).rejects.toMatchObject({
      code: "SCHEMA_INVALID",
      message: expect.stringContaining("canonical") as unknown,
    });
  });
  it("preserves opaque storage, corrupt root and cancellation failures", async () => {
    const f = await fixture(
      {},
      {},
      { "opaque.bin": new Uint8Array(600_000).fill(19) },
    );
    f.blocks.delete(
      [...f.blocks].find(([, bytes]) => bytes.length === 262_144)![0],
    );
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
    for (const opening of [
      openBundle(fresh.root, { ...fresh, signal: abort.signal }),
      openSchema(fresh.schemaCid, { ...fresh, signal: abort.signal }),
    ])
      await expect(opening).rejects.toMatchObject({ code: "ABORTED" });
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
    await expect(openBundle(f.schemaCid, f)).rejects.toMatchObject({
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
    "schemaBytes",
    "documentBytes",
    "nodes",
  ] satisfies (keyof BundleLimits)[])(
    "enforces the shared %s budget",
    async (key) => {
      const f = await fixture(
        { properties: { x: { anyOf: [{ type: "string" }] } } },
        { x: "entry" },
        { "nested/file": text("opaque") },
      );
      await expect(
        openBundle(f.root, { ...f, limits: { [key]: 1 } }),
      ).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
    },
  );
  it.each([0, -1, 1.2, Number.MAX_SAFE_INTEGER + 1, Infinity])(
    "rejects invalid limits",
    async (bytes) => {
      const f = await fixture({}, {});
      await expect(
        openBundle(f.root, { ...f, limits: { bytes } }),
      ).rejects.toMatchObject({ code: "OPTIONS_INVALID" });
    },
  );
  it("rejects removed budgets and invalid resolver options", async () => {
    const f = await fixture({}, {});
    for (const key of ["schemas", "descriptorBytes", "references", "unknown"])
      await expect(
        openBundle(f.root, {
          ...f,
          limits: { [key]: 1 },
        }),
      ).rejects.toMatchObject({ code: "OPTIONS_INVALID" });
    await expect(
      openBundle(f.root, { resolveCid: null } as unknown as Parameters<
        typeof openBundle
      >[1]),
    ).rejects.toMatchObject({ code: "OPTIONS_INVALID" });
  });
  it("canonicalizes object ordering without changing arrays, and enforces the exact encoded block boundary", async () => {
    const a = await encodeSchema(
      definition(
        inspectSchema(
          parseData(
            text('{"type":"string","enum":["z","a"]}'),
            "application/json",
          ),
        ).schema,
      ),
    );
    const b = await encodeSchema(
      definition({ enum: ["z", "a"], type: "string" }),
    );
    expect(a.cid.equals(b.cid)).toBe(true);
    expect(a.bytes).toEqual(b.bytes);
    expect(dagCbor.decode(a.bytes)).toEqual(
      definition({ enum: ["z", "a"], type: "string" }),
    );
    const changed = await encodeSchema(
      definition({ enum: ["a", "z"], type: "string" }),
    );
    expect(changed.cid.equals(a.cid)).toBe(false);
    const overhead =
      dagCbor.encode({
        ...definition(true),
        description: "x".repeat(schemaBlockBytes),
      }).length - schemaBlockBytes;
    const schema = {
      ...definition(true),
      description: "x".repeat(schemaBlockBytes - overhead),
    };
    const exact = await encodeSchema(schema);
    expect(exact.bytes.length).toBe(schemaBlockBytes);
    await expect(
      openSchema(exact.cid, { resolveCid: () => Promise.resolve(exact.bytes) }),
    ).resolves.toHaveProperty("cid");
    await expect(
      encodeSchema(
        { ...schema, description: `${schema.description}x` },
        { schemaBytes: schemaBlockBytes + 1 },
      ),
    ).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
    const oversized = dagCbor.encode({
      ...schema,
      description: `${schema.description}x`,
    });
    const cid = CID.createV1(dagCbor.code, await sha256.digest(oversized));
    await expect(
      openSchema(cid, {
        resolveCid: () => Promise.resolve(oversized),
        limits: { schemaBytes: schemaBlockBytes + 1 },
      }),
    ).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
    await expect(
      encodeSchema(schema, { schemaBytes: schemaBlockBytes - 1 }),
    ).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
    for (const limits of [
      { bytes: 1 },
      { parsingBytes: 1 },
      { blockBytes: 1 },
      { nodes: 1 },
    ])
      await expect(
        openSchema(a.cid, {
          resolveCid: () => Promise.resolve(a.bytes),
          limits,
        }),
      ).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
  });
});
describe("closed schema profile and safe parsing", () => {
  it("uses Draft 2020-12 constraints instead of the former structural subset", () => {
    const schema = inspectSchema({
      $schema: schemaDialect,
      type: "object",
      required: ["name", "values"],
      properties: {
        name: {
          type: "string",
          minLength: 1,
          maxLength: 10,
          pattern: "^[a-z]+$",
        },
        values: {
          type: "array",
          prefixItems: [{ type: "string" }],
          items: { type: "integer", minimum: 1 },
          minItems: 2,
          uniqueItems: true,
        },
        choice: { oneOf: [{ type: "string" }, { type: "number" }] },
      },
      unevaluatedProperties: false,
    });
    const validate = (value: unknown) => {
      validateSchemaValue(schema, value, { depth: 64, charge() {} });
    };
    expect(() => {
      validate({ name: "note", values: ["first", 1], choice: "x" });
    }).not.toThrow();
    for (const value of [
      { name: "", values: ["first", 1] },
      { name: "UPPER", values: ["first", 1] },
      { name: "note", values: ["first", 0] },
      { name: "note", values: ["first", 1, 1] },
      { name: "note", values: ["first", 1], extra: true },
    ])
      expect(() => {
        validate(value);
      }).toThrow(ContentBundleError);
  });
  it("keeps standard annotations inert, resolves local anchors, and bounds interpreted validation", () => {
    const schema = inspectSchema({
      $defs: {
        name: { $anchor: "name", type: ["string", "null"], minLength: 1 },
      },
      $ref: "#name",
      default: "unused",
      examples: ["example"],
      format: "email",
      "x-content-ref": "not a resource access",
    });
    expect(() => {
      validateSchemaValue(schema, "not-an-email", { depth: 64, charge() {} });
    }).not.toThrow();
    expect(() => {
      validateSchemaValue(schema, "", { depth: 64, charge() {} });
    }).toThrow(ContentBundleError);
    let work = 0;
    expect(() => {
      validateSchemaValue(schema, "name", {
        depth: 64,
        charge() {
          if (++work > 10)
            throw new ContentBundleError("LIMIT_EXCEEDED", "Work exceeded.");
        },
      });
    }).toThrow("Work exceeded");
  });
  it("resolves embedded schema resources without loading external references", () => {
    const schema = inspectSchema({
      $id: "https://example.test/root",
      $defs: {
        nested: {
          $id: "nested",
          $defs: { name: { type: "string", minLength: 1 } },
          $ref: "#/$defs/name",
        },
      },
      $ref: "nested",
    });
    expect(() => {
      validateSchemaValue(schema, "note", { depth: 64, charge() {} });
    }).not.toThrow();
    expect(() => {
      validateSchemaValue(schema, "", { depth: 64, charge() {} });
    }).toThrow(ContentBundleError);
    expect(() =>
      inspectSchema({ $ref: "https://example.test/external" }),
    ).toThrow("external loading is disabled");
    expect(() => inspectSchema({ pattern: "[" })).toThrow("regular expression");
    expect(() =>
      inspectSchema({
        $vocabulary: { "https://example.test/vocab": true },
      }),
    ).toThrow("Unsupported required");
  });
  it.each([
    ["---\ntitle: Note\n---\n# Body\ninvalid: [", { title: "Note" }],
    ["---\r\ntitle: Note\r\n---\r\n# Body\r\n", { title: "Note" }],
    ["---\ntitle: Note\n---", { title: "Note" }],
    ["# No frontmatter\n---\ntitle: body\n---\n", {}],
    ["", {}],
    ["---\n---\n# Body", {}],
    ["---\n# Only a comment\n---\n", {}],
  ])("parses only leading Markdown frontmatter: %s", (source, expected) => {
    expect(parseData(text(source), "text/markdown")).toEqual(expected);
  });
  it.each([
    "---",
    "---\ntitle: Note\n",
    "---\ntitle: Note\r---\n",
    "---\ntitle: Note\u2028---\n",
    "---\ntitle: A\ntitle: B\n---\n",
    "---\nnull\n---\n",
    "---\n[]\n---\n",
    "---\ntext\n---\n",
    "---\nn: .inf\n---\n",
    "---\nn: 9007199254740992\n---\n",
    "---\na: &a { next: *a }\n---\n",
  ])("rejects invalid Markdown frontmatter: %s", (source) => {
    expect(() => parseData(text(source), "text/markdown")).toThrow(
      ContentBundleError,
    );
  });
  it("keeps Markdown parsing bounded and checks UTF-8 even in its opaque body", () => {
    expect(
      parseData(
        text(`---\n#${" ".repeat(100_000)}\ntitle: Note\n---\n`),
        "text/markdown",
      ),
    ).toEqual({ title: "Note" });
    expect(() =>
      parseData(text("---\na: 1\n---\n"), "text/markdown", 1),
    ).toThrow("node");
    expect(() =>
      parseData(text("---\na: { b: {} }\n---\n"), "text/markdown", 100, 1),
    ).toThrow("depth");
    expect(() =>
      parseData(
        Uint8Array.from([...text("---\n{}\n---\n"), 255]),
        "text/markdown",
      ),
    ).toThrow("UTF-8");
  });
  it("requires an entry media type, permits optional schema, and rejects removed defaults", async () => {
    const valid = definition({ type: "object" });
    for (const value of [
      { ...valid, name: "" },
      { ...valid, name: "  " },
      { ...valid, name: null },
      { ...valid, description: null },
      { ...valid, extra: true },
      { ...valid, entry: { ...valid.entry, defaultValue: {} } },
      { ...valid, entry: { ...valid.entry, contentType: "not a MIME type" } },
      { ...valid, entry: { ...valid.entry, path: "../x" } },
      { ...valid, entry: { ...valid.entry, path: ".bundle.yaml" } },
      { ...valid, entry: { ...valid.entry, schema: 1 } },
      { ...valid, entry: { path: "x", schema: {} } },
    ])
      expect(() => inspectBundleSchema(value)).toThrow(ContentBundleError);
    const omitted = { name: valid.name, entry: valid.entry };
    const a = await encodeSchema(valid);
    const b = await encodeSchema(omitted);
    expect(a.cid.equals(b.cid)).toBe(true);
    expect(b.manifest.description).toBe("");
    const renamed = await encodeSchema({ ...valid, name: "Other" });
    expect(renamed.cid.equals(a.cid)).toBe(false);
    const noSchema = {
      name: valid.name,
      entry: { path: "image.png", contentType: "image/png" },
    };
    const plain = await encodeSchema(noSchema);
    const explicit = await encodeSchema({
      ...noSchema,
      entry: { ...noSchema.entry, schema: true },
    });
    expect(plain.manifest.entry).not.toHaveProperty("schema");
    expect(plain.cid.equals(explicit.cid)).toBe(false);
    expect(() => inspectBundleSchema(definition(false))).not.toThrow();
    const changed = await fixture(valid.entry.schema, { changed: true });
    const original = await fixture(valid.entry.schema, {});
    expect(changed.schemaCid.equals(original.schemaCid)).toBe(true);
    expect(changed.root.equals(original.root)).toBe(false);
  });
  it.each([
    { $defs: [] },
    { $schema: "https://json-schema.org/schema" },
    { type: "unknown" },
    { properties: [] },
    { items: [] },
    { required: ["x", "x"] },
    { required: [1] },
    { required: "x" },
    { anyOf: [] },
    { anyOf: true },
    { title: 2 },
    { description: null },
    { $ref: "#/properties/absent" },
    { $ref: "relative" },
    { $ref: "urn:external" },
    { $ref: "#anchor" },
    { $ref: "#/$defs/a~2b" },
    { $ref: "#/%61" },
    { additionalProperties: null },
    null,
    [],
    1,
    { const: Infinity },
    { const: new Uint8Array([1]) },
  ])("rejects unsupported or malformed schema nodes: %j", (schema) => {
    expect(() => inspectSchema(schema)).toThrow(ContentBundleError);
  });
  it("does not inspect data or property names as schema keywords and bounds all definitions", () => {
    expect(
      inspectSchema({
        $id: "urn:name%20encoded",
        title: "t",
        description: "d",
        properties: { $defs: true, pattern: false },
        enum: [{ $defs: 1 }],
        const: { $schema: "annotation-data" },
        additionalProperties: true,
      }),
    ).toHaveProperty("schema.$id", "urn:name%20encoded");
    expect(() =>
      inspectSchema(
        { properties: { x: { properties: { y: true } } } },
        { depth: 1 },
      ),
    ).toThrow("depth");
    const schema = {
      $defs: {
        a: { $ref: "#/$defs/b" },
        b: { $ref: "#/$defs/c" },
        c: { $ref: "#/$defs/d" },
        d: {},
      },
    };
    expect(() => inspectSchema(schema, { depth: 2 })).toThrow(
      "reference depth",
    );
    for (const options of [
      { depth: 0 },
      { depth: NaN },
      { charge: 1 },
      { unknown: 1 },
    ])
      expect(() =>
        inspectSchema(schema, options as Parameters<typeof inspectSchema>[1]),
      ).toThrow("positive");
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
  it("rejects schema directory manifests, builtin keys, invalid schema codecs and invalid entry fields", async () => {
    const schema = await encodeSchema(definition({}));
    for (const entry of [
      { path: "x", schema: "/schema", contentType: "application/json" },
      {
        path: "x",
        schemaCid: "builtin:bundle-schema.v1",
        contentType: "application/json",
      },
      {
        path: "x",
        schemaCid: CID.createV1(0x70, schema.cid.multihash).toString(),
        contentType: "application/json",
      },
      { path: "x", schemaCid: "old", contentType: "application/json" },
      {
        path: 2,
        schemaCid: schema.cid.toString(),
        contentType: "application/json",
      },
      {
        path: "x",
        schemaCid: schema.cid.toString(),
        contentType: "text/plain",
      },
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
        canonicalJson({
          z: -0,
          a: [1e-7, 1e10],
          "\u20ac": "\u20ac",
          "\r": "line",
        }),
      ),
    ).toBe('{"\\r":"line","a":[1e-7,10000000000],"z":0,"\u20ac":"\u20ac"}');
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
