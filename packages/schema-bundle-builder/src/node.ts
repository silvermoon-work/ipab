import { filesystemTree } from "@ipab/bundle-builder/node";
import { createSchemaBundleTree, encodeSchemaBundleCar } from "./index.js";
import type { SchemaBundleBuildOptions } from "./index.js";
export async function schemaBundleTreeFromDirectory(
  directory: string,
  options: SchemaBundleBuildOptions = {},
) {
  return createSchemaBundleTree(await filesystemTree(directory), options);
}
export async function schemaBundleCarFromDirectory(
  directory: string,
  options: SchemaBundleBuildOptions = {},
) {
  return encodeSchemaBundleCar(await filesystemTree(directory), options);
}
