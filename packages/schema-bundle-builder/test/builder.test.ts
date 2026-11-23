import { afterEach, describe, expect, it } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { CarBlockIterator } from "@ipld/car/iterator";
import { canonicalJson, SCHEMA_PROFILE } from "@ipab/bundle";
import { memoryTree, readBytes } from "@ipab/bundle-builder";
import { createSchemaBundleTree, encodeSchemaBundleCar } from "../src/index.js";
import {
  schemaBundleCarFromDirectory,
  schemaBundleTreeFromDirectory,
} from "../src/node.js";

const text = (value: string) => new TextEncoder().encode(value);
const descriptor = {
  schemas: ["z.json", "a.json"],
  main: "urn:example:a",
  title: "Title",
  description: "Description",
};
const files = new Map([
  ["schema.json", text(JSON.stringify(descriptor, null, 2))],
  [
    "a.json",
    text(
      '{ "type":"object", "$id":"urn:example:a", "properties":{"value":{"$ref":"urn:example:z"}} }',
    ),
  ],
  [
    "z.json",
    text(
      '{ "$id":"urn:example:z", "type":"string", "title":"Z", "enum":["z","a"] }',
    ),
  ],
  ["unlisted.json", text("not JSON")],
]);
const paths: string[] = [];
afterEach(async () => {
  for (const path of paths.splice(0))
    await rm(path, { recursive: true, force: true });
});
async function consume(stream: ReadableStream<Uint8Array>) {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  const bytes = new Uint8Array(
    chunks.reduce((sum, chunk) => sum + chunk.length, 0),
  );
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
describe("Schema Bundle normalization", () => {
  it("normalizes JSON objects and descriptor paths, preserves arrays/annotations, ignores ambient files", async () => {
    const tree = await createSchemaBundleTree(memoryTree(files));
    expect(
      new TextDecoder().decode(await readBytes(tree, "schema.json", 65536)),
    ).toBe(
      '{"description":"Description","main":"urn:example:a","schemas":["a.json","z.json"],"title":"Title"}',
    );
    expect(
      new TextDecoder().decode(await readBytes(tree, "z.json", 65536)),
    ).toBe(
      '{"$id":"urn:example:z","enum":["z","a"],"title":"Z","type":"string"}',
    );
    expect(
      JSON.parse(
        new TextDecoder().decode(await readBytes(tree, ".bundle.yaml", 65536)),
      ) as unknown,
    ).toEqual({
      entry: {
        path: "schema.json",
        contentType: "application/json",
        schema: SCHEMA_PROFILE,
      },
    });
    await expect(tree.read("unlisted.json")).rejects.toThrow();
    const encoded = await encodeSchemaBundleCar(memoryTree(files));
    const root = encoded.cid;
    const bytes = await consume(encoded.stream);
    const reordered = new Map<string, Uint8Array>([...files].reverse());
    reordered.set(
      "schema.json",
      canonicalJson({
        ...descriptor,
        schemas: [...descriptor.schemas].reverse(),
      }),
    );
    const again = await encodeSchemaBundleCar(memoryTree(reordered));
    expect(again.cid.equals(root)).toBe(true);
    expect(await consume(again.stream)).toEqual(bytes);
    expect(
      (
        await (
          await CarBlockIterator.fromIterable(ReadableStream.from([bytes]))
        ).getRoots()
      )[0]!.equals(root),
    ).toBe(true);
  });
  it.each([
    ["schema.json", '{"schemas":["a.json"],"main":"urn:missing"}'],
    ["a.json", '{"$id":"urn:example:a","$ref":"urn:outside"}'],
    ["a.json", '{"$id":"urn:example:a","pattern":"unsupported"}'],
    ["a.json", '{"$id":"urn:example:a","$id":"urn:other"}'],
    ["a.json", '{"type":"object"}'],
    ["schema.json", '{"schemas":["../a.json"],"main":"urn:example:a"}'],
    ["schema.json", '{"schemas":[".bundle.yaml"],"main":"urn:example:a"}'],
    ["schema.json", '{"schemas":["schema.json"],"main":"urn:example:a"}'],
    ["schema.json", '{"schemas":[1],"main":"urn:example:a"}'],
    ["schema.json", "{}"],
  ])("rejects invalid local contracts and old syntax", async (path, value) => {
    const invalid = new Map(files);
    invalid.set(path, text(value));
    await expect(createSchemaBundleTree(memoryTree(invalid))).rejects.toThrow();
  });
  it.each([
    "nodes",
    "schemaBytes",
    "descriptorBytes",
    "parsingBytes",
    "schemas",
  ] as const)("enforces shared %s capacity", async (key) => {
    await expect(
      createSchemaBundleTree(memoryTree(files), { limits: { [key]: 1 } }),
    ).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
  });
  it("supports explicit descriptor path and explicit local adapters", async () => {
    const directory = resolve(".test-work", randomUUID());
    paths.push(directory);
    await mkdir(directory, { recursive: true });
    for (const [path, bytes] of files)
      await writeFile(
        join(directory, path === "schema.json" ? "descriptor.json" : path),
        bytes,
      );
    const options = { descriptorPath: "descriptor.json" };
    const tree = await schemaBundleTreeFromDirectory(directory, options);
    expect(await readBytes(tree, "schema.json", 65536)).toEqual(
      canonicalJson({ ...descriptor, schemas: ["a.json", "z.json"] }),
    );
    const encoded = await schemaBundleCarFromDirectory(directory, options);
    expect((await consume(encoded.stream)).length).toBeGreaterThan(100);
    const abort = new AbortController();
    abort.abort(new Error("cancel"));
    await expect(
      createSchemaBundleTree(memoryTree(files), { signal: abort.signal }),
    ).rejects.toThrow("cancel");
  });
});
