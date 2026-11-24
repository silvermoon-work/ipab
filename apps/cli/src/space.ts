import { importer } from "ipfs-unixfs-importer";
import { UnixFS } from "ipfs-unixfs";
import * as dagPb from "@ipld/dag-pb";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import type { IpfsStore } from "@ipab/ipfs-store";
import { openBundle, type ContentBundle } from "@ipab/bundle";
import { HostError, message } from "./errors.js";
import type { Ownership } from "./history.js";
import { appDescription, appSchemaCid } from "./app-definition.js";
import { readSupportedSchemas } from "./supported-schemas.js";
export { appSchema, appSchemaCid } from "./app-definition.js";
export const CHUNK_BYTES = 64 * 1024;
export const OUTPUT_BYTES = 64 * 1024 * 1024;
export const MAX_PATHS = 4096;

export function relativePath(path: string): string {
  if (
    path.length > 1024 ||
    !path ||
    path.includes("\\") ||
    path.includes("%") ||
    [...path].some(
      (char) =>
        char.charCodeAt(0) < 32 ||
        char.charCodeAt(0) === 127 ||
        ':*?"<>|'.includes(char),
    ) ||
    path
      .split("/")
      .some(
        (part) => !part || part === "." || part === ".." || /[. ]$/.test(part),
      )
  )
    throw new HostError(
      "Unsafe Space path; use an unambiguous directory-relative / path.",
      1,
      "PATH_INVALID",
      "execution",
    );
  return path;
}

export async function bytes(
  stream: ReadableStream<Uint8Array>,
  limit: number,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > limit)
        throw new HostError(
          "Resource exceeds its byte limit.",
          1,
          "LIMIT_EXCEEDED",
          "validation",
        );
      parts.push(item.value);
    }
  } catch (error) {
    await reader.cancel(error);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

export async function validatedBundle(
  root: string,
  store: IpfsStore,
  owner: Ownership,
  signal?: AbortSignal,
): Promise<ContentBundle> {
  await owner.retain([root], signal);
  return openBundle(CID.parse(root), {
    ...(signal ? { signal } : {}),
    resolveCid: async (cid, options) => {
      await owner.retain([cid.toV1().toString()], options.signal);
      return store.block.get(cid.toString(), options);
    },
  });
}

export async function loadApp(
  root: string,
  store: IpfsStore,
  owner: Ownership,
  signal?: AbortSignal,
): Promise<{
  path: string;
  source: Uint8Array;
  supportedSchemas: ReadonlySet<string>;
}> {
  const bundle = await validatedBundle(root, store, owner, signal);
  if (
    bundle.schemaKey !== appSchemaCid.toString() ||
    bundle.manifest.entry.contentType !== "application/json"
  )
    throw new HostError(
      "App must use the documented exact builtin Node App type CID.",
      1,
      "APP_PROFILE_INVALID",
      "validation",
    );
  const description = appDescription(
    JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        await bytes(
          await bundle.readFile(bundle.manifest.entry.path),
          64 * 1024,
        ),
      ),
    ) as unknown,
  );
  if (description.icon !== undefined) {
    const icon = relativePath(description.icon);
    if (!icon.startsWith("resources/"))
      throw new HostError(
        "App icon must be a Bundle-root-relative resources/ file.",
      );
    const stream = await bundle.readFile(icon);
    await stream.cancel();
  }
  const path = relativePath(description.entry);
  if (!path.startsWith("resources/") || !path.endsWith(".cjs"))
    throw new HostError(
      "Node App entry must be a resources/*.cjs file.",
      1,
      "APP_PROFILE_INVALID",
      "validation",
    );
  let supportedSchemas: ReadonlySet<string> = new Set();
  if (description.supportedSchemas !== undefined) {
    const schemasPath = relativePath(description.supportedSchemas);
    if (!schemasPath.startsWith("resources/") || schemasPath === path)
      throw new HostError(
        "App supportedSchemas must be a distinct Bundle-root-relative resources/ regular file.",
      );
    supportedSchemas = await readSupportedSchemas(
      await bundle.readFile(schemasPath),
      signal,
    );
  }
  return {
    path,
    supportedSchemas,
    source: await bytes(await bundle.readFile(path), 8 * 1024 * 1024),
  };
}

interface Entry {
  cid: CID;
  size: bigint;
}
interface Directory {
  entries: Map<string, Entry | Directory>;
}
function isDirectory(entry: Entry | Directory): entry is Directory {
  return "entries" in entry;
}

export class OutputSpace {
  readonly session: string;
  private readonly entries = new Map<string, Entry>();
  private readonly claimed = new Set<string>();
  private readonly pending = new Set<string>();
  private totalBytes = 0;
  private fault: Error | undefined;
  constructor(
    readonly store: IpfsStore,
    readonly owner: Ownership,
    session: string,
    readonly signal?: AbortSignal,
  ) {
    this.session = session;
  }
  private claim(path: string): void {
    relativePath(path);
    if (this.claimed.size >= MAX_PATHS)
      throw new HostError("Output path limit exceeded.");
    for (const previous of this.claimed) {
      if (
        previous === path ||
        previous.startsWith(`${path}/`) ||
        path.startsWith(`${previous}/`)
      )
        throw new HostError("Output paths must be unique and cannot overlap.");
    }
    this.claimed.add(path);
    this.pending.add(path);
  }
  fail(error: unknown): void {
    this.fault ??= new HostError(message(error));
  }
  async write(
    path: string,
    content: AsyncIterable<Uint8Array>,
    signal?: AbortSignal,
  ): Promise<string> {
    signal = this.signal
      ? AbortSignal.any([this.signal, ...(signal ? [signal] : [])])
      : signal;
    try {
      this.claim(path);
      const account = (part: Uint8Array) => {
        this.totalBytes += part.length;
        if (this.totalBytes > OUTPUT_BYTES)
          throw new HostError("Output byte limit exceeded.");
      };
      const checked = async function* () {
        for await (const part of content) {
          if (!(part instanceof Uint8Array) || part.length > CHUNK_BYTES)
            throw new HostError(
              "Output chunks must be byte arrays of at most 65536 bytes.",
            );
          account(part);
          yield part;
        }
      };
      let result: Entry | undefined;
      for await (const item of importer(
        [{ path: "file", content: checked() }],
        {
          put: async (cid, block) => {
            const content =
              block instanceof Uint8Array
                ? block
                : await bytes(
                    ReadableStream.from(block),
                    this.store.limits.blockBytes,
                  );
            await this.store.stageBlock(
              this.session,
              cid,
              content,
              signal ? { signal } : {},
            );
            return cid;
          },
        },
        { cidVersion: 1, rawLeaves: true, wrapWithDirectory: false },
      )) {
        result = { cid: item.cid, size: item.size };
      }
      if (!result) throw new HostError("Output file import produced no root.");
      this.entries.set(path, result);
      this.pending.delete(path);
      return result.cid.toString();
    } catch (error) {
      this.fail(error);
      throw error;
    }
  }
  async link(path: string, root: string, signal?: AbortSignal): Promise<void> {
    signal = this.signal
      ? AbortSignal.any([this.signal, ...(signal ? [signal] : [])])
      : signal;
    try {
      signal?.throwIfAborted();
      this.claim(path);
      const cid = CID.parse(root).toV1();
      const options = signal ? { signal } : {};
      await this.store.read(cid, options);
      signal?.throwIfAborted();
      // Validate/protect the entire UnixFS target, not arbitrary DAG-CBOR, before publishing a link.
      await this.owner.retain([cid.toString()], signal);
      signal?.throwIfAborted();
      const seen = new Map<string, bigint>();
      const size = async (cid: CID, depth: number): Promise<bigint> => {
        signal?.throwIfAborted();
        if (
          depth > this.store.limits.depth ||
          seen.size >= this.store.limits.blocks
        )
          throw new HostError("Linked DAG exceeds resource limits.");
        const key = cid.toString();
        const previous = seen.get(key);
        if (previous !== undefined) return previous;
        await this.store.read(cid, options);
        signal?.throwIfAborted();
        const block = await this.store.block.get(key, options);
        signal?.throwIfAborted();
        await this.store.stageBlock(this.session, cid, block, options);
        signal?.throwIfAborted();
        let total = BigInt(block.length);
        if (cid.code === dagPb.code) {
          for (const link of dagPb.decode(block).Links)
            total += await size(link.Hash, depth + 1);
        } else if (cid.code !== 0x55)
          throw new HostError(
            "Linked content must be a UnixFS file or directory.",
          );
        seen.set(key, total);
        return total;
      };
      const total = await size(cid, 0);
      signal?.throwIfAborted();
      this.entries.set(path, { cid, size: total });
      this.pending.delete(path);
    } catch (error) {
      this.fail(error);
      throw error;
    }
  }
  async finalize(): Promise<string> {
    if (this.fault) throw this.fault;
    if (this.pending.size)
      throw new HostError(
        "Output has unfinished stream writes.",
        1,
        "OUTPUT_PENDING",
        "commit",
      );
    const root: Directory = { entries: new Map() };
    for (const [path, entry] of this.entries) {
      const parts = path.split("/");
      let directory = root;
      for (const name of parts.slice(0, -1)) {
        let child = directory.entries.get(name);
        if (!child) {
          child = { entries: new Map() };
          directory.entries.set(name, child);
        }
        if (!isDirectory(child))
          throw new HostError("Output file/directory collision.");
        directory = child;
      }
      directory.entries.set(parts.at(-1)!, entry);
    }
    const build = async (directory: Directory): Promise<Entry> => {
      const links: dagPb.PBLink[] = [];
      let descendants = 0n;
      for (const [name, child] of [...directory.entries].sort(([a], [b]) =>
        a.localeCompare(b),
      )) {
        const entry = isDirectory(child) ? await build(child) : child;
        if (entry.size > BigInt(Number.MAX_SAFE_INTEGER))
          throw new HostError("UnixFS DAG size exceeds safe limits.");
        descendants += entry.size;
        links.push({ Name: name, Hash: entry.cid, Tsize: Number(entry.size) });
      }
      const block = dagPb.encode(
        dagPb.prepare({
          Data: new UnixFS({ type: "directory" }).marshal(),
          Links: links,
        }),
      );
      const cid = CID.createV1(dagPb.code, await sha256.digest(block));
      await this.store.stageBlock(
        this.session,
        cid,
        block,
        this.signal ? { signal: this.signal } : {},
      );
      return { cid, size: descendants + BigInt(block.length) };
    };
    const directory = await build(root);
    await this.store.finishImport(
      this.session,
      directory.cid,
      this.owner.owner,
      this.signal ? { signal: this.signal } : {},
    );
    await this.owner.retain([directory.cid.toString()], this.signal);
    return directory.cid.toString();
  }
}
