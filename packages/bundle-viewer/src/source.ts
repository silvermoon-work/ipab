import { lstat } from "node:fs/promises";
import { resolve } from "node:path";
import { CID } from "multiformats/cid";

export async function resolveViewerSource(
  source: string,
  context: { resolvePin?: (name: string) => Promise<string | undefined> },
): Promise<{ folder: string } | { contentCid: string }> {
  if (!source || source.length > 4096)
    throw new Error("Viewer source must contain 1..4096 characters");
  let directory = false;
  try {
    const info = await lstat(resolve(source));
    directory = info.isDirectory() || info.isSymbolicLink();
    if (!directory)
      throw new Error("Viewer source exists but is not a directory");
  } catch (error) {
    if (
      !error ||
      typeof error !== "object" ||
      !("code" in error) ||
      error.code !== "ENOENT"
    )
      throw error;
  }
  if (directory) return { folder: resolve(source) };
  const named =
    source.length <= 256 && context.resolvePin
      ? await context.resolvePin(source)
      : undefined;
  if (named !== undefined)
    return { contentCid: CID.parse(named).toV1().toString() };
  try {
    return { contentCid: CID.parse(source).toV1().toString() };
  } catch (cause) {
    throw new Error(
      context.resolvePin
        ? `Unknown viewer folder, pin or CID: ${source}`
        : `Viewer pin lookup requires a host with resolvePin: ${source}`,
      { cause },
    );
  }
}
