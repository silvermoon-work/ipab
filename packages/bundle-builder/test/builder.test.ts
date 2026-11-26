import { afterEach, describe, expect, it } from "vitest";
import { mkdir, readFile, rm, writeFile, symlink } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { CarBlockIterator } from "@ipld/car/iterator";
import * as dagPb from "@ipld/dag-pb";
import type { CID } from "multiformats/cid";
import {
  canonicalJson,
  encodeSchema,
  openBundle,
  parseBundleManifest,
  parseData,
} from "@ipab/bundle";
import {
  encodeBundleCar,
  encodeSchemaCar,
  fileTree,
  listTree,
  memoryFile,
  memoryTree,
  readBytes,
  streamChunks,
} from "../src/index.js";
import { filesystemTree } from "../src/node.js";
import type {
  ReadonlyFileTree,
  TreeEntry,
  BundleCarOptions,
} from "../src/index.js";

const text = (value: string) => new TextEncoder().encode(value);
const definition = {
  name: "Builder",
  description: "",
  entry: {
    path: "data.json",
    schema: { type: "object" },
    contentType: "application/json",
  },
};
const schema = await encodeSchema(definition);
const controls = new Map([
  [".bundle.yaml", canonicalJson(definition)],
  ["data.json", text("{}")],
]);
const options: BundleCarOptions = {};
async function consume(
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const part of stream) chunks.push(part);
  const result = new Uint8Array(
    chunks.reduce((sum, part) => sum + part.length, 0),
  );
  let offset = 0;
  for (const part of chunks) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}
async function decode(bytes: Uint8Array) {
  const iterator = await CarBlockIterator.fromIterable(
    ReadableStream.from([bytes]),
  );
  const roots = await iterator.getRoots();
  const blocks = new Map<string, Uint8Array>();
  const order: CID[] = [];
  for await (const block of iterator) {
    blocks.set(block.cid.toString(), block.bytes);
    order.push(block.cid);
  }
  return {
    root: roots[0]!,
    blocks,
    order,
    resolveCid: (cid: CID) => {
      const bytes = blocks.get(cid.toString());
      if (!bytes) throw new Error("Missing block.");
      return Promise.resolve(bytes);
    },
  };
}
const work: string[] = [];
describe("explicit CID imports", { tags: ["unit"] }, () => {
  it("grafts the exact original multi-block UnixFS DAG into the final CAR", async () => {
    const large = text("x".repeat(600_000));
    const imported = await encodeBundleCar(
      memoryTree(new Map([...controls, ["resources/data.bin", large]])),
    );
    const original = await decode(await consume(imported.stream));
    const final = await encodeBundleCar(memoryTree(controls), {
      imports: [
        {
          path: "resources/original",
          cid: original.root,
          resolveCid: original.resolveCid,
        },
      ],
    });
    const assembled = await decode(await consume(final.stream));
    const root = dagPb.decode(assembled.blocks.get(assembled.root.toString())!);
    const resources = root.Links.find((link) => link.Name === "resources")!;
    const directory = dagPb.decode(
      assembled.blocks.get(resources.Hash.toString())!,
    );
    expect(
      directory.Links.find((link) => link.Name === "original")!.Hash.equals(
        original.root,
      ),
    ).toBe(true);
    for (const [cid, block] of original.blocks) {
      if (cid !== schema.cid.toString())
        expect(assembled.blocks.get(cid)).toEqual(block);
    }
    const bundle = await openBundle(assembled.root, {
      resolveCid: assembled.resolveCid,
    });
    expect(
      await readBytes(
        {
          list: () => Promise.resolve([]),
          read: () => bundle.readFile("resources/original/resources/data.bin"),
        },
        "file",
        700_000,
      ),
    ).toEqual(large);
  });
  it("rejects import collisions, missing blocks and corrupt blocks", async () => {
    const imported = await encodeBundleCar(memoryTree(controls));
    const original = await decode(await consume(imported.stream));
    await expect(
      encodeBundleCar(memoryTree(controls), {
        imports: [
          {
            path: "data.json",
            cid: original.root,
            resolveCid: original.resolveCid,
          },
        ],
      }),
    ).rejects.toThrow(/collision/i);
    await expect(
      encodeBundleCar(memoryTree(controls), {
        imports: [
          {
            path: "resources/import",
            cid: original.root,
            resolveCid: () =>
              Promise.reject(new Error("Missing imported block")),
          },
        ],
      }),
    ).rejects.toThrow(/Missing/);
    await expect(
      encodeBundleCar(memoryTree(controls), {
        imports: [
          {
            path: "resources/import",
            cid: original.root,
            resolveCid: () => Promise.resolve(text("corrupt")),
          },
        ],
      }),
    ).rejects.toThrow(/Invalid imported/);
    await expect(
      encodeBundleCar(memoryTree(controls), {
        imports: [
          {
            path: "resources/import",
            cid: original.root,
            resolveCid: original.resolveCid,
          },
          {
            path: "resources/import/child",
            cid: original.root,
            resolveCid: original.resolveCid,
          },
        ],
      }),
    ).rejects.toThrow(/overlap/);
  });
});
afterEach(async () => {
  for (const path of work.splice(0))
    await rm(path, { recursive: true, force: true });
});
async function directory() {
  const path = resolve(".test-work", randomUUID());
  work.push(path);
  await mkdir(path, { recursive: true });
  return path;
}
describe("deterministic bounded UnixFS CAR construction", () => {
  it(
    "round-trips a single binary entry and reports unsupported semantic validation",
    { tags: ["unit"] },
    async () => {
      const manifest = {
        name: "Image",
        entry: { path: "image.png", contentType: "image/png" },
      };
      const image = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10, 255);
      const encoded = await encodeBundleCar(
        memoryTree(
          new Map([
            [".bundle.yaml", canonicalJson(manifest)],
            ["image.png", image],
          ]),
        ),
      );
      try {
        expect(encoded.validation).toEqual({
          status: "unsupported",
          contentType: "image/png",
        });
        const decoded = await decode(await consume(encoded.stream));
        const bundle = await openBundle(decoded.root, decoded);
        expect(bundle.manifest.entry).not.toHaveProperty("schema");
        expect(await consume(await bundle.readFile("image.png"))).toEqual(
          image,
        );
      } finally {
        await encoded.close();
      }
      const type = await encodeSchemaCar(manifest);
      try {
        expect(type.validation).toBeNull();
      } finally {
        await type.close();
      }
    },
  );
  it(
    "builds the Agent Skill example with its complete type and unchanged Markdown resources",
    { tags: ["release-e2e"] },
    async () => {
      const directory = resolve("../../examples/agent-skill");
      const manifest = parseBundleManifest(
        await readFile(join(directory, ".bundle.yaml")),
      );
      const type = await encodeSchema(manifest);
      const encoded = await encodeBundleCar(
        await filesystemTree(directory, {
          exclude: (path) => path === ".bundle-ignore" || path === "dist",
        }),
      );
      try {
        const decoded = await decode(await consume(encoded.stream));
        const bundle = await openBundle(decoded.root, decoded);
        expect(bundle.schemaKey).toBe(type.cid.toString());
        expect(decoded.blocks.get(bundle.schemaKey)).toEqual(type.bytes);
        const source = Uint8Array.from(
          await readFile(join(directory, "SKILL.md")),
        );
        expect(
          await consume(await bundle.readFile(bundle.manifest.entry.path)),
        ).toEqual(source);
        expect(parseData(source, "text/markdown")).toMatchObject({
          name: "agent-skill",
          metadata: { version: "1.0" },
          "allowed-tools": "Read",
        });
        expect(
          await consume(await bundle.readFile("references/WORKFLOW.md")),
        ).toEqual(
          Uint8Array.from(
            await readFile(join(directory, "references", "WORKFLOW.md")),
          ),
        );
      } finally {
        await encoded.close();
      }
      for (const metadata of [
        { name: "agent-skill" },
        { name: 1, description: "Wrong name type" },
        { name: "agent-skill", description: "Unknown field", extra: true },
        {
          name: "agent-skill",
          description: "Wrong metadata value",
          metadata: { version: 1 },
        },
        {
          name: "agent-skill",
          description: "Wrong tool type",
          "allowed-tools": ["Read"],
        },
      ]) {
        await expect(
          encodeBundleCar(
            memoryTree(
              new Map([
                [".bundle.yaml", canonicalJson(manifest)],
                [
                  "SKILL.md",
                  text(`---\n${JSON.stringify(metadata)}\n---\n# Body\n`),
                ],
              ]),
            ),
          ),
        ).rejects.toMatchObject({ code: "CONTENT_INVALID", path: "SKILL.md" });
      }
    },
  );
  it(
    "repeats identical roots and CAR bytes, root-first, unique binary sorted blocks including the schema",
    { tags: ["unit"] },
    async () => {
      const first = await encodeBundleCar(memoryTree(controls), options);
      const root = first.cid;
      first.cid.bytes.fill(0);
      expect(first.cid.equals(root)).toBe(true);
      expect(first.retainedBytes).toBeGreaterThan(0);
      const bytes = await consume(first.stream);
      expect(first.retainedBytes).toBe(0);
      await first.close();
      const second = await encodeBundleCar(
        memoryTree(new Map([...controls].reverse())),
        options,
      );
      expect(second.cid.equals(root)).toBe(true);
      expect(await consume(second.stream)).toEqual(bytes);
      const decoded = await decode(bytes);
      expect(decoded.root.equals(root)).toBe(true);
      expect(decoded.order[0]!.equals(root)).toBe(true);
      expect(new Set(decoded.order.map(String)).size).toBe(
        decoded.order.length,
      );
      expect(
        decoded.order
          .slice(1)
          .map((cid) => Buffer.from(cid.bytes).toString("hex")),
      ).toEqual(
        decoded.order
          .slice(1)
          .map((cid) => Buffer.from(cid.bytes).toString("hex"))
          .sort(),
      );
      expect(decoded.blocks.get(schema.cid.toString())).toEqual(schema.bytes);
      expect((await openBundle(root, decoded)).schemaKey).toBe(
        schema.cid.toString(),
      );
      expect(
        dagPb
          .decode(decoded.blocks.get(root.toString())!)
          .Links.every((link) => link.Hash.code !== 0x71),
      ).toBe(true);
      expect(root.toString()).toBe(
        "bafybeia6aweeyn7qf367g37z2zrpbix6qgzywgmg7zsw64nur2rbsxv2oa",
      );
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(
        "ef044475d040e690345b5a578072bc1f4e6067a26945102dc5f912c45747eb4e",
      );
    },
  );
  it(
    "fixes 256KiB raw leaves and 174-child balanced layout",
    { tags: ["unit"], timeout: 30000 },
    async () => {
      const attachment = new Uint8Array(262_144 * 175 + 17);
      for (let index = 0; index < 176; index++)
        attachment.fill(
          index,
          index * 262_144,
          Math.min(attachment.length, (index + 1) * 262_144),
        );
      const input = memoryTree(
        new Map([...controls, ["resources/large.bin", attachment]]),
      );
      const encoded = await encodeBundleCar(input, options);
      const archive = await consume(encoded.stream);
      expect(encoded.cid.toString()).toBe(
        "bafybeidtimybgyrdccovrtcrewp5iy5lzgilvugpwebtw5fdz7fvqsmeye",
      );
      expect(createHash("sha256").update(archive).digest("hex")).toBe(
        "ef7dc310bf005529fc21ad464d037c839d4f17f04b590e00e68d1cda4b4fce97",
      );
      const decoded = await decode(archive);
      const bundle = await openBundle(encoded.cid, decoded);
      const restored = await consume(
        await bundle.readFile("resources/large.bin"),
      );
      expect(Buffer.from(restored).equals(Buffer.from(attachment))).toBe(true);
      const root = dagPb.decode(decoded.blocks.get(decoded.root.toString())!);
      const resources = root.Links.find(
        (link) => link.Name === "resources",
      )!.Hash;
      const file = dagPb.decode(
        decoded.blocks.get(
          dagPb
            .decode(decoded.blocks.get(resources.toString())!)
            .Links[0]!.Hash.toString(),
        )!,
      );
      expect(file.Links.length).toBe(2);
      const internal = dagPb.decode(
        decoded.blocks.get(file.Links[0]!.Hash.toString())!,
      );
      expect(internal.Links.length).toBe(174);
      expect(internal.Links.every((link) => link.Hash.code === 0x55)).toBe(
        true,
      );
      const again = await encodeBundleCar(input, options);
      expect(again.cid.equals(encoded.cid)).toBe(true);
      await again.close();
    },
  );
  it(
    "preserves the raw-leaf to chunked-file boundary",
    { tags: ["unit"] },
    async () => {
      for (const size of [262_144, 262_145]) {
        const encoded = await encodeBundleCar(
          memoryTree(
            new Map([...controls, ["large.bin", new Uint8Array(size).fill(1)]]),
          ),
          options,
        );
        const decoded = await decode(await consume(encoded.stream));
        const link = dagPb
          .decode(decoded.blocks.get(decoded.root.toString())!)
          .Links.find((link) => link.Name === "large.bin")!;
        expect(link.Hash.code).toBe(size === 262_144 ? 0x55 : 0x70);
        if (size > 262_144)
          expect(
            dagPb.decode(decoded.blocks.get(link.Hash.toString())!).Links,
          ).toHaveLength(2);
      }
    },
  );
  it(
    "fixes the chunked-file boundary CAR vector with its standalone schema block",
    { tags: ["unit"] },
    async () => {
      const data = new Uint8Array(262_145);
      data[262_144] = 1;
      const output = await encodeBundleCar(
        memoryTree(new Map([...controls, ["resources/large.bin", data]])),
        options,
      );
      const archive = await consume(output.stream);
      expect(output.cid.toString()).toBe(
        "bafybeicwzfzvlw7x4m52ijrsapx6iqarogwggsodzv4upjxumjpyskpwty",
      );
      expect(createHash("sha256").update(archive).digest("hex")).toBe(
        "72466b6d60ac1ad4d46158559986cb088da33423e24fc6caa7b0b4088923abd4",
      );
    },
  );
  it(
    "does not normalize manifest or attachment bytes",
    { tags: ["unit"] },
    async () => {
      const manifest = text(
        "name: Builder\r\nentry:\r\n  path: data.json\r\n  schema:\r\n    type: object\r\n  contentType: application/json\r\n",
      );
      const encoded = await encodeBundleCar(
        memoryTree(
          new Map([
            ...controls,
            [".bundle.yaml", manifest],
            ["opaque", Uint8Array.of(0, 255, 13)],
          ]),
        ),
        options,
      );
      const decoded = await decode(await consume(encoded.stream));
      const bundle = await openBundle(decoded.root, decoded);
      expect(await consume(await bundle.readFile(".bundle.yaml"))).toEqual(
        manifest,
      );
      expect(await consume(await bundle.readFile("opaque"))).toEqual(
        Uint8Array.of(0, 255, 13),
      );
    },
  );
  it(
    "fully consumes input before success and cancellation stops input/output streams",
    { tags: ["unit"] },
    async () => {
      let consumed = false,
        cancelled = false;
      const input = fileTree(
        new Map(
          [...controls].map(([path, bytes]) => [path, () => memoryFile(bytes)]),
        ),
      );
      const broken: ReadonlyFileTree = {
        list: async (path, options) =>
          path
            ? input.list(path, options)
            : [
                ...(await input.list(path, options)),
                { name: "bad", kind: "file" },
              ],
        read: async (path, options) =>
          path === "bad"
            ? new ReadableStream<Uint8Array>({
                pull(controller) {
                  consumed = true;
                  controller.error(new Error("input failed"));
                },
                cancel() {
                  cancelled = true;
                },
              })
            : input.read(path, options),
      };
      await expect(encodeBundleCar(broken, options)).rejects.toThrow(
        "input failed",
      );
      expect(consumed).toBe(true);
      const abort = new AbortController();
      const hanging = new ReadableStream<Uint8Array>({
        cancel() {
          cancelled = true;
        },
      });
      const reading = (async () => {
        for await (const chunk of streamChunks(hanging, {
          signal: abort.signal,
        }))
          expect(chunk).toBeInstanceOf(Uint8Array);
      })();
      abort.abort(new Error("abort"));
      await expect(reading).rejects.toThrow();
      expect(cancelled).toBe(true);
      const encoded = await encodeBundleCar(input, options);
      await encoded.stream.cancel();
      expect(encoded.retainedBytes).toBe(0);
      await encoded.close();
      const live = new AbortController();
      const output = await encodeBundleCar(input, {
        ...options,
        signal: live.signal,
      });
      live.abort(new Error("output abort"));
      await expect(consume(output.stream)).rejects.toThrow("output abort");
      expect(output.retainedBytes).toBe(0);
      await expect(
        encodeBundleCar(input, { ...options, signal: live.signal }),
      ).rejects.toThrow();
    },
  );
  it.each([
    "blocks",
    "bytes",
    "blockBytes",
    "files",
    "depth",
    "parsingBytes",
    "nodes",
  ] as const)(
    "enforces output/input %s bounds",
    { tags: ["unit"] },
    async (name) => {
      await expect(
        encodeBundleCar(
          memoryTree(new Map([...controls, ["nested/file", text("test")]])),
          { ...options, limits: { [name]: 1 } },
        ),
      ).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
    },
  );
  it(
    "counts repeated input bytes independently of deduplicated storage",
    { tags: ["unit"] },
    async () => {
      const repeated = new Uint8Array(1024).fill(1);
      await expect(
        encodeBundleCar(
          memoryTree(new Map([...controls, ["a", repeated], ["b", repeated]])),
          { limits: { bytes: 1600 } },
        ),
      ).rejects.toMatchObject({
        code: "LIMIT_EXCEEDED",
        message: "Input byte budget exceeded.",
        path: "b",
      });
    },
  );
  it(
    "charges directory visits as well as entries to the tree work budget",
    { tags: ["unit"] },
    async () => {
      await expect(
        encodeBundleCar(
          memoryTree(new Map([...controls, ["nested/file", text("test")]])),
          { limits: { nodes: 4 } },
        ),
      ).rejects.toMatchObject({
        code: "LIMIT_EXCEEDED",
        message: "File tree work budget exceeded.",
        path: "nested",
      });
    },
  );
  it(
    "constructs the schema block from the definition and rejects invalid inputs",
    { tags: ["unit"] },
    async () => {
      const encoded = await encodeBundleCar(memoryTree(controls));
      expect(encoded.schema.cid.equals(schema.cid)).toBe(true);
      await encoded.close();
      await expect(
        encodeBundleCar(memoryTree(new Map())),
      ).rejects.toMatchObject({
        code: "MANIFEST_INVALID",
      });
      await expect(
        encodeBundleCar(memoryTree(new Map([["plain", text("x")]])), options),
      ).rejects.toMatchObject({ code: "CONTENT_UNAVAILABLE" });
      await expect(
        encodeBundleCar(memoryTree(controls), {
          ...options,
          limits: { bytes: 0 },
        }),
      ).rejects.toMatchObject({ code: "OPTIONS_INVALID" });
    },
  );
  it(
    "encodes exactly one complete type block as a standalone CAR with bounded/cancellable output",
    { tags: ["unit"] },
    async () => {
      const encoded = await encodeSchemaCar(definition);
      const source = await decode(await consume(encoded.stream));
      expect(encoded.cid.equals(source.root)).toBe(true);
      expect(source.root.equals(schema.cid)).toBe(true);
      expect(source.order).toHaveLength(1);
      expect(source.blocks.get(schema.cid.toString())).toEqual(schema.bytes);
      expect(encoded.retainedBytes).toBe(0);
      await encoded.close();
      for (const limits of [{ nodes: 1 }, { bytes: 1 }])
        await expect(
          encodeSchemaCar(definition, { limits }),
        ).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
      const abort = new AbortController();
      const cancelled = await encodeSchemaCar(definition, {
        signal: abort.signal,
      });
      abort.abort(new Error("cancelled"));
      await expect(consume(cancelled.stream)).rejects.toThrow("cancelled");
      expect(cancelled.retainedBytes).toBe(0);
      await expect(
        encodeSchemaCar(definition, { signal: abort.signal }),
      ).rejects.toThrow("cancelled");
      const unused = await encodeSchemaCar(definition);
      await unused.stream.cancel();
      expect(unused.retainedBytes).toBe(0);
      const closed = await encodeSchemaCar(definition);
      await closed.close();
      await expect(consume(closed.stream)).rejects.toMatchObject({
        code: "ABORTED",
      });
    },
  );
});
describe("repeatable VFS and explicit local adapter", () => {
  it(
    "excludes directories before visiting their symlinks while retaining selected files",
    { tags: ["unit"] },
    async () => {
      const root = await directory();
      await mkdir(join(root, "ignored"));
      await mkdir(join(root, "selected"));
      await writeFile(join(root, "selected", "file"), "keep");
      await writeFile(join(root, "selected", "drop"), "exclude");
      await symlink(
        join(root, "selected"),
        join(root, "ignored", "linked"),
        "junction",
      );
      const tree = await filesystemTree(root, {
        exclude: (path, directory) =>
          (path === "ignored" && directory) || path === "selected/drop",
      });
      expect(await listTree(tree, "")).toEqual([
        { name: "selected", kind: "directory" },
      ]);
      expect(await listTree(tree, "selected")).toEqual([
        { name: "file", kind: "file" },
      ]);
      expect(await readBytes(tree, "selected/file", 100)).toEqual(text("keep"));
    },
  );
  it(
    "owns memory bytes, returns fresh streams and safely lists nested trees",
    { tags: ["unit"] },
    async () => {
      const owned = Uint8Array.of(1, 2);
      const tree = memoryTree(
        new Map([
          ["nested/file", owned],
          ["root", text("a")],
        ]),
      );
      owned.fill(9);
      expect(await readBytes(tree, "nested/file", 2)).toEqual(
        Uint8Array.of(1, 2),
      );
      expect(await readBytes(tree, "nested/file", 2)).toEqual(
        Uint8Array.of(1, 2),
      );
      expect(await listTree(tree, "")).toEqual([
        { name: "nested", kind: "directory" },
        { name: "root", kind: "file" },
      ]);
      expect(await listTree(tree, "nested")).toEqual([
        { name: "file", kind: "file" },
      ]);
      expect(await listTree(tree, "nested", {})).toHaveLength(1);
      const reverse = memoryTree(
        new Map([
          ["z", owned],
          ["a", owned],
          ["m", owned],
        ]),
      );
      expect((await listTree(reverse, "")).map((entry) => entry.name)).toEqual([
        "a",
        "m",
        "z",
      ]);
      expect(() =>
        memoryTree(
          new Map([
            ["x/y", owned],
            ["x/z", owned],
            ["deep/nested/file", owned],
          ]),
        ),
      ).not.toThrow();
      await expect(tree.list("root")).rejects.toMatchObject({
        code: "PATH_INVALID",
      });
      await expect(tree.read("nested")).rejects.toMatchObject({
        code: "CONTENT_UNAVAILABLE",
      });
      await expect(readBytes(tree, "nested/file", 1)).rejects.toMatchObject({
        code: "LIMIT_EXCEEDED",
      });
      expect(() =>
        memoryTree(
          new Map([
            ["x", owned],
            ["x/y", owned],
          ]),
        ),
      ).toThrow("collision");
      expect(() => memoryTree(new Map([["../x", owned]]))).toThrow("Unsafe");
      const abort = new AbortController();
      abort.abort(new Error("cancel"));
      await expect(tree.list("", { signal: abort.signal })).rejects.toThrow(
        "cancel",
      );
      await expect(tree.read("root", { signal: abort.signal })).rejects.toThrow(
        "cancel",
      );
      await expect(
        consume(memoryFile(owned, { signal: abort.signal })),
      ).rejects.toThrow("cancel");
    },
  );
  it.each(
    [
      [
        { name: "x", kind: "file" },
        { name: "x", kind: "directory" },
      ],
      [{ name: "a/b", kind: "file" }],
      [{ name: "bad", kind: "unknown" }],
    ].map((entries) => ({ entries })),
  )("rejects unsafe list results", { tags: ["unit"] }, async ({ entries }) => {
    const tree = {
      list: () => Promise.resolve(entries as TreeEntry[]),
      read: () => Promise.resolve(memoryFile(new Uint8Array())),
    };
    await expect(listTree(tree, "")).rejects.toMatchObject({
      code: "PATH_INVALID",
    });
  });
  it("requires byte stream chunks", { tags: ["unit"] }, async () => {
    const invalid = new ReadableStream({
      start(controller) {
        controller.enqueue("bad");
        controller.close();
      },
    }) as unknown as ReadableStream<Uint8Array>;
    await expect(
      consume(ReadableStream.from(streamChunks(invalid))),
    ).rejects.toMatchObject({ code: "CONTENT_INVALID" });
  });
  it(
    "reads local files repeatedly, rejects symlinks and preserves cancellation",
    { tags: ["unit"] },
    async () => {
      const root = await directory();
      await mkdir(join(root, "nested"));
      await writeFile(join(root, "nested", "file"), text("value"));
      const tree = await filesystemTree(root);
      expect(await listTree(tree, "")).toEqual([
        { name: "nested", kind: "directory" },
      ]);
      expect(await readBytes(tree, "nested/file", 100)).toEqual(text("value"));
      expect(await readBytes(tree, "nested/file", 100)).toEqual(text("value"));
      await expect(tree.read("nested")).rejects.toThrow();
      await expect(tree.read("../outside")).rejects.toMatchObject({
        code: "PATH_INVALID",
      });
      await expect(
        filesystemTree(join(root, "nested", "file")),
      ).rejects.toMatchObject({ code: "PATH_INVALID" });
      const abort = new AbortController();
      const stream = await tree.read("nested/file", { signal: abort.signal });
      abort.abort(new Error("cancel"));
      await expect(consume(stream)).rejects.toThrow("cancel");
      await (await tree.read("nested/file")).cancel();
      await symlink(join(root, "nested"), join(root, "linked"), "junction");
      await expect(tree.list("")).rejects.toMatchObject({
        code: "PATH_INVALID",
      });
      await expect(tree.read("linked/file")).rejects.toMatchObject({
        code: "PATH_INVALID",
      });
      await expect(filesystemTree(join(root, "linked"))).rejects.toMatchObject({
        code: "PATH_INVALID",
      });
    },
  );
  it(
    "reads large local files over multiple chunks and resolves an explicit file-tree reader",
    { tags: ["unit"] },
    async () => {
      const root = await directory();
      const data = new Uint8Array(262_145).fill(5);
      await writeFile(join(root, "file"), data);
      const tree = await filesystemTree(root);
      expect(await readBytes(tree, "file", data.length)).toEqual(data);
      const readers = fileTree(
        new Map([["file", () => Promise.resolve(memoryFile(data))]]),
      );
      expect(await readBytes(readers, "file", data.length)).toEqual(data);
    },
  );
  it(
    "supports empty directories and validates final CAR bytes",
    { tags: ["unit"] },
    async () => {
      const root = await directory();
      for (const [path, bytes] of controls)
        await writeFile(join(root, path), bytes);
      await mkdir(join(root, "empty"));
      const output = await encodeBundleCar(await filesystemTree(root), options);
      const decoded = await decode(await consume(output.stream));
      expect((await openBundle(decoded.root, decoded)).kind).toBe("content");
    },
  );
});
