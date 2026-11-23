import { afterEach, describe, expect, it } from "vitest";
import { mkdir, rm, writeFile, symlink } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { CarBlockIterator } from "@ipld/car/iterator";
import * as dagPb from "@ipld/dag-pb";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import { canonicalJson, openBundle, SCHEMA_PROFILE } from "@ipab/bundle";
import {
  encodeBundleCar,
  fileTree,
  listTree,
  memoryFile,
  memoryTree,
  readBytes,
  streamChunks,
} from "../src/index.js";
import { filesystemTree } from "../src/node.js";
import type { ReadonlyFileTree, TreeEntry } from "../src/index.js";

const text = (value: string) => new TextEncoder().encode(value);
const controls = new Map([
  [
    ".bundle.yaml",
    canonicalJson({
      entry: {
        path: "schema.json",
        schema: SCHEMA_PROFILE,
        contentType: "application/json",
      },
    }),
  ],
  [
    "schema.json",
    canonicalJson({ schemas: ["main.json"], main: "urn:builder:main" }),
  ],
  ["main.json", canonicalJson({ $id: "urn:builder:main", type: "object" })],
]);
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
  it("repeats identical root and CAR bytes, root-first, unique binary sorted reachable blocks", async () => {
    const input = memoryTree(controls);
    const first = await encodeBundleCar(input);
    const root = first.cid;
    first.cid.bytes.fill(0);
    expect(first.cid.equals(root)).toBe(true);
    expect(first.retainedBytes).toBeGreaterThan(0);
    const bytes = await consume(first.stream);
    expect(root.toString()).toBe(
      "bafybeic63uienavfj5xpshvnlkkpeuy4qambnouzhva24xy5fmmplcymxa",
    );
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      "1e84f2b7716778061b81b8ac2c7bd099623230a356e603659ce0148e966153ab",
    );
    expect(first.retainedBytes).toBe(0);
    await first.close();
    const second = await encodeBundleCar(
      memoryTree(new Map([...controls].reverse())),
    );
    expect(second.cid.equals(root)).toBe(true);
    expect(await consume(second.stream)).toEqual(bytes);
    const decoded = await decode(bytes);
    expect(decoded.root.equals(root)).toBe(true);
    expect(decoded.order[0]!.equals(root)).toBe(true);
    expect(new Set(decoded.order.map(String)).size).toBe(decoded.order.length);
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
    expect((await openBundle(root, decoded)).kind).toBe("schema");
  });
  it("fixes 256KiB raw leaves, 174-child balanced layout, no path/mode/mtime identity", async () => {
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
    const encoded = await encodeBundleCar(input);
    const archive = await consume(encoded.stream);
    expect(encoded.cid.toString()).toBe(
      "bafybeid3jm4aczkwqanzd356fehwc3fdg67rma5t57z74zvm5h25z4q5oi",
    );
    expect(createHash("sha256").update(archive).digest("hex")).toBe(
      "dfab0715f5b19b58af0be239165f1ca007433a4d292e10c73aaeb70077f84914",
    );
    const decoded = await decode(archive);
    const bundle = await openBundle(encoded.cid, decoded);
    const actual = await consume(await bundle.readFile("resources/large.bin"));
    expect(actual).toEqual(attachment);
    const directory = dagPb.decode(
      decoded.blocks.get(decoded.root.toString())!,
    );
    const resources = directory.Links.find(
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
    expect(internal.Links.every((link) => link.Hash.code === 0x55)).toBe(true);
    const again = await encodeBundleCar(input);
    expect(again.cid.equals(encoded.cid)).toBe(true);
    await again.close();
  }, 30000);
  it("preserves an existing embedded Schema Bundle exact subtree CID", async () => {
    const schema = await encodeBundleCar(memoryTree(controls));
    const source = await decode(await consume(schema.stream));
    const files = new Map([
      [
        ".bundle.yaml",
        canonicalJson({
          entry: {
            path: "data.json",
            contentType: "application/json",
            schema: "/nested/schema",
          },
        }),
      ],
      ["data.json", text("{}")],
      ["nested/other.txt", text("opaque")],
    ]);
    const encoded = await encodeBundleCar(memoryTree(files), {
      embeddedSchemas: new Map([
        ["nested/schema", { cid: source.root, resolveCid: source.resolveCid }],
      ]),
    });
    const output = await decode(await consume(encoded.stream));
    const bundle = await openBundle(output.root, output);
    expect(bundle.schemaKey).toBe(source.root.toString());
    expect(bundle.schemaBundle!.cid.equals(source.root)).toBe(true);
    const standalone = await encodeBundleCar(memoryTree(controls));
    expect(standalone.cid.equals(source.root)).toBe(true);
    await standalone.close();
  });
  it("fixes the raw-leaf to chunked-file boundary vector", async () => {
    const attachment = new Uint8Array(262_145);
    attachment[262_144] = 1;
    const encoded = await encodeBundleCar(
      memoryTree(new Map([...controls, ["resources/large.bin", attachment]])),
    );
    const archive = await consume(encoded.stream);
    expect(encoded.cid.toString()).toBe(
      "bafybeiao56tfl5ri6qurxt4uuhkk4mtbk5ffwddohfao5cphli4s652ueu",
    );
    expect(createHash("sha256").update(archive).digest("hex")).toBe(
      "02557a51500b3f8f1c7d6089a8bac2f042f02df9db26cc0c90e523ef5733ae69",
    );
  });
  it("does not normalize control or attachment bytes in the generic builder", async () => {
    const manifest = text(
      "entry:\r\n  path: schema.json\r\n  schema: builtin:bundle-schema.v1\r\n  contentType: application/json\r\n",
    );
    const files = new Map([
      ...controls,
      [".bundle.yaml", manifest],
      ["opaque", Uint8Array.of(0, 255, 13)],
    ]);
    const encoded = await encodeBundleCar(memoryTree(files));
    const decoded = await decode(await consume(encoded.stream));
    const bundle = await openBundle(decoded.root, decoded);
    expect(await consume(await bundle.readFile(".bundle.yaml"))).toEqual(
      manifest,
    );
    expect(await consume(await bundle.readFile("opaque"))).toEqual(
      Uint8Array.of(0, 255, 13),
    );
  });
  it("fully consumes input before success and cancellation stops streams", async () => {
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
    await expect(encodeBundleCar(broken)).rejects.toThrow("input failed");
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
      })) {
        expect(chunk).toBeInstanceOf(Uint8Array);
      }
    })();
    abort.abort(new Error("abort"));
    await expect(reading).rejects.toThrow();
    expect(cancelled).toBe(true);
    const encoded = await encodeBundleCar(input);
    await encoded.stream.cancel();
    expect(encoded.retainedBytes).toBe(0);
    await encoded.close();
    const live = new AbortController();
    const output = await encodeBundleCar(input, { signal: live.signal });
    live.abort(new Error("output abort"));
    await expect(consume(output.stream)).rejects.toThrow("output abort");
    expect(output.retainedBytes).toBe(0);
    await expect(
      encodeBundleCar(input, { signal: live.signal }),
    ).rejects.toThrow();
  });
  it.each([
    ["blocks", 1],
    ["bytes", 1],
    ["blockBytes", 1],
    ["files", 1],
    ["depth", 1],
    ["parsingBytes", 1],
  ] as const)("enforces output/input %s bounds", async (name, limit) => {
    await expect(
      encodeBundleCar(
        memoryTree(new Map([...controls, ["nested/file", text("test")]])),
        { limits: { [name]: limit } },
      ),
    ).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
  });
  it("rejects invalid manifests, file trees and embedded conflicts", async () => {
    await expect(encodeBundleCar(memoryTree(new Map()))).rejects.toMatchObject({
      code: "MANIFEST_INVALID",
    });
  });
  it("accepts existing directory placeholders and rejects missing or unsupported embedded DAGs", async () => {
    const schema = await encodeBundleCar(memoryTree(controls));
    const source = await decode(await consume(schema.stream));
    const input = memoryTree(
      new Map([
        [
          ".bundle.yaml",
          canonicalJson({
            entry: {
              path: "data.json",
              schema: "/schema",
              contentType: "application/json",
            },
          }),
        ],
        ["data.json", text("{}")],
        ["schema/placeholder", text("not imported")],
      ]),
    );
    const embeddedSchemas = new Map([
      ["schema", { cid: source.root, resolveCid: source.resolveCid }],
    ]);
    const result = await encodeBundleCar(input, { embeddedSchemas });
    expect(
      (await openBundle(result.cid, await decode(await consume(result.stream))))
        .schemaKey,
    ).toBe(source.root.toString());
    await expect(
      encodeBundleCar(input, {
        embeddedSchemas: new Map([
          [
            "schema",
            {
              cid: source.root,
              resolveCid: () => Promise.reject(new Error("missing schema")),
            },
          ],
        ]),
      }),
    ).rejects.toThrow("missing schema");
    const unsupported = CID.createV1(0x71, source.root.multihash);
    await expect(
      encodeBundleCar(input, {
        embeddedSchemas: new Map([
          [
            "schema",
            {
              cid: unsupported,
              resolveCid: () =>
                Promise.resolve(source.blocks.get(source.root.toString())!),
            },
          ],
        ]),
      }),
    ).rejects.toThrow();
    const shallow = {
      limits: { depth: 1 },
      embeddedSchemas: new Map([
        ["schema", { cid: source.root, resolveCid: source.resolveCid }],
      ]),
    };
    await expect(encodeBundleCar(input, shallow)).rejects.toMatchObject({
      code: "LIMIT_EXCEEDED",
    });
  });
  it("accepts alternate legitimate directory layout with omitted size hints", async () => {
    const encoded = await encodeBundleCar(memoryTree(controls));
    const source = await decode(await consume(encoded.stream));
    const node = dagPb.decode(source.blocks.get(source.root.toString())!);
    const bytes = dagPb.encode(
      dagPb.prepare({
        Data: node.Data,
        Links: node.Links.map((link) => ({ Hash: link.Hash, Name: link.Name })),
      }),
    );
    const root = CID.createV1(dagPb.code, await sha256.digest(bytes));
    source.blocks.set(root.toString(), bytes);
    const input = memoryTree(
      new Map([
        [
          ".bundle.yaml",
          canonicalJson({
            entry: {
              path: "data.json",
              schema: "/schema",
              contentType: "application/json",
            },
          }),
        ],
        ["data.json", text("{}")],
      ]),
    );
    const result = await encodeBundleCar(input, {
      embeddedSchemas: new Map([
        ["schema", { cid: root, resolveCid: source.resolveCid }],
      ]),
    });
    expect(
      (await openBundle(result.cid, await decode(await consume(result.stream))))
        .schemaKey,
    ).toBe(root.toString());
  });
  it("bounds both directory work and deeper input/embedded DAGs", async () => {
    const input = memoryTree(
      new Map([...controls, ["deep/more/file", text("x")]]),
    );
    await expect(
      encodeBundleCar(input, { limits: { nodes: 1 } }),
    ).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
    await expect(
      encodeBundleCar(input, { limits: { nodes: 2 } }),
    ).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
    await expect(
      encodeBundleCar(input, { limits: { depth: 1 } }),
    ).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
    const nestedControls = new Map([
      [".bundle.yaml", controls.get(".bundle.yaml")!],
      [
        "schema.json",
        canonicalJson({
          schemas: ["deep/main.json"],
          main: "urn:builder:main",
        }),
      ],
      ["deep/main.json", controls.get("main.json")!],
    ]);
    const encoded = await encodeBundleCar(memoryTree(nestedControls));
    const source = await decode(await consume(encoded.stream));
    await expect(
      encodeBundleCar(memoryTree(controls), {
        limits: { depth: 1 },
        embeddedSchemas: new Map([
          ["schema", { cid: source.root, resolveCid: source.resolveCid }],
        ]),
      }),
    ).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
  });
  it("rejects invalid manifests and embedded conflicts", async () => {
    await expect(
      encodeBundleCar(memoryTree(new Map([["plain", text("x")]]))),
    ).rejects.toMatchObject({ code: "CONTENT_UNAVAILABLE" });
    await expect(
      encodeBundleCar(memoryTree(controls), { limits: { bytes: 0 } }),
    ).rejects.toMatchObject({ code: "OPTIONS_INVALID" });
    const encoded = await encodeBundleCar(memoryTree(controls));
    const source = await decode(await consume(encoded.stream));
    const embed = { cid: source.root, resolveCid: source.resolveCid };
    await expect(
      encodeBundleCar(memoryTree(controls), {
        embeddedSchemas: new Map([["main.json", embed]]),
      }),
    ).rejects.toMatchObject({ code: "PATH_INVALID" });
    await expect(
      encodeBundleCar(memoryTree(controls), {
        embeddedSchemas: new Map([
          ["a", embed],
          ["a/b", embed],
        ]),
      }),
    ).rejects.toMatchObject({ code: "PATH_INVALID" });
    const corrupt = {
      ...embed,
      resolveCid: () => Promise.resolve(Uint8Array.of(255)),
    };
    await expect(
      encodeBundleCar(memoryTree(controls), {
        embeddedSchemas: new Map([["schema", corrupt]]),
      }),
    ).rejects.toMatchObject({ code: "CONTENT_UNAVAILABLE" });
    const raw = CID.parse(
      source.order.find((cid) => cid.code === 0x55)!.toString(),
    );
    await expect(
      encodeBundleCar(memoryTree(controls), {
        embeddedSchemas: new Map([
          ["schema", { cid: raw, resolveCid: source.resolveCid }],
        ]),
      }),
    ).rejects.toMatchObject({ code: "CONTENT_INVALID" });
  });
});
describe("repeatable VFS and explicit local adapter", () => {
  it("owns memory bytes, returns fresh streams and safely lists nested trees", async () => {
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
  });
  it.each(
    [
      [
        { name: "x", kind: "file" },
        { name: "x", kind: "directory" },
      ],
      [{ name: "a/b", kind: "file" }],
      [{ name: "bad", kind: "unknown" }],
    ].map((entries) => ({ entries })),
  )("rejects unsafe list results", async ({ entries }) => {
    const tree = {
      list: () => Promise.resolve(entries as TreeEntry[]),
      read: () => Promise.resolve(memoryFile(new Uint8Array())),
    };
    await expect(listTree(tree, "")).rejects.toMatchObject({
      code: "PATH_INVALID",
    });
  });
  it("requires byte stream chunks", async () => {
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
  it("reads local files repeatedly, rejects symlinks and preserves cancellation/backpressure", async () => {
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
    const cancelled = await tree.read("nested/file");
    await cancelled.cancel();
    await symlink(join(root, "nested"), join(root, "linked"), "junction");
    await expect(tree.list("")).rejects.toMatchObject({ code: "PATH_INVALID" });
    await expect(tree.read("linked/file")).rejects.toMatchObject({
      code: "PATH_INVALID",
    });
    await expect(filesystemTree(join(root, "linked"))).rejects.toMatchObject({
      code: "PATH_INVALID",
    });
  });
  it("reads large local files over multiple chunks and resolves an explicit file-tree reader", async () => {
    const root = await directory();
    const data = new Uint8Array(262_145).fill(5);
    await writeFile(join(root, "file"), data);
    const tree = await filesystemTree(root);
    expect(await readBytes(tree, "file", data.length)).toEqual(data);
    const readers = fileTree(
      new Map([["file", () => Promise.resolve(memoryFile(data))]]),
    );
    expect(await readBytes(readers, "file", data.length)).toEqual(data);
  });
  it("supports empty directories and validates final CAR bytes", async () => {
    const root = await directory();
    for (const [path, bytes] of controls)
      await writeFile(join(root, path), bytes);
    await mkdir(join(root, "empty"));
    const output = await encodeBundleCar(await filesystemTree(root));
    const decoded = await decode(await consume(output.stream));
    expect((await openBundle(decoded.root, decoded)).kind).toBe("schema");
  });
});
