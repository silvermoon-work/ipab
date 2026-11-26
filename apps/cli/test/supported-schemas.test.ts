import { expect, it } from "vitest";
import { bundleLimits, encodeSchema } from "@ipab/bundle";
import { memoryTree } from "@ipab/bundle-builder";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import {
  buildSupportedSchemas,
  readSupportedSchemas,
} from "../src/supported-schemas.js";
import { schemaCar } from "./helpers.js";

it("bounds source counts, individual bytes and aggregate Schema work", async () => {
  const empty = memoryTree(new Map());
  expect(await buildSupportedSchemas(empty, new Set())).toBeUndefined();
  await expect(
    buildSupportedSchemas(
      empty,
      new Set(
        Array.from(
          { length: bundleLimits.files + 1 },
          (_, index) => `schemas/${index}.json`,
        ),
      ),
    ),
  ).rejects.toThrow("Too many");
  await expect(
    buildSupportedSchemas(
      memoryTree(
        new Map([
          ["schemas/large.json", new Uint8Array(bundleLimits.schemaBytes + 1)],
        ]),
      ),
      new Set(["schemas/large.json"]),
    ),
  ).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
  const definition = {
    name: "Collection",
    entry: {
      path: "data.json",
      schema: {
        type: "array",
        items: {
          type: "object",
          properties: Object.fromEntries(
            Array.from({ length: 3000 }, (_, index) => [
              `value-${index}`,
              { type: "string" },
            ]),
          ),
        },
      },
      contentType: "application/json",
    },
  };
  const source = Buffer.from(JSON.stringify(definition));
  await expect(
    buildSupportedSchemas(
      memoryTree(
        new Map([
          ["schemas/a.json", source],
          ["schemas/b.json", source],
        ]),
      ),
      new Set(["schemas/a.json", "schemas/b.json"]),
    ),
  ).rejects.toThrow("aggregate work");
  const blocks = await Promise.all(
    Array.from({ length: 5 }, (_, index) =>
      encodeSchema({ ...definition, name: `Type ${index}` }),
    ),
  );
  await expect(
    readSupportedSchemas(
      ReadableStream.from([
        schemaCar(
          blocks.map((block) => block.cid),
          blocks,
        ),
      ]),
    ),
  ).rejects.toThrow("aggregate work");
});

it("bounds nested CAR bytes/roots/block sizes and cancels an invalid stream", async () => {
  await expect(
    readSupportedSchemas(
      ReadableStream.from([
        new Uint8Array(bundleLimits.bytes + bundleLimits.files * 128 + 1),
      ]),
    ),
  ).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
  const oversized = new Uint8Array(bundleLimits.schemaBytes + 1);
  const cid = CID.createV1(0x71, await sha256.digest(oversized));
  await expect(
    readSupportedSchemas(
      ReadableStream.from([schemaCar([cid], [{ cid, bytes: oversized }])]),
    ),
  ).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
  await expect(
    readSupportedSchemas(
      ReadableStream.from([
        schemaCar(Array<CID>(bundleLimits.files + 1).fill(cid), []),
      ]),
    ),
  ).rejects.toThrow("bounded nonempty");
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        controller.enqueue(schemaCar([], []));
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  await expect(readSupportedSchemas(stream)).rejects.toThrow("nonempty");
  expect(cancelled).toBe(true);
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  await expect(
    readSupportedSchemas(
      ReadableStream.from([Uint8Array.of(1)]),
      controller.signal,
    ),
  ).rejects.toThrow("cancelled");
});
