import { lstat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { CID } from "multiformats/cid";
import { parseData, parseBundleManifest } from "@ipab/bundle";
import {
  encodeBundleCar,
  fileTree,
  readBytes,
  type FileReader,
} from "@ipab/bundle-builder";
import { filesystemTree } from "@ipab/bundle-builder/node";
import { HostError, object } from "./errors.js";
import { relativePath } from "./space.js";
import {
  nodeError,
  outputAvailable,
  writeCar,
  type AuthoringOptions,
  type BuildResult,
} from "./authoring.js";

function keys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new HostError(
      "Unknown assembly recipe field. Legacy App ipab.yaml/ipab.json is not a generic assembly recipe; run project preparation separately.",
    );
}

export async function assembleBundle(
  source = ".",
  options: AuthoringOptions & {
    output?: string;
    outputDir?: string;
    replace?: boolean;
  } = {},
): Promise<BuildResult> {
  const input = resolve(source);
  const stat = await lstat(input);
  if (stat.isSymbolicLink())
    throw new HostError("Assembly input must not be a symlink.");
  const recipePath = stat.isDirectory()
    ? join(input, "ipab.build.yaml")
    : input;
  const root = dirname(recipePath);
  const tree = await filesystemTree(root);
  let recipeBytes: Uint8Array;
  try {
    recipeBytes = await readBytes(
      tree,
      basename(recipePath),
      64 * 1024,
      options,
    );
  } catch (cause) {
    if (stat.isDirectory()) {
      for (const legacy of ["ipab.yaml", "ipab.json"]) {
        try {
          await lstat(join(root, legacy));
          throw new HostError(
            "Legacy App build configuration is unsupported by generic build. Run the project preparation script, then supply ipab.build.yaml.",
          );
        } catch (error) {
          if (!nodeError(error, "ENOENT")) throw error;
        }
      }
    }
    throw cause;
  }
  const recipe = object(
    parseData(recipeBytes, "application/yaml"),
    "assembly recipe",
  );
  keys(recipe, ["version", "files", "imports"]);
  if (
    recipe.version !== 1 ||
    !Array.isArray(recipe.files) ||
    !Array.isArray(recipe.imports ?? [])
  )
    throw new HostError(
      "Assembly recipe requires version: 1, files: [{source,target}], and optional imports: [{cid,target}].",
    );
  const files = new Map<string, FileReader>();
  const paths: string[] = [];
  const claim = (target: string) => {
    relativePath(target);
    const key = target.toLowerCase();
    if (
      paths.some(
        (previous) =>
          previous === key ||
          previous.startsWith(`${key}/`) ||
          key.startsWith(`${previous}/`),
      )
    )
      throw new HostError(`Assembly target collision: ${target}.`);
    paths.push(key);
  };
  files.set(".bundle.yaml", () => tree.read(".bundle.yaml", options));
  claim(".bundle.yaml");
  const definition = parseBundleManifest(
    await readBytes(tree, ".bundle.yaml", 1024 * 1024, options),
  );
  const inputs = new Set<string>([resolve(root, ".bundle.yaml"), recipePath]);
  for (const item of recipe.files) {
    const mapping = object(item, "file mapping");
    keys(mapping, ["source", "target"]);
    if (
      typeof mapping.source !== "string" ||
      typeof mapping.target !== "string"
    )
      throw new HostError(
        "Recipe file mappings require source and target strings.",
      );
    relativePath(mapping.source);
    claim(mapping.target);
    inputs.add(resolve(root, ...mapping.source.split("/")));
    const sourcePath = mapping.source;
    files.set(mapping.target, () => tree.read(sourcePath, options));
  }
  const imports = ((recipe.imports as unknown[] | undefined) ?? []).map(
    (item) => {
      const mapping = object(item, "CID import");
      keys(mapping, ["cid", "target"]);
      if (typeof mapping.cid !== "string" || typeof mapping.target !== "string")
        throw new HostError("CID imports require cid and target strings.");
      const cid = CID.parse(mapping.cid);
      claim(mapping.target);
      if (!options.resolveCid)
        throw new HostError("CID imports require a Store.");
      return { path: mapping.target, cid, resolveCid: options.resolveCid };
    },
  );
  if (
    !files.has(definition.entry.path) &&
    !imports.some((item) => item.path === definition.entry.path)
  )
    throw new HostError("Recipe must explicitly select the Bundle entry.");
  const output = options.output
    ? resolve(options.output)
    : join(root, options.outputDir ?? "dist", "bundle.car");
  if (inputs.has(output))
    throw new HostError("CAR output cannot replace recipe or source inputs.");
  await outputAvailable(output, Boolean(options.replace));
  const encoded = await encodeBundleCar(fileTree(files), {
    ...options,
    imports,
  });
  const result = {
    kind: "content-bundle" as const,
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
