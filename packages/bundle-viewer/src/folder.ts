import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { safePath } from "@ipab/bundle/data";

export async function folderSnapshot(directory: string, signal: AbortSignal) {
  const root = resolve(directory);
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
    throw new Error(
      "Viewer folder must be a real directory, not a symbolic link",
    );
  const identity = await realpath(root);
  const files = new Map<string, Uint8Array>();
  let total = 0;
  async function read(path: string): Promise<Uint8Array> {
    signal.throwIfAborted();
    safePath(path);
    let current = root;
    for (const part of path.split("/")) {
      current = resolve(current, part);
      const info = await lstat(current);
      if (info.isSymbolicLink())
        throw new Error(`Viewer folder rejects symbolic links: ${path}`);
    }
    const actual = await realpath(current);
    const within = relative(identity, actual);
    if (
      !within ||
      isAbsolute(within) ||
      within === ".." ||
      within.startsWith(`..${sep}`) ||
      (await realpath(root)) !== identity
    )
      throw new Error(`Viewer resource escaped its folder: ${path}`);
    const file = await open(current, "r");
    try {
      const before = await file.stat();
      if (!before.isFile() || before.size > 1024 * 1024)
        throw new Error(
          `Viewer resource must be a regular file within 1 MiB: ${path}`,
        );
      const bytes = new Uint8Array(before.size);
      let offset = 0;
      while (offset < bytes.length) {
        signal.throwIfAborted();
        const part = await file.read(
          bytes,
          offset,
          bytes.length - offset,
          offset,
        );
        if (!part.bytesRead)
          throw new Error(`Viewer resource changed while reading: ${path}`);
        offset += part.bytesRead;
      }
      const after = await file.stat();
      const now = await lstat(current);
      if (
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs ||
        now.isSymbolicLink() ||
        now.ino !== before.ino ||
        now.dev !== before.dev ||
        (await realpath(current)) !== actual ||
        (await realpath(root)) !== identity
      )
        throw new Error(`Viewer resource changed while reading: ${path}`);
      return bytes;
    } finally {
      await file.close();
    }
  }
  return {
    async readFile(path: string) {
      let bytes = files.get(path);
      if (!bytes) {
        if (files.size >= 258)
          throw new Error("Viewer folder exceeds 258 input files");
        bytes = await read(path);
        total += bytes.byteLength;
        if (total > 3 * 1024 * 1024)
          throw new Error("Viewer folder inputs exceed 3 MiB");
        files.set(path, bytes);
      }
      const content = bytes;
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(content);
          controller.close();
        },
      });
    },
    async verify() {
      for (const [path, bytes] of files) {
        const current = await read(path);
        if (
          current.length !== bytes.length ||
          current.some((value, index) => value !== bytes[index])
        )
          throw new Error(`Viewer folder changed during loading: ${path}`);
      }
    },
  };
}
