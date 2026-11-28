import {
  encodeSchema,
  parseBundleManifest,
  parseBundleType,
  parseData,
  safePath,
  validateSchemaValue,
} from "@ipab/bundle/data";
import definition from "../../../packages/pointer-worker/bundle-definition.json" with { type: "json" };
import { bytes } from "./setup.js";
import type { Files } from "./setup.js";

export function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export async function readWorker(files: Files, cid: string) {
  const expected = await encodeSchema(definition);
  const manifest = parseBundleManifest(
    await bytes(await files.readFile(cid, ".bundle.yaml"), 1024 * 1024),
  );
  const actual = await encodeSchema(
    parseBundleType(
      await bytes(await files.readFile(cid, manifest.type), 1024 * 1024),
    ),
  );
  if (!actual.cid.equals(expected.cid))
    throw new Error("Input is not the supported Worker Bundle type.");
  const value = parseData(
    await bytes(await files.readFile(cid, manifest.entry), 1024 * 1024),
    actual.type.contentType,
  );
  let work = 0;
  validateSchemaValue(expected, value, {
    depth: 64,
    charge: () => {
      if (++work > 100_000)
        throw new Error("Worker descriptor exceeds work budget.");
    },
  });
  if (!object(value) || !object(value.config) || !Array.isArray(value.files))
    throw new Error("Invalid Worker descriptor.");
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const path of value.files) {
    if (typeof path !== "string") throw new Error("Invalid Worker file path.");
    safePath(path);
    if (
      path
        .split("/")
        .some((part) => part.startsWith(".") || /[<>|"*]/u.test(part))
    )
      throw new Error("Worker files must use portable, non-hidden paths.");
    const key = path.toLowerCase();
    if (
      seen.has(key) ||
      key === manifest.entry.toLowerCase() ||
      key === manifest.type.toLowerCase() ||
      key === ".bundle.yaml" ||
      key === "wrangler.json"
    )
      throw new Error("Worker file paths collide.");
    seen.add(key);
    paths.push(path);
  }
  if (!paths.includes("worker.mjs"))
    throw new Error("Worker entry is missing.");
  return { config: value.config, paths };
}
