import {
  blockLength,
  createWriter,
  headerLength,
} from "@ipld/car/buffer-writer";
import * as dagPb from "@ipld/dag-pb";
import { CID } from "multiformats/cid";
import { importer } from "ipfs-unixfs-importer";
import { fixedSize } from "ipfs-unixfs-importer/chunker";
import { balanced } from "ipfs-unixfs-importer/layout";
import {
  ContentBundleError,
  openBundle,
  resolveBundleLimits,
} from "@ipab/bundle";
import type { BundleLimits, SchemaBlock } from "@ipab/bundle";
import { listTree, streamChunks } from "./tree.js";
import type { ReadonlyFileTree, ReadOptions } from "./tree.js";

export interface BundleCarOptions extends ReadOptions {
  readonly limits?: Partial<BundleLimits>;
  readonly schemaBlocks?: readonly SchemaBlock[];
}
export interface EncodedBundleCar {
  readonly cid: CID;
  readonly stream: ReadableStream<Uint8Array>;
  readonly retainedBytes: number;
  close(): Promise<void>;
}
export async function encodeBundleCar(
  input: ReadonlyFileTree,
  options: BundleCarOptions = {},
): Promise<EncodedBundleCar> {
  const limits = resolveBundleLimits(options.limits);
  options.signal?.throwIfAborted();
  const lifetime = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, lifetime.signal])
    : lifetime.signal;
  const blocks = new Map<string, { cid: CID; bytes: Uint8Array }>();
  let retained = 0;
  const put = async (
    cid: CID,
    value: Uint8Array | Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
  ) => {
    signal.throwIfAborted();
    const parts: Uint8Array[] = [];
    let length = 0;
    for await (const part of value instanceof Uint8Array ? [value] : value) {
      length += part.length;
      if (length > limits.blockBytes)
        throw new ContentBundleError(
          "LIMIT_EXCEEDED",
          "Block byte limit exceeded.",
        );
      parts.push(part);
    }
    const key = cid.toV1().toString();
    if (!blocks.has(key)) {
      if (blocks.size >= limits.blocks || retained + length > limits.bytes)
        throw new ContentBundleError(
          "LIMIT_EXCEEDED",
          "Block count/byte budget exceeded.",
        );
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const part of parts) {
        bytes.set(part, offset);
        offset += part.length;
      }
      blocks.set(key, { cid, bytes });
      retained += length;
    }
    return cid;
  };
  const get = (cid: CID): Promise<Uint8Array> => {
    signal.throwIfAborted();
    const block = blocks.get(cid.toV1().toString());
    if (!block)
      throw new ContentBundleError(
        "CONTENT_UNAVAILABLE",
        `Missing block ${cid.toString()}.`,
      );
    return Promise.resolve(block.bytes);
  };
  const close = () => {
    lifetime.abort(new ContentBundleError("ABORTED", "CAR output closed."));
    blocks.clear();
    retained = 0;
  };
  try {
    const candidates: { path: string; content?: AsyncIterable<Uint8Array> }[] =
      [];
    let nodes = 0,
      files = 0,
      total = 0;
    const content = async function* (path: string) {
      for await (const chunk of streamChunks(
        await input.read(path, { signal }),
        { signal },
      )) {
        total += chunk.length;
        if (total > limits.bytes)
          throw new ContentBundleError(
            "LIMIT_EXCEEDED",
            "Input byte budget exceeded.",
            path,
          );
        yield chunk;
      }
    };
    const walk = async (path: string, depth: number): Promise<void> => {
      if (++nodes > limits.nodes)
        throw new ContentBundleError(
          "LIMIT_EXCEEDED",
          "File tree work budget exceeded.",
          path,
        );
      if (depth > limits.depth)
        throw new ContentBundleError(
          "LIMIT_EXCEEDED",
          "File tree depth exceeded.",
          path,
        );
      for (const entry of await listTree(input, path, { signal })) {
        if (++nodes > limits.nodes)
          throw new ContentBundleError(
            "LIMIT_EXCEEDED",
            "File tree work budget exceeded.",
            path,
          );
        const child = path ? `${path}/${entry.name}` : entry.name;
        if (entry.kind === "directory") {
          candidates.push({ path: child });
          await walk(child, depth + 1);
        } else {
          if (++files > limits.files)
            throw new ContentBundleError(
              "LIMIT_EXCEEDED",
              "File count exceeded.",
            );
          candidates.push({ path: child, content: content(child) });
        }
      }
    };
    await walk("", 0);
    if (!candidates.length)
      throw new ContentBundleError(
        "MANIFEST_INVALID",
        "Bundle requires a nonempty file tree.",
      );
    candidates.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    let root: CID | undefined;
    for await (const entry of importer(
      candidates,
      { put },
      {
        cidVersion: 1,
        rawLeaves: true,
        wrapWithDirectory: true,
        reduceSingleLeafToSelf: true,
        shardSplitThresholdBytes: Number.MAX_SAFE_INTEGER,
        fileImportConcurrency: 1,
        blockWriteConcurrency: 1,
        chunker: fixedSize({ chunkSize: 262_144 }),
        layout: balanced({ maxChildrenPerNode: 174 }),
      },
    ))
      root = entry.cid;
    if (!root)
      throw new ContentBundleError(
        "MANIFEST_INVALID",
        "Bundle requires a nonempty file tree.",
      );
    for (const schema of options.schemaBlocks ?? [])
      await put(schema.cid, schema.bytes);
    const bundle = await openBundle(root, { resolveCid: get, signal, limits });
    const reached = new Map<string, { cid: CID; bytes: Uint8Array }>();
    const reach = async (cid: CID, depth: number): Promise<void> => {
      const key = cid.toV1().toString();
      if (reached.has(key)) return;
      if (depth > limits.depth)
        throw new ContentBundleError(
          "LIMIT_EXCEEDED",
          "CAR DAG depth exceeded.",
        );
      const bytes = await get(cid);
      reached.set(key, { cid, bytes });
      if (cid.code === dagPb.code)
        for (const link of dagPb.decode(bytes).Links)
          await reach(link.Hash, depth + 1);
    };
    await reach(root, 0);
    await reach(bundle.schema.cid, 0);
    const ordered = [...reached.values()]
      .filter((block) => !block.cid.equals(root))
      .sort((a, b) => {
        const left = a.cid.bytes,
          right = b.cid.bytes;
        for (let i = 0; i < Math.min(left.length, right.length); i++)
          if (left[i] !== right[i]) return left[i]! - right[i]!;
        return left.length - right.length;
      });
    ordered.unshift({ cid: root, bytes: await get(root) });
    const headerSize = headerLength({ roots: [root] });
    async function* output() {
      signal.throwIfAborted();
      yield createWriter(new ArrayBuffer(headerSize), {
        roots: [root!],
      }).close();
      for (const block of ordered) {
        signal.throwIfAborted();
        const record = createWriter(new ArrayBuffer(blockLength(block)), {
          headerSize: 0,
        });
        record.write({ cid: block.cid, bytes: await get(block.cid) });
        yield record.bytes;
      }
    }
    const iterator = output();
    let stopped = false;
    const release = async () => {
      if (!stopped) {
        stopped = true;
        await iterator.return(undefined);
        close();
      }
    };
    const stream = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          try {
            const item = await iterator.next();
            if (item.done) {
              await release();
              controller.close();
            } else controller.enqueue(item.value);
          } catch (cause) {
            try {
              await release();
            } finally {
              controller.error(cause);
            }
          }
        },
        cancel: release,
      },
      { highWaterMark: 0 },
    );
    const rootBytes = Uint8Array.from(root.bytes);
    return Object.freeze({
      get cid() {
        return CID.decode(Uint8Array.from(rootBytes));
      },
      stream,
      get retainedBytes() {
        return retained;
      },
      close: release,
    });
  } catch (cause) {
    close();
    throw cause;
  }
}
