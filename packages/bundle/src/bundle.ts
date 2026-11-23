import { ContentError, IpfsStore, openContent } from "@ipab/ipfs-store";
import type { UnixfsNode } from "@ipab/ipfs-store";
import { CID } from "multiformats/cid";
import { ContentBundleError } from "./errors.js";
import {
  SCHEMA_PROFILE,
  parseBundleManifest,
  parseContentRef,
  parseData,
  rootPath,
  safePath,
} from "./parsing.js";
import { inspectSchemaBundle, validateValue } from "./schema.js";
import type {
  BundleLimits,
  BundleManifest,
  ContentBundle,
  ContentType,
  OpenBundleOptions,
  SchemaBundle,
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
  descriptorBytes: 64 * 1024,
  schemaBytes: 1024 * 1024,
  documentBytes: 8 * 1024 * 1024,
  schemas: 128,
  references: 4096,
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
  expected?: SchemaBundle,
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
  const directories = new Map<string, CID>();
  const manifests = new Map<string, BundleManifest>();
  const schemas = new Map<string, SchemaBundle>();
  const bundles = new Map<string, ContentBundle>();
  const tasks = new Map<
    string,
    { state: "pending" | "done"; dependencies: ReadonlySet<string> }
  >();
  const pending = new Set<string>();
  const bundleDependencies = new Map<string, ReadonlySet<string>>();
  let parsed = 0,
    work = 0,
    schemaFiles = 0,
    references = 0;
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
      directories.set(path, node.cid);
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
  const manifestAt = async (base: string) => {
    let manifest = manifests.get(base);
    if (!manifest) {
      if (!directories.has(base))
        throw new ContentBundleError(
          "REFERENCE_INVALID",
          "Bundle must identify a directory.",
          base,
        );
      manifest = parseBundleManifest(
        await bytesAt(join(base, ".bundle.yaml"), limits.manifestBytes),
        limits.manifestBytes,
        charge,
      );
      manifests.set(base, manifest);
    }
    return manifest;
  };
  const fileReader = (base: string) =>
    reader(
      directories.get(base)!,
      new Set(
        [...files]
          .filter((path) => !base || path.startsWith(`${base}/`))
          .map((path) => (base ? path.slice(base.length + 1) : path)),
      ),
      options,
      limits,
    );
  const loadSchema = async (base: string): Promise<SchemaBundle> => {
    const cached = schemas.get(base);
    if (cached) return cached;
    try {
      const manifest = await manifestAt(base);
      if (
        manifest.entry.schema !== SCHEMA_PROFILE ||
        manifest.entry.contentType !== "application/json"
      )
        throw new ContentBundleError(
          "SCHEMA_INVALID",
          "Expected a Schema Bundle using the fixed builtin profile.",
        );
      const descriptor = parseData(
        await bytesAt(join(base, manifest.entry.path), limits.descriptorBytes),
        "application/json",
        limits.nodes,
        limits.jsonDepth,
        charge,
      );
      const listed =
        typeof descriptor === "object" &&
        descriptor !== null &&
        "schemas" in descriptor
          ? descriptor.schemas
          : undefined;
      const values = new Map<string, unknown>();
      if (Array.isArray(listed))
        for (const path of listed) {
          if (typeof path !== "string")
            throw new ContentBundleError(
              "SCHEMA_INVALID",
              "Schema paths must be strings.",
            );
          if (++schemaFiles > limits.schemas)
            throw new ContentBundleError(
              "LIMIT_EXCEEDED",
              "Shared schema file budget exceeded.",
            );
          values.set(
            path,
            parseData(
              await bytesAt(join(base, path), limits.schemaBytes),
              "application/json",
              limits.nodes,
              limits.jsonDepth,
              charge,
            ),
          );
        }
      const definitions = inspectSchemaBundle(descriptor, values, {
        nodes: limits.nodes,
        depth: limits.validationDepth,
        jsonDepth: limits.jsonDepth,
        schemas: limits.schemas,
        charge,
      });
      const schemaCid = directories.get(base)!;
      const bundle: SchemaBundle = Object.freeze({
        kind: "schema",
        get cid() {
          return CID.decode(Uint8Array.from(schemaCid.bytes));
        },
        manifest,
        schemaKey: SCHEMA_PROFILE,
        ...definitions,
        readFile: fileReader(base),
      });
      schemas.set(base, bundle);
      bundles.set(base, bundle);
      return bundle;
    } catch (cause) {
      if (
        cause instanceof ContentBundleError &&
        cause.code === "CONTENT_INVALID"
      )
        throw new ContentBundleError(
          "SCHEMA_INVALID",
          cause.message,
          cause.path || base,
          cause.pointer,
          cause.referenceChain,
          { cause },
        );
      throw contextual(cause, base, "", [], options.signal);
    }
  };
  const content = async (
    base: string,
    path: string,
    schema: SchemaBundle,
    id: string,
    type: ContentType,
    depth: number,
    chain: readonly string[],
    branch: boolean,
  ): Promise<ReadonlySet<string>> => {
    const absolute = join(base, path);
    const key = JSON.stringify([
      base,
      absolute,
      schema.cid.toString(),
      id,
      type,
    ]);
    const cached = tasks.get(key);
    if (cached?.state === "done") {
      const dependencies = new Set(
        [...cached.dependencies].filter((dependency) =>
          pending.has(dependency),
        ),
      );
      if (branch && dependencies.size)
        throw new ContentBundleError(
          "REFERENCE_INVALID",
          "Cyclic anyOf content dependency is unsupported.",
          absolute,
          "",
          chain,
        );
      return dependencies;
    }
    if (cached?.state === "pending") {
      if (branch)
        throw new ContentBundleError(
          "REFERENCE_INVALID",
          "Cyclic anyOf content dependency is unsupported.",
          absolute,
          "",
          chain,
        );
      return new Set([key]);
    }
    if (++references > limits.references || depth > limits.validationDepth)
      throw new ContentBundleError(
        "LIMIT_EXCEEDED",
        "Content task/depth budget exceeded.",
        absolute,
      );
    const dependencies = new Set<string>();
    tasks.set(key, { state: "pending", dependencies });
    pending.add(key);
    try {
      const value = parseData(
        await bytesAt(absolute, limits.documentBytes),
        type,
        limits.nodes,
        limits.jsonDepth,
        charge,
      );
      await validateValue(schema, id, value, {
        charge,
        depth: limits.validationDepth,
        async reference(rule, text, pointer, inBranch) {
          const next = [...chain, `${absolute}#${pointer} -> ${text}`];
          try {
            const ref = parseContentRef(text, rule);
            if (ref.kind === "bundle") {
              const childBase = join(base, ref.path);
              await validateBundle(
                childBase,
                depth + 1,
                next,
                branch || inBranch,
              );
              for (const dependency of bundleDependencies.get(childBase) ?? [])
                if (pending.has(dependency)) dependencies.add(dependency);
            } else {
              const childDependencies = await content(
                base,
                ref.path,
                schema,
                ref.target,
                `application/${ref.kind}`,
                depth + 1,
                next,
                branch || inBranch,
              );
              for (const dependency of childDependencies)
                dependencies.add(dependency);
            }
          } catch (cause) {
            throw contextual(cause, absolute, pointer, next, options.signal);
          }
        },
      });
      tasks.set(key, { state: "done", dependencies });
      pending.delete(key);
      return dependencies;
    } catch (cause) {
      tasks.delete(key);
      pending.delete(key);
      throw contextual(cause, absolute, "", chain, options.signal);
    }
  };
  const pendingBundles = new Set<string>();
  const validateBundle = async (
    base: string,
    depth: number,
    chain: readonly string[],
    branch: boolean,
  ): Promise<ContentBundle> => {
    const cached = bundles.get(base);
    if (cached && !pendingBundles.has(base)) {
      if (
        branch &&
        [...(bundleDependencies.get(base) ?? [])].some((dependency) =>
          pending.has(dependency),
        )
      )
        throw new ContentBundleError(
          "REFERENCE_INVALID",
          "Cyclic anyOf bundle dependency is unsupported.",
          base,
        );
      return cached;
    }
    if (pendingBundles.has(base)) {
      if (branch)
        throw new ContentBundleError(
          "REFERENCE_INVALID",
          "Cyclic anyOf bundle dependency is unsupported.",
          base,
        );
      return bundles.get(base)!;
    }
    if (depth > limits.validationDepth)
      throw new ContentBundleError(
        "LIMIT_EXCEEDED",
        "Bundle reference depth exceeded.",
        base,
      );
    const manifest = await manifestAt(base);
    if (manifest.entry.schema === SCHEMA_PROFILE) return loadSchema(base);
    const schemaBase = join(base, rootPath(manifest.entry.schema));
    const schema = await loadSchema(schemaBase);
    if (!base && expected && !schema.cid.equals(expected.cid))
      throw new ContentBundleError(
        "SCHEMA_INVALID",
        "Embedded Schema Bundle CID differs from the explicit validator.",
      );
    const bundleCid = directories.get(base)!;
    const bundle: ContentBundle = Object.freeze({
      kind: "content",
      get cid() {
        return CID.decode(Uint8Array.from(bundleCid.bytes));
      },
      manifest,
      schemaKey: schema.cid.toV1().toString(),
      schemaBundle: schema,
      readFile: fileReader(base),
    });
    bundles.set(base, bundle);
    pendingBundles.add(base);
    const bundleKey = `bundle:${base}`;
    pending.add(bundleKey);
    bundleDependencies.set(base, new Set([bundleKey]));
    try {
      const dependencies = await content(
        base,
        manifest.entry.path,
        schema,
        schema.descriptor.main,
        manifest.entry.contentType,
        depth,
        chain,
        branch,
      );
      bundleDependencies.set(base, dependencies);
      pendingBundles.delete(base);
      pending.delete(bundleKey);
      return bundle;
    } catch (cause) {
      bundles.delete(base);
      pendingBundles.delete(base);
      pending.delete(bundleKey);
      bundleDependencies.delete(base);
      throw contextual(cause, base, "", chain, options.signal);
    }
  };
  try {
    await store.prepare(cid, request);
    await index("", 0);
    const result = await validateBundle("", 0, [], false);
    if (expected && result.kind !== "content")
      throw new ContentBundleError(
        "SCHEMA_INVALID",
        "Explicit content validation requires an ordinary Bundle.",
      );
    return result;
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
export async function openSchemaBundle(
  root: CID,
  options: OpenBundleOptions,
): Promise<SchemaBundle> {
  const bundle = await operation(root, options);
  if (bundle.kind !== "schema")
    throw new ContentBundleError("SCHEMA_INVALID", "Expected a Schema Bundle.");
  return bundle as SchemaBundle;
}
export async function validateContentBundle(
  root: CID,
  schema: SchemaBundle,
  options: OpenBundleOptions,
): Promise<ContentBundle> {
  return operation(root, options, schema);
}
