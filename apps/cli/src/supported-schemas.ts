import { CarBlockIterator } from "@ipld/car/iterator";
import {
  blockLength,
  createWriter,
  headerLength,
} from "@ipld/car/buffer-writer";
import {
  bundleLimits,
  ContentBundleError,
  decodeSchema,
  encodeSchema,
  parseData,
  type SchemaBlock,
} from "@ipab/bundle";
import {
  readBytes,
  streamChunks,
  type ReadonlyFileTree,
  type ReadOptions,
} from "@ipab/bundle-builder";
import { HostError } from "./errors.js";

export const supportedSchemasPath = "resources/supported-schemas.car";
const carBytes = bundleLimits.bytes + bundleLimits.files * 128;

function budget(signal?: AbortSignal) {
  let work = 0;
  return {
    nodes: bundleLimits.nodes,
    depth: bundleLimits.validationDepth,
    jsonDepth: bundleLimits.jsonDepth,
    schemaBytes: bundleLimits.schemaBytes,
    charge(this: void) {
      signal?.throwIfAborted();
      if (++work > bundleLimits.nodes)
        throw new ContentBundleError(
          "LIMIT_EXCEEDED",
          "Supported Schemas aggregate work budget exceeded.",
        );
    },
  };
}

export async function buildSupportedSchemas(
  tree: ReadonlyFileTree,
  paths: ReadonlySet<string>,
  options: ReadOptions = {},
): Promise<Uint8Array | undefined> {
  if (!paths.size) return undefined;
  if (paths.size > bundleLimits.files)
    throw new HostError("Too many supported Schema source files.");
  const limits = budget(options.signal);
  const blocks = new Map<string, SchemaBlock>();
  let total = 0;
  for (const path of paths) {
    const bytes = await readBytes(
      tree,
      path,
      bundleLimits.schemaBytes,
      options,
    );
    total += bytes.length;
    if (total > bundleLimits.parsingBytes)
      throw new ContentBundleError(
        "LIMIT_EXCEEDED",
        "Supported Schemas source byte budget exceeded.",
      );
    const block = await encodeSchema(
      parseData(
        bytes,
        "application/json",
        limits.nodes,
        limits.jsonDepth,
        limits.charge,
      ),
      limits,
    );
    blocks.set(block.cid.toString(), block);
  }
  const ordered = [...blocks.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, block]) => block);
  const roots = ordered.map((block) => block.cid);
  const size =
    headerLength({ roots }) +
    ordered.reduce((size, block) => size + blockLength(block), 0);
  if (size > carBytes)
    throw new ContentBundleError(
      "LIMIT_EXCEEDED",
      "Supported Schemas CAR byte budget exceeded.",
    );
  const writer = createWriter(new ArrayBuffer(size), { roots });
  for (const block of ordered) writer.write(block);
  return writer.close();
}

export async function readSupportedSchemas(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): Promise<ReadonlySet<string>> {
  const chunks = streamChunks(stream, signal ? { signal } : {});
  const limits = budget(signal);
  let total = 0;
  const bounded = async function* () {
    for await (const chunk of chunks) {
      total += chunk.length;
      if (total > carBytes)
        throw new ContentBundleError(
          "LIMIT_EXCEEDED",
          "Supported Schemas CAR byte budget exceeded.",
        );
      yield chunk;
    }
  };
  try {
    const iterator = await CarBlockIterator.fromIterable(bounded());
    const roots = await iterator.getRoots();
    if (!roots.length || roots.length > bundleLimits.files)
      throw new HostError(
        "Supported Schemas CAR requires a bounded nonempty root list.",
      );
    const supported = new Set(roots.map((root) => root.toString()));
    if (
      supported.size !== roots.length ||
      roots.some(
        (root) =>
          root.version !== 1 ||
          root.code !== 0x71 ||
          root.multihash.code !== 0x12,
      )
    )
      throw new HostError(
        "Supported Schemas CAR requires unique CIDv1 DAG-CBOR SHA-256 roots.",
      );
    const seen = new Set<string>();
    for await (const block of iterator) {
      const key = block.cid.toString();
      if (!supported.has(key) || seen.has(key))
        throw new HostError(
          "Supported Schemas CAR has an unrelated or duplicate block record.",
        );
      await decodeSchema(block.cid, block.bytes, limits);
      seen.add(key);
    }
    if (seen.size !== supported.size)
      throw new HostError("Supported Schemas CAR is missing a root block.");
    return supported;
  } finally {
    await chunks.return(undefined);
  }
}
