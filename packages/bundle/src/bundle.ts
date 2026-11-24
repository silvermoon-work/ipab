import { ContentError, IpfsStore, openContent } from "@ipab/ipfs-store";
import type { UnixfsNode } from "@ipab/ipfs-store";
import { CID } from "multiformats/cid";
import { ContentBundleError } from "./errors.js";
import { parseBundleManifest, parseData, safePath } from "./parsing.js";
import { decodeSchema, schemaBlockBytes, validateValue } from "./schema.js";
import type {
  BundleLimits,
  ContentBundle,
  OpenBundleOptions,
  SchemaBlock,
} from "./types.js";

export const bundleLimits: Readonly<BundleLimits> = Object.freeze({
  bytes: 64 * 1024 * 1024,
  blocks: 16_384,
  blockBytes: 2 * 1024 * 1024,
  parsingBytes: 64 * 1024 * 1024,
  files: 2048,
  depth: 64,
  jsonDepth: 64,
  validationDepth: 64,
  manifestBytes: 64 * 1024,
  schemaBytes: schemaBlockBytes,
  documentBytes: 8 * 1024 * 1024,
  nodes: 100_000,
});
export function resolveBundleLimits(
  overrides: Partial<BundleLimits> = {},
): BundleLimits {
  const limits = { ...bundleLimits, ...overrides };
  for (const [key, value] of Object.entries(limits))
    if (
      !Object.hasOwn(bundleLimits, key) ||
      !Number.isSafeInteger(value) ||
      value <= 0
    )
      throw new ContentBundleError(
        "OPTIONS_INVALID",
        "Limits must be known positive safe integers.",
      );
  return limits;
}
function contextual(
  cause: unknown,
  path: string,
  pointer = "",
  chain: readonly string[] = [],
  signal?: AbortSignal,
): ContentBundleError {
  if (cause instanceof ContentBundleError)
    return new ContentBundleError(
      cause.code,
      cause.message,
      cause.path || path,
      cause.pointer || pointer,
      [...chain, ...cause.referenceChain],
      { cause },
    );
  const capacity =
    (cause instanceof ContentError && cause.code === "capacity_exceeded") ||
    (cause instanceof Error && /capacity exceeded/u.test(cause.message));
  return new ContentBundleError(
    signal?.aborted
      ? "ABORTED"
      : capacity
        ? "LIMIT_EXCEEDED"
        : "CONTENT_UNAVAILABLE",
    "Cannot read or verify bundle content.",
    path,
    pointer,
    chain,
    { cause },
  );
}
async function collect(node: UnixfsNode, maximum: number): Promise<Uint8Array> {
  if (node.type === "directory")
    throw new ContentBundleError("CONTENT_INVALID", "Expected a regular file.");
  if (node.size > BigInt(maximum))
    throw new ContentBundleError(
      "LIMIT_EXCEEDED",
      "File exceeds its parsing byte limit.",
    );
  const parts: Uint8Array[] = [];
  let length = 0;
  for await (const part of node.content()) {
    length += part.byteLength;
    if (length > maximum)
      throw new ContentBundleError(
        "LIMIT_EXCEEDED",
        "File exceeds its parsing byte limit.",
      );
    parts.push(part);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
}
function reader(
  root: CID,
  files: ReadonlySet<string>,
  source: OpenBundleOptions,
  limits: BundleLimits,
): ContentBundle["readFile"] {
  return async (path, request = {}) => {
    safePath(path);
    if (!files.has(path))
      throw new ContentBundleError(
        "CONTENT_UNAVAILABLE",
        "Bundle file does not exist.",
        path,
      );
    const lifetime = new AbortController();
    const signal = request.signal
      ? AbortSignal.any([request.signal, lifetime.signal])
      : lifetime.signal;
    let node: Awaited<ReturnType<typeof openContent>>;
    const seen = new Set<string>();
    let bytesRead = 0;
    try {
      node = await openContent(
        {
          block: {
            get: async (value, options) => {
              const cid = CID.parse(value);
              const bytes = await source.resolveCid(cid, options ?? {});
              const key = cid.toV1().toString();
              if (!seen.has(key)) {
                seen.add(key);
                bytesRead += bytes.byteLength;
                if (bytesRead > limits.bytes || seen.size > limits.blocks)
                  throw new ContentBundleError(
                    "LIMIT_EXCEEDED",
                    "File stream block/byte budget exceeded.",
                    path,
                  );
              }
              return bytes;
            },
          },
        },
        `${root.toString()}/${path}`,
        {
          cacheBlocks: false,
          signal,
          retainedBlocks: new Map(),
          retentionBudget: { bytes: 0, limit: limits.bytes },
          maxBlockBytes: limits.blockBytes,
          maxDagBlocks: limits.blocks,
          depth: limits.depth,
        },
      );
      if (node.type !== "raw" && node.type !== "file")
        throw new ContentBundleError(
          "CONTENT_INVALID",
          "Expected a file.",
          path,
        );
    } catch (cause) {
      throw contextual(cause, path, "", [], signal);
    }
    const iterator = node.content()[Symbol.asyncIterator]();
    let finished = false;
    const release = async () => {
      if (!finished) {
        finished = true;
        lifetime.abort();
        await iterator.return();
      }
    };
    return new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          try {
            signal.throwIfAborted();
            const part = await iterator.next();
            if (part.done) {
              await release();
              controller.close();
            } else controller.enqueue(Uint8Array.from(part.value));
          } catch (cause) {
            const error = contextual(cause, path, "", [], signal);
            try {
              await release();
            } finally {
              controller.error(error);
            }
          }
        },
        cancel: release,
      },
      { highWaterMark: 0 },
    );
  };
}

async function operation(
  rootCid: CID,
  options: OpenBundleOptions,
  expected?: SchemaBlock,
): Promise<ContentBundle> {
  const limits = resolveBundleLimits(options.limits);
  if (typeof options.resolveCid !== "function")
    throw new ContentBundleError(
      "OPTIONS_INVALID",
      "A CID block resolver is required.",
    );
  const cid = CID.decode(Uint8Array.from(rootCid.bytes));
  if (cid.code !== 0x70)
    throw new ContentBundleError(
      "CONTENT_INVALID",
      "Bundle root must be a UnixFS directory CID.",
    );
  const store = IpfsStore.fromClient(
    {
      block: {
        get: async (value, request) =>
          options.resolveCid(CID.parse(value), request ?? {}),
      },
    },
    {
      bytes: limits.bytes,
      blocks: limits.blocks,
      blockBytes: limits.blockBytes,
      depth: limits.depth,
    },
  );
  const request = options.signal ? { signal: options.signal } : {};
  const files = new Set<string>();
  const directories = new Set<string>();
  let parsed = 0,
    work = 0;
  const charge = () => {
    if (options.signal?.aborted)
      throw new ContentBundleError(
        "ABORTED",
        "Bundle validation cancelled.",
        "",
        "",
        [],
        { cause: options.signal.reason },
      );
    if (++work > limits.nodes)
      throw new ContentBundleError(
        "LIMIT_EXCEEDED",
        "Schema/data work budget exceeded.",
      );
  };
  const join = (base: string, path: string) =>
    base ? `${base}/${safePath(path)}` : safePath(path);
  const read = (path: string) =>
    store.read(path ? `${cid.toString()}/${path}` : cid, request);
  const bytesAt = async (path: string, maximum: number) => {
    if (!files.has(path))
      throw new ContentBundleError(
        "CONTENT_UNAVAILABLE",
        "Bundle file does not exist.",
        path,
      );
    const bytes = await collect(await read(path), maximum);
    parsed += bytes.byteLength;
    if (parsed > limits.parsingBytes)
      throw new ContentBundleError(
        "LIMIT_EXCEEDED",
        "Parsing byte budget exceeded.",
        path,
      );
    return bytes;
  };
  const index = async (path: string, depth: number): Promise<void> => {
    charge();
    if (depth > limits.depth)
      throw new ContentBundleError(
        "LIMIT_EXCEEDED",
        "Tree depth exceeded.",
        path,
      );
    const node = await read(path);
    if (node.type === "directory") {
      if (directories.has(path))
        throw new ContentBundleError(
          "PATH_INVALID",
          "Duplicate directory.",
          path,
        );
      directories.add(path);
      for await (const child of node.entries()) {
        if (child.name.includes("/"))
          throw new ContentBundleError(
            "PATH_INVALID",
            "Unsafe directory name.",
            path,
          );
        await index(join(path, child.name), depth + 1);
      }
    } else {
      if (!path || files.has(path))
        throw new ContentBundleError(
          "PATH_INVALID",
          "Invalid or duplicate file.",
          path,
        );
      if (files.size >= limits.files)
        throw new ContentBundleError(
          "LIMIT_EXCEEDED",
          "File count exceeded.",
          path,
        );
      files.add(path);
    }
  };
  try {
    await store.prepare(cid, request);
    await index("", 0);
    const manifest = parseBundleManifest(
      await bytesAt(".bundle.yaml", limits.manifestBytes),
      limits.manifestBytes,
      charge,
    );
    const schemaCid = CID.parse(manifest.entry.schemaCid);
    if (expected && !schemaCid.equals(expected.cid))
      throw new ContentBundleError(
        "SCHEMA_INVALID",
        "Schema CID differs from the explicit validator.",
      );
    let schema: SchemaBlock;
    try {
      const bytes = await store.block.get(schemaCid.toString(), request);
      parsed += bytes.byteLength;
      if (parsed > limits.parsingBytes)
        throw new ContentBundleError(
          "LIMIT_EXCEEDED",
          "Parsing byte budget exceeded.",
        );
      schema = await decodeSchema(schemaCid, bytes, {
        nodes: limits.nodes,
        depth: limits.validationDepth,
        jsonDepth: limits.jsonDepth,
        schemaBytes: limits.schemaBytes,
        charge,
      });
    } catch (cause) {
      throw contextual(cause, schemaCid.toString(), "", [], options.signal);
    }
    const path = manifest.entry.path;
    try {
      const value = parseData(
        await bytesAt(path, limits.documentBytes),
        manifest.entry.contentType,
        limits.nodes,
        limits.jsonDepth,
        charge,
      );
      validateValue(schema, value, { charge, depth: limits.validationDepth });
    } catch (cause) {
      throw contextual(cause, path, "", [], options.signal);
    }
    return Object.freeze({
      kind: "content",
      get cid() {
        return CID.decode(Uint8Array.from(cid.bytes));
      },
      manifest,
      schemaKey: schemaCid.toString(),
      schema,
      readFile: reader(cid, files, options, limits),
    });
  } catch (cause) {
    throw contextual(cause, cid.toString(), "", [], options.signal);
  } finally {
    await store.close();
  }
}
export async function openBundle(
  root: CID,
  options: OpenBundleOptions,
): Promise<ContentBundle> {
  return operation(root, options);
}
export async function openSchema(
  root: CID,
  options: OpenBundleOptions,
): Promise<SchemaBlock> {
  const limits = resolveBundleLimits(options.limits);
  if (typeof options.resolveCid !== "function")
    throw new ContentBundleError(
      "OPTIONS_INVALID",
      "A CID block resolver is required.",
    );
  if (root.version !== 1 || root.code !== 0x71 || root.multihash.code !== 0x12)
    throw new ContentBundleError(
      "SCHEMA_INVALID",
      "Schema must be a CIDv1 DAG-CBOR SHA-256 block.",
    );
  let work = 0;
  try {
    options.signal?.throwIfAborted();
    const bytes = await options.resolveCid(
      root,
      options.signal ? { signal: options.signal } : {},
    );
    if (
      bytes.length >
      Math.min(limits.blockBytes, limits.bytes, limits.parsingBytes)
    )
      throw new ContentBundleError(
        "LIMIT_EXCEEDED",
        "Schema read byte budget exceeded.",
      );
    return await decodeSchema(root, bytes, {
      nodes: limits.nodes,
      depth: limits.validationDepth,
      jsonDepth: limits.jsonDepth,
      schemaBytes: limits.schemaBytes,
      charge() {
        options.signal?.throwIfAborted();
        if (++work > limits.nodes)
          throw new ContentBundleError(
            "LIMIT_EXCEEDED",
            "Schema work budget exceeded.",
          );
      },
    });
  } catch (cause) {
    throw contextual(cause, root.toString(), "", [], options.signal);
  }
}
export async function validateContentBundle(
  root: CID,
  schema: SchemaBlock,
  options: OpenBundleOptions,
): Promise<ContentBundle> {
  return operation(root, options, schema);
}
