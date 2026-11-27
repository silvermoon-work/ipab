import {
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  link,
  unlink,
  rmdir,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { randomUUID } from "node:crypto";
import { CarBlockIterator } from "@ipld/car/iterator";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import ignore from "ignore";
import {
  bundleLimits,
  encodeSchema,
  openBundle,
  openSchema,
  parseBundleManifest,
  ContentBundleError,
} from "@ipab/bundle";
import type {
  EntryValidation,
  OpenBundleOptions,
  SchemaBlock,
} from "@ipab/bundle";
import {
  encodeBundleCar,
  encodeSchemaCar,
  readBytes,
  streamChunks,
} from "@ipab/bundle-builder";
import type { EncodedBundleCar } from "@ipab/bundle-builder";
import { filesystemTree } from "@ipab/bundle-builder/node";
import type { IpfsStore } from "@ipab/ipfs-store";
import { HostError } from "./errors.js";
import { builtinAppSchema, schemaAlias } from "./app-definition.js";
import {
  builtinTemplateSchema,
  templateBuiltinAlias,
} from "./template-definition.js";

export interface AuthoringOptions {
  signal?: AbortSignal;
  diagnostic?: (text: string) => void;
  resolveCid?: OpenBundleOptions["resolveCid"];
}
export interface BuildResult {
  kind: "content-bundle" | "bundle-schema";
  cid: string;
  schemaCid: string;
  output: string;
  bytes: number;
  validation?: EntryValidation | null;
}
export interface InspectResult {
  kind: "content-bundle" | "bundle-schema";
  sourceKind: "directory" | "definition" | "car" | "cid";
  cid: string | null;
  schemaCid: string;
  name: string;
  description: string;
  entry: { path: string; contentType: string };
  validation: {
    definition: "valid";
    storage: "verified" | "not-applicable";
    entry: EntryValidation | null;
  };
}
export interface ImportResult {
  kind: "bundle-import";
  cid: string;
  schemaCid: string;
  source: string;
  blocks: number;
  bytes: number;
  validation: EntryValidation | null;
}
export function nodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
async function existing(path: string) {
  try {
    return await lstat(path);
  } catch (cause) {
    if (nodeError(cause, "ENOENT")) return undefined;
    throw cause;
  }
}
function pathKey(path: string): string {
  return process.platform === "win32" ? path.toLowerCase() : path;
}
async function localFile(
  path: string,
  maximum: number,
  options: AuthoringOptions,
) {
  const tree = await filesystemTree(dirname(path));
  return readBytes(tree, basename(path), maximum, options);
}
async function definitionAt(path: string, options: AuthoringOptions) {
  return parseBundleManifest(
    await localFile(path, bundleLimits.parsingBytes, options),
  );
}
export async function selectedTree(
  root: string,
  output: string | undefined,
  outputDirectory: string | undefined,
  options: AuthoringOptions,
) {
  const original = await filesystemTree(root);
  const definition = parseBundleManifest(
    await readBytes(
      original,
      ".bundle.yaml",
      bundleLimits.manifestBytes,
      options,
    ),
  );
  const matcher = ignore({ ignorecase: false });
  if (await existing(join(root, ".bundle-ignore"))) {
    const bytes = await readBytes(
      original,
      ".bundle-ignore",
      64 * 1024,
      options,
    );
    matcher.add(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  }
  const within = (absolute: string | undefined) => {
    if (!absolute) return undefined;
    const path = relative(root, absolute);
    return path &&
      !isAbsolute(path) &&
      path !== ".." &&
      !path.startsWith(`..${sep}`)
      ? path.split(sep).join("/")
      : undefined;
  };
  const outputPath = within(output);
  const outputDir = within(outputDirectory);
  const excluded = (path: string, directory: boolean) =>
    path === ".bundle-ignore" ||
    Boolean(outputPath && pathKey(path) === pathKey(outputPath)) ||
    Boolean(
      outputDir &&
      (pathKey(path) === pathKey(outputDir) ||
        pathKey(path).startsWith(`${pathKey(outputDir)}/`)),
    ) ||
    matcher.ignores(directory ? `${path}/` : path);
  for (const required of [".bundle.yaml", definition.entry.path])
    if (excluded(required, false))
      throw new HostError(
        `Required bundle file is excluded: ${required}. Fix .bundle-ignore or choose an output outside the entry tree.`,
      );
  return filesystemTree(root, { exclude: excluded });
}
export async function readCar(
  path: string,
  options: AuthoringOptions,
  directory = dirname(path),
) {
  const tree = await filesystemTree(directory);
  const input = await tree.read(
    relative(directory, path).split(sep).join("/"),
    options,
  );
  const chunks = streamChunks(input, options);
  let bytes = 0;
  try {
    const bounded = async function* () {
      for await (const chunk of chunks) {
        bytes += chunk.length;
        if (bytes > bundleLimits.bytes + bundleLimits.blocks * 128)
          throw new ContentBundleError(
            "LIMIT_EXCEEDED",
            "CAR input byte budget exceeded.",
          );
        yield chunk;
      }
    };
    const iterator = await CarBlockIterator.fromIterable(bounded());
    const roots = await iterator.getRoots();
    if (roots.length !== 1)
      throw new HostError("CAR must contain exactly one root.");
    const blocks = new Map<string, Uint8Array>();
    let total = 0,
      records = 0;
    for await (const block of iterator) {
      options.signal?.throwIfAborted();
      total += block.bytes.length;
      if (
        ++records > bundleLimits.blocks ||
        total > bundleLimits.bytes ||
        block.bytes.length > bundleLimits.blockBytes
      )
        throw new ContentBundleError(
          "LIMIT_EXCEEDED",
          "CAR block/byte budget exceeded.",
        );
      const hash = await sha256.digest(block.bytes);
      if (
        block.cid.multihash.code !== sha256.code ||
        hash.digest.length !== block.cid.multihash.digest.length ||
        !hash.digest.every(
          (byte, index) => byte === block.cid.multihash.digest[index],
        )
      )
        throw new HostError(
          `Corrupt or unsupported CAR block: ${block.cid.toString()}.`,
        );
      blocks.set(block.cid.toV1().toString(), block.bytes);
    }
    return {
      root: roots[0]!,
      blocks,
      bytes,
      resolveCid: (cid: CID) => {
        const bytes = blocks.get(cid.toV1().toString());
        if (!bytes)
          throw new ContentBundleError(
            "CONTENT_UNAVAILABLE",
            `CAR is missing block ${cid.toString()}.`,
          );
        return Promise.resolve(bytes);
      },
    };
  } finally {
    await chunks.return(undefined);
  }
}
function cidInput(source: string): CID | undefined {
  try {
    return CID.parse(source);
  } catch {
    return undefined;
  }
}
async function artifact(source: string, options: AuthoringOptions) {
  if (source.startsWith("builtin:")) {
    schemaAlias(source);
    const schema = await (source === templateBuiltinAlias
      ? builtinTemplateSchema()
      : builtinAppSchema());
    return {
      schema,
      kind: "bundle-schema" as const,
      sourceKind: "definition" as const,
      cid: schema.cid.toString(),
    };
  }
  const cid = cidInput(source);
  if (cid) {
    if (!options.resolveCid)
      throw new HostError("CID input requires a configured Store.");
    return fromRoot(cid, options.resolveCid, "cid", options);
  }
  const path = resolve(source);
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new HostError("Expected a regular definition or CAR file.");
  if (path.toLowerCase().endsWith(".car")) {
    const car = await readCar(path, options);
    return fromRoot(car.root, car.resolveCid, "car", options);
  }
  const schema = await encodeSchema(await definitionAt(path, options));
  return {
    schema,
    kind: "bundle-schema" as const,
    sourceKind: "definition" as const,
    cid: schema.cid.toString(),
  };
}
async function fromRoot(
  root: CID,
  resolveCid: OpenBundleOptions["resolveCid"],
  sourceKind: "cid" | "car",
  options: AuthoringOptions,
) {
  if (root.code === 0x71) {
    const schema = await openSchema(root, {
      resolveCid,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    return {
      schema,
      kind: "bundle-schema" as const,
      sourceKind,
      cid: root.toString(),
    };
  }
  const bundle = await openBundle(root, {
    resolveCid,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  return {
    schema: bundle.schema,
    validation: bundle.validation,
    kind: "content-bundle" as const,
    sourceKind,
    cid: root.toString(),
  };
}
function summary(schema: SchemaBlock) {
  const { name, description, entry } = schema.manifest;
  return {
    schemaCid: schema.cid.toString(),
    name,
    description,
    entry: { path: entry.path, contentType: entry.contentType },
  };
}
export async function inspectBundle(
  source: string,
  options: AuthoringOptions = {},
): Promise<InspectResult> {
  if (source.startsWith("builtin:")) schemaAlias(source);
  const cid = cidInput(source);
  if (
    !source.startsWith("builtin:") &&
    !cid &&
    (await lstat(resolve(source))).isDirectory()
  ) {
    const encoded = await encodeBundleCar(
      await selectedTree(resolve(source), undefined, undefined, options),
      options,
    );
    try {
      return {
        kind: "content-bundle",
        sourceKind: "directory",
        cid: null,
        ...summary(encoded.schema),
        validation: {
          definition: "valid",
          storage: "verified",
          entry: encoded.validation,
        },
      };
    } finally {
      await encoded.close();
    }
  }
  const loaded = await artifact(source, options);
  return {
    kind: loaded.kind,
    sourceKind: loaded.sourceKind,
    cid: loaded.cid,
    ...summary(loaded.schema),
    validation: {
      definition: "valid",
      storage: loaded.kind === "content-bundle" ? "verified" : "not-applicable",
      entry: loaded.kind === "content-bundle" ? loaded.validation : null,
    },
  };
}
export async function importBundle(
  source: string,
  getStore: () => Promise<IpfsStore>,
  options: AuthoringOptions = {},
): Promise<ImportResult> {
  const path = resolve(source);
  const stat = await lstat(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    !path.toLowerCase().endsWith(".car")
  )
    throw new HostError("Import requires a regular .car file.");
  const car = await readCar(path, options);
  const loaded = await fromRoot(car.root, car.resolveCid, "car", options);
  options.signal?.throwIfAborted();
  const store = await getStore();
  const cid = car.root.toV1().toString();
  for (const [key, bytes] of car.blocks)
    await store.put(CID.parse(key), bytes, options);
  options.signal?.throwIfAborted();
  return {
    kind: "bundle-import",
    cid,
    schemaCid: loaded.schema.cid.toString(),
    source: path,
    validation: loaded.kind === "content-bundle" ? loaded.validation : null,
    blocks: car.blocks.size,
    bytes: car.bytes,
  };
}
export async function outputAvailable(
  output: string,
  replace: boolean,
): Promise<void> {
  const stat = await existing(output);
  if (!stat) return;
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new HostError(`Output is not a regular artifact file: ${output}.`);
  if (!replace)
    throw new HostError(
      `Output already exists: ${output}. Use --replace or --output to select another file.`,
    );
}
export async function writeCar(
  encoded: EncodedBundleCar,
  output: string,
  replace = false,
  options: AuthoringOptions = {},
): Promise<number> {
  let temporary: string | undefined;
  let bytes = 0;
  try {
    await outputAvailable(output, replace);
    options.signal?.throwIfAborted();
    await mkdir(dirname(output), { recursive: true });
    const candidate = join(dirname(output), `.ipab-${randomUUID()}.tmp`);
    const handle = await open(candidate, "wx", 0o600);
    temporary = candidate;
    try {
      for await (const part of streamChunks(encoded.stream, options)) {
        await handle.writeFile(part, { signal: options.signal });
        bytes += part.length;
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
    options.signal?.throwIfAborted();
    await outputAvailable(output, replace);
    if (replace) await rename(temporary, output);
    else {
      await link(temporary, output);
      await unlink(temporary);
    }
    temporary = undefined;
    return bytes;
  } finally {
    try {
      if (temporary) await unlink(temporary);
    } finally {
      await encoded.close();
    }
  }
}
export async function buildBundle(
  source: string,
  options: AuthoringOptions & {
    schemaOnly?: boolean;
    output?: string;
    outputDir?: string;
    replace?: boolean;
  } = {},
): Promise<BuildResult> {
  const path = resolve(source);
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()))
    throw new HostError("Build input must be a regular file or directory.");
  if (!options.schemaOnly && !stat.isDirectory())
    throw new HostError(
      "Content build requires a folder; use --schema-only for a definition file.",
    );
  const root = stat.isDirectory() ? path : dirname(path);
  const outputDirectory = resolve(root, options.outputDir ?? "dist");
  const output = options.output
    ? resolve(options.output)
    : join(outputDirectory, options.schemaOnly ? "schema.car" : "bundle.car");
  const definitionPath = stat.isDirectory() ? join(root, ".bundle.yaml") : path;
  const definition = await definitionAt(definitionPath, options);
  if (
    [
      definitionPath,
      join(root, ".bundle.yaml"),
      join(root, ".bundle-ignore"),
      resolve(root, ...definition.entry.path.split("/")),
    ].some((input) => pathKey(output) === pathKey(input))
  )
    throw new HostError(
      "Output cannot overwrite a bundle definition, ignore file or entry, even with --replace.",
    );
  await outputAvailable(output, Boolean(options.replace));
  const encoded = options.schemaOnly
    ? await encodeSchemaCar(definition, options)
    : await encodeBundleCar(
        await selectedTree(
          root,
          output,
          options.output ? undefined : outputDirectory,
          options,
        ),
        options,
      );
  const result = {
    kind: options.schemaOnly
      ? ("bundle-schema" as const)
      : ("content-bundle" as const),
    cid: encoded.cid.toString(),
    schemaCid: encoded.schema.cid.toString(),
    output,
    validation: encoded.validation,
  };
  return {
    ...result,
    bytes: await writeCar(encoded, output, Boolean(options.replace), options),
  };
}
export async function scaffoldFiles(
  directory: string,
  files: ReadonlyMap<string, string | Uint8Array>,
  options: AuthoringOptions = {},
): Promise<string> {
  const root = resolve(directory);
  const stat = await existing(root);
  if (
    stat &&
    (!stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (await readdir(root)).length)
  )
    throw new HostError(
      `Target directory is not empty or not a regular directory: ${root}. Choose a new or empty directory.`,
    );
  const createdFiles: string[] = [],
    createdDirectories: string[] = [];
  const ensure = async (path: string) => {
    const first = await mkdir(path, { recursive: true });
    if (first) {
      let current = first;
      createdDirectories.push(current);
      for (const part of relative(first, path).split(sep).filter(Boolean)) {
        current = join(current, part);
        createdDirectories.push(current);
      }
    }
  };
  try {
    await ensure(root);
    for (const [path, contents] of files) {
      options.signal?.throwIfAborted();
      const target = resolve(root, ...path.split("/"));
      await ensure(dirname(target));
      const handle = await open(target, "wx", 0o600);
      createdFiles.push(target);
      try {
        await handle.writeFile(contents, { signal: options.signal });
      } finally {
        await handle.close();
      }
    }
    options.signal?.throwIfAborted();
    return root;
  } catch (cause) {
    const failures: unknown[] = [cause];
    for (const file of createdFiles.reverse()) {
      try {
        await unlink(file);
      } catch (error) {
        if (!nodeError(error, "ENOENT")) failures.push(error);
      }
    }
    for (const path of createdDirectories.reverse()) {
      try {
        await rmdir(path);
      } catch (error) {
        if (!nodeError(error, "ENOENT")) failures.push(error);
      }
    }
    if (failures.length > 1)
      throw new AggregateError(
        failures,
        "Initialization failed and cleanup also failed.",
        { cause },
      );
    throw cause;
  }
}
