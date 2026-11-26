import { dirname, resolve } from "node:path";
import { lstat } from "node:fs/promises";
import { openBundle, bundleLimits } from "@ipab/bundle";
import { CID } from "multiformats/cid";
import type { IpfsStore } from "@ipab/ipfs-store";
import { scaffoldFiles, nodeError } from "./authoring.js";
import { relativePath } from "./space.js";
import { HostError } from "./errors.js";

export async function getBundle(
  store: IpfsStore,
  cid: string,
  output = cid,
): Promise<string> {
  await openBundle(CID.parse(cid), {
    resolveCid: (cid) => store.block.get(cid.toString()),
  });
  const files = new Map<string, Uint8Array>();
  let total = 0;
  const visit = async (
    root: CID,
    path: string,
    depth: number,
  ): Promise<void> => {
    if (depth > bundleLimits.depth || files.size > bundleLimits.files)
      throw new HostError("Download tree exceeds Bundle limits.");
    const node = await store.read(root);
    if (node.type === "directory") {
      for await (const item of node.entries()) {
        const target = path ? `${path}/${item.name}` : item.name;
        relativePath(target);
        await visit(item.cid, target, depth + 1);
      }
    } else {
      const chunks: Uint8Array[] = [];
      let size = 0;
      for await (const chunk of node.content()) {
        total += chunk.length;
        size += chunk.length;
        if (total > bundleLimits.bytes)
          throw new HostError("Download exceeds byte budget.");
        chunks.push(chunk);
      }
      const value = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        value.set(chunk, offset);
        offset += chunk.length;
      }
      files.set(path, value);
    }
  };
  await visit(CID.parse(cid), "", 0);
  const directory = resolve(output);
  for (let current = directory; ; current = dirname(current)) {
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory())
        throw new HostError(
          "Download destination must not cross a symlink or file.",
        );
    } catch (cause) {
      if (!nodeError(cause, "ENOENT")) throw cause;
    }
    if (dirname(current) === current) break;
  }
  return scaffoldFiles(directory, files);
}
