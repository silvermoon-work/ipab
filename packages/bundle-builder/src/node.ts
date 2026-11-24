import { lstat, readdir, open } from "node:fs/promises";
import { resolve, relative, sep, isAbsolute } from "node:path";
import { constants } from "node:fs";
import { ContentBundleError, safePath } from "@ipab/bundle";
import type { ReadonlyFileTree, ReadOptions } from "./tree.js";

/** Explicit directory-bound adapter. Symlinks are rejected, including ancestors under the bound. */
export async function filesystemTree(
  directory: string,
  optionsForTree: {
    exclude?: (path: string, directory: boolean) => boolean;
  } = {},
): Promise<ReadonlyFileTree> {
  const root = resolve(directory);
  const checked = async (path: string, options: ReadOptions = {}) => {
    options.signal?.throwIfAborted();
    if (path) safePath(path);
    const absolute = resolve(root, ...path.split("/"));
    const child = relative(root, absolute);
    if (isAbsolute(child) || child === ".." || child.startsWith(`..${sep}`))
      throw new ContentBundleError(
        "PATH_INVALID",
        "Path escapes directory bound.",
        path,
      );
    let current = root;
    for (const part of ["", ...path.split("/").filter(Boolean)]) {
      if (part) current = resolve(current, part);
      const stat = await lstat(current);
      if (stat.isSymbolicLink())
        throw new ContentBundleError(
          "PATH_INVALID",
          "Symlinks are not supported.",
          path,
        );
    }
    return absolute;
  };
  const stat = await lstat(await checked(""));
  if (!stat.isDirectory())
    throw new ContentBundleError(
      "PATH_INVALID",
      "Filesystem tree requires a directory.",
    );
  return {
    async list(path, options = {}) {
      const entries = await readdir(await checked(path, options), {
        withFileTypes: true,
      });
      return entries
        .filter(
          (entry) =>
            !optionsForTree.exclude?.(
              path ? `${path}/${entry.name}` : entry.name,
              entry.isDirectory(),
            ),
        )
        .map((entry) => {
          if (!entry.isFile() && !entry.isDirectory())
            throw new ContentBundleError(
              "PATH_INVALID",
              "Only regular files and directories are supported.",
              entry.name,
            );
          return {
            name: entry.name,
            kind: entry.isDirectory()
              ? ("directory" as const)
              : ("file" as const),
          };
        });
    },
    async read(path, options = {}) {
      const absolute = await checked(path, options);
      const handle = await open(
        absolute,
        constants.O_RDONLY |
          ((constants.O_NOFOLLOW as number | undefined) ?? 0),
      );
      const stat = await handle.stat();
      if (!stat.isFile()) {
        await handle.close();
        throw new ContentBundleError(
          "PATH_INVALID",
          "Expected a regular file.",
          path,
        );
      }
      let offset = 0;
      let closed = false;
      const close = async () => {
        if (!closed) {
          closed = true;
          await handle.close();
        }
      };
      return new ReadableStream<Uint8Array>(
        {
          async pull(controller) {
            try {
              options.signal?.throwIfAborted();
              const bytes = new Uint8Array(262_144);
              const result = await handle.read(bytes, 0, bytes.length, offset);
              options.signal?.throwIfAborted();
              if (!result.bytesRead) {
                await close();
                controller.close();
              } else {
                offset += result.bytesRead;
                controller.enqueue(bytes.subarray(0, result.bytesRead));
              }
            } catch (cause) {
              try {
                await close();
              } finally {
                controller.error(cause);
              }
            }
          },
          cancel: close,
        },
        { highWaterMark: 0 },
      );
    },
  };
}
