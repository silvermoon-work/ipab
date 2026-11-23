import { ContentBundleError, safePath } from "@ipab/bundle";

export interface ReadOptions {
  readonly signal?: AbortSignal;
}
export interface TreeEntry {
  readonly name: string;
  readonly kind: "file" | "directory";
}
/** Input lifetime must remain stable until construction completes; every read returns a fresh stream. */
export interface ReadonlyFileTree {
  list(path: string, options?: ReadOptions): Promise<readonly TreeEntry[]>;
  read(
    path: string,
    options?: ReadOptions,
  ): Promise<ReadableStream<Uint8Array>>;
}
export type FileReader = (
  options: ReadOptions,
) => ReadableStream<Uint8Array> | Promise<ReadableStream<Uint8Array>>;
export async function listTree(
  tree: ReadonlyFileTree,
  path: string,
  options: ReadOptions = {},
): Promise<readonly TreeEntry[]> {
  if (path) safePath(path);
  options.signal?.throwIfAborted();
  const entries = await tree.list(path, options);
  const names = new Set<string>();
  for (const entry of entries) {
    safePath(entry.name);
    if (
      entry.name.includes("/") ||
      names.has(entry.name) ||
      !["file", "directory"].includes(entry.kind)
    )
      throw new ContentBundleError(
        "PATH_INVALID",
        "Invalid or duplicate file-tree entry.",
        path,
      );
    names.add(entry.name);
  }
  return [...entries].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
}
export function memoryFile(
  bytes: Uint8Array,
  options: ReadOptions = {},
): ReadableStream<Uint8Array> {
  let sent = false;
  return new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        options.signal?.throwIfAborted();
        if (sent) controller.close();
        else {
          sent = true;
          controller.enqueue(Uint8Array.from(bytes));
        }
      },
    },
    { highWaterMark: 0 },
  );
}
export function fileTree(
  files: ReadonlyMap<string, FileReader>,
): ReadonlyFileTree {
  const readers = new Map(files);
  const directories = new Map<string, Map<string, TreeEntry>>([
    ["", new Map()],
  ]);
  for (const path of readers.keys()) {
    safePath(path);
    let parent = "";
    const parts = path.split("/");
    for (const [index, name] of parts.entries()) {
      const kind = index === parts.length - 1 ? "file" : "directory";
      const children = directories.get(parent)!;
      const previous = children.get(name);
      if (previous && previous.kind !== kind)
        throw new ContentBundleError(
          "PATH_INVALID",
          "File/directory collision.",
          path,
        );
      children.set(name, { name, kind });
      if (kind === "directory") {
        parent = parent ? `${parent}/${name}` : name;
        if (!directories.has(parent)) directories.set(parent, new Map());
      }
    }
  }
  return Object.freeze({
    list(path: string, options: ReadOptions = {}) {
      return Promise.resolve().then(() => {
        if (path) safePath(path);
        options.signal?.throwIfAborted();
        const entries = directories.get(path);
        if (!entries)
          throw new ContentBundleError(
            "PATH_INVALID",
            "Directory not found.",
            path,
          );
        return [...entries.values()].map((entry) => ({ ...entry }));
      });
    },
    async read(path: string, options: ReadOptions = {}) {
      safePath(path);
      options.signal?.throwIfAborted();
      const read = readers.get(path);
      if (!read)
        throw new ContentBundleError(
          "CONTENT_UNAVAILABLE",
          "File not found.",
          path,
        );
      return read(options);
    },
  });
}
export function memoryTree(
  files: ReadonlyMap<string, Uint8Array>,
): ReadonlyFileTree {
  return fileTree(
    new Map(
      [...files].map(([path, bytes]) => {
        const owned = Uint8Array.from(bytes);
        return [path, (options: ReadOptions) => memoryFile(owned, options)];
      }),
    ),
  );
}
export async function* streamChunks(
  stream: ReadableStream<Uint8Array>,
  options: ReadOptions = {},
): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  let complete = false;
  let abort = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    abort = () => {
      reject(
        new ContentBundleError("ABORTED", "File read cancelled.", "", "", [], {
          cause: options.signal?.reason,
        }),
      );
    };
  });
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    for (;;) {
      options.signal?.throwIfAborted();
      const item = await Promise.race([reader.read(), aborted]);
      options.signal?.throwIfAborted();
      if (item.done) {
        complete = true;
        return;
      }
      if (!(item.value instanceof Uint8Array))
        throw new ContentBundleError(
          "CONTENT_INVALID",
          "File stream must contain byte arrays.",
        );
      yield Uint8Array.from(item.value);
    }
  } finally {
    options.signal?.removeEventListener("abort", abort);
    try {
      if (!complete) await reader.cancel();
    } finally {
      reader.releaseLock();
    }
  }
}
export async function readBytes(
  tree: ReadonlyFileTree,
  path: string,
  maximum: number,
  options: ReadOptions = {},
): Promise<Uint8Array> {
  safePath(path);
  const parts: Uint8Array[] = [];
  let length = 0;
  for await (const part of streamChunks(
    await tree.read(path, options),
    options,
  )) {
    length += part.byteLength;
    if (length > maximum)
      throw new ContentBundleError(
        "LIMIT_EXCEEDED",
        "File exceeds byte limit.",
        path,
      );
    parts.push(part);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}
