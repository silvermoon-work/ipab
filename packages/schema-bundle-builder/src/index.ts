import {
  canonicalJson,
  ContentBundleError,
  inspectSchemaBundle,
  parseData,
  resolveBundleLimits,
  SCHEMA_PROFILE,
} from "@ipab/bundle";
import { encodeBundleCar, memoryTree, readBytes } from "@ipab/bundle-builder";
import type { BundleCarOptions, ReadonlyFileTree } from "@ipab/bundle-builder";

export interface SchemaBundleBuildOptions extends BundleCarOptions {
  readonly descriptorPath?: string;
}
/** Read only the descriptor's explicit local files; normalize control JSON, never arbitrary attachments. */
export async function createSchemaBundleTree(
  input: ReadonlyFileTree,
  options: SchemaBundleBuildOptions = {},
): Promise<ReadonlyFileTree> {
  const limits = resolveBundleLimits(options.limits);
  let bytes = 0,
    nodes = 0;
  const charge = () => {
    if (options.signal?.aborted)
      throw new ContentBundleError(
        "ABORTED",
        "Schema construction cancelled.",
        "",
        "",
        [],
        { cause: options.signal.reason },
      );
    if (++nodes > limits.nodes)
      throw new ContentBundleError(
        "LIMIT_EXCEEDED",
        "Schema builder work budget exceeded.",
      );
  };
  const read = async (path: string, maximum: number) => {
    const content = await readBytes(input, path, maximum, options);
    bytes += content.length;
    if (bytes > limits.parsingBytes)
      throw new ContentBundleError(
        "LIMIT_EXCEEDED",
        "Schema builder parsing budget exceeded.",
      );
    return parseData(
      content,
      "application/json",
      limits.nodes,
      limits.jsonDepth,
      charge,
    );
  };
  const descriptor = await read(
    options.descriptorPath ?? "schema.json",
    limits.descriptorBytes,
  );
  const listed =
    typeof descriptor === "object" &&
    descriptor !== null &&
    "schemas" in descriptor
      ? descriptor.schemas
      : undefined;
  const schemas = new Map<string, unknown>();
  if (Array.isArray(listed))
    for (const path of listed) {
      if (typeof path !== "string")
        throw new ContentBundleError(
          "SCHEMA_INVALID",
          "Schema paths must be strings.",
        );
      if (schemas.size >= limits.schemas)
        throw new ContentBundleError(
          "LIMIT_EXCEEDED",
          "Schema count exceeded.",
        );
      if (path === ".bundle.yaml" || path === "schema.json")
        throw new ContentBundleError(
          "PATH_INVALID",
          "Schema path conflicts with generated control file.",
          path,
        );
      schemas.set(path, await read(path, limits.schemaBytes));
    }
  const checked = inspectSchemaBundle(descriptor, schemas, {
    nodes: limits.nodes,
    depth: limits.validationDepth,
    jsonDepth: limits.jsonDepth,
    schemas: limits.schemas,
    charge,
  });
  const files = new Map<string, Uint8Array>();
  const normalize = (value: unknown) =>
    canonicalJson(value, limits.nodes, limits.jsonDepth, charge);
  files.set(
    ".bundle.yaml",
    normalize({
      entry: {
        path: "schema.json",
        contentType: "application/json",
        schema: SCHEMA_PROFILE,
      },
    }),
  );
  files.set(
    "schema.json",
    normalize({
      ...checked.descriptor,
      schemas: [...checked.descriptor.schemas].sort(),
    }),
  );
  for (const [path, schema] of schemas) files.set(path, normalize(schema));
  return memoryTree(files);
}
export async function encodeSchemaBundleCar(
  input: ReadonlyFileTree,
  options: SchemaBundleBuildOptions = {},
) {
  return encodeBundleCar(await createSchemaBundleTree(input, options), options);
}
