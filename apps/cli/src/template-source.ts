import { lstat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CID } from "multiformats/cid";
import { bundleLimits, openBundle } from "@ipab/bundle";
import { encodeBundleCar, type ReadonlyFileTree } from "@ipab/bundle-builder";
import { openContent } from "@ipab/ipfs-store";
import { readCar, selectedTree, type AuthoringOptions } from "./authoring.js";
import { HostError } from "./errors.js";
import { builtinTemplateSchema } from "./template-definition.js";

export async function builtinTemplateSource(
  selector: "node" | "web-app",
  options: AuthoringOptions = {},
) {
  const car = await readCar(
    fileURLToPath(
      new URL(`../dist/builtins/template.${selector}.car`, import.meta.url),
    ),
    options,
  );
  const source = await templateSource(car.root.toString(), {
    ...options,
    resolveCid: car.resolveCid,
  });
  return { ...source, blocks: car.blocks };
}

export async function templateSource(
  source: string,
  options: AuthoringOptions,
) {
  let cid: CID | undefined;
  try {
    cid = CID.parse(source);
  } catch {
    /* A local path is not a CID. */
  }
  let tree: ReadonlyFileTree;
  let identity: string;
  const expected = (await builtinTemplateSchema()).cid.toString();
  if (!cid && (await lstat(resolve(source))).isDirectory()) {
    tree = await selectedTree(
      resolve(source),
      undefined,
      resolve(source, "dist"),
      options,
    );
    const encoded = await encodeBundleCar(tree, options);
    try {
      if (encoded.schema.cid.toString() !== expected)
        throw new HostError(
          "Template Bundle must use the exact builtin project-template type CID.",
        );
      identity = encoded.cid.toString();
    } finally {
      await encoded.close();
    }
  } else {
    let resolver = options.resolveCid;
    if (!cid) {
      if (!source.toLowerCase().endsWith(".car"))
        throw new HostError(
          "Template source must be a Bundle directory, single-root .car or exact CID.",
        );
      const car = await readCar(resolve(source), options);
      cid = car.root;
      resolver = car.resolveCid;
    }
    if (!resolver)
      throw new HostError("Template CID input requires a configured Store.");
    const resolveCid = resolver;
    const bundle = await openBundle(cid, { ...options, resolveCid });
    if (bundle.schemaKey !== expected)
      throw new HostError(
        "Template Bundle must use the exact builtin project-template type CID.",
      );
    identity = cid.toV1().toString();
    const root = identity;
    tree = {
      read: (path, request) => bundle.readFile(path, request),
      async list(path, request = {}) {
        const access = {
          block: {
            get: (key, readOptions) =>
              resolveCid(CID.parse(key), readOptions ?? {}),
          },
        } satisfies Parameters<typeof openContent>[0];
        const settings = {
          ...request,
          signal:
            request.signal ?? options.signal ?? new AbortController().signal,
          cacheBlocks: false,
          retainedBlocks: new Map(),
          retentionBudget: { bytes: 0, limit: bundleLimits.bytes },
          maxBlockBytes: bundleLimits.blockBytes,
          maxDagBlocks: bundleLimits.blocks,
          depth: bundleLimits.depth,
        };
        const node = await openContent(
          access,
          path ? `${root}/${path}` : root,
          settings,
        );
        if (node.type !== "directory")
          throw new HostError("Template project root must be a directory.");
        const entries = [];
        for await (const entry of node.entries()) {
          request.signal?.throwIfAborted();
          const child = await openContent(
            access,
            entry.cid.toString(),
            settings,
          );
          entries.push({
            name: entry.name,
            kind:
              child.type === "directory"
                ? ("directory" as const)
                : ("file" as const),
          });
        }
        return entries;
      },
    };
  }
  return { tree, cid: identity };
}
