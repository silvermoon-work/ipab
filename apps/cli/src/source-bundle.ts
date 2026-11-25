import { relative, isAbsolute, sep } from "node:path";
import { createHash } from "node:crypto";
import ignore from "ignore";
import { stringify } from "yaml";
import { bundleLimits } from "@ipab/bundle";
import { listTree, readBytes } from "@ipab/bundle-builder";
import { filesystemTree } from "@ipab/bundle-builder/node";
import { nodeError, type AuthoringOptions } from "./authoring.js";
import { HostError } from "./errors.js";

export const sourceSchema = {
  name: "IPAB App Source",
  description:
    "App project source snapshot; build inputs are ordinary resources.",
  entry: {
    path: "package.json",
    contentType: "application/json",
    schema: { type: "object" },
    defaultValue: {},
  },
} as const;

export async function captureSource(
  root: string,
  excludedOutputs: readonly string[],
  options: AuthoringOptions = {},
) {
  const key = (path: string) =>
    process.platform === "win32" ? path.toLowerCase() : path;
  const outputs = excludedOutputs.flatMap((output) => {
    const path = relative(root, output);
    return path &&
      !isAbsolute(path) &&
      path !== ".." &&
      !path.startsWith(`..${sep}`)
      ? [key(path.split(sep).join("/"))]
      : [];
  });
  const rules = new Map<string, ReturnType<typeof ignore>>();
  const excluded = (path: string, directory: boolean) => {
    const normalized = key(path);
    if (
      normalized
        .split("/")
        .some((part) => [".git", "node_modules"].includes(part)) ||
      normalized === ".bundle-ignore" ||
      normalized === "dist" ||
      normalized.startsWith("dist/") ||
      normalized.split("/")[0]!.startsWith(".ipab-app-") ||
      outputs.some(
        (output) =>
          normalized === output || normalized.startsWith(`${output}/`),
      )
    )
      return true;
    let ignored = false;
    for (const [prefix, matcher] of rules) {
      if (prefix && !path.startsWith(prefix)) continue;
      const match = matcher.test(
        `${path.slice(prefix.length)}${directory ? "/" : ""}`,
      );
      if (match.ignored) ignored = true;
      else if (match.unignored) ignored = false;
    }
    return ignored;
  };
  const original = await filesystemTree(root);
  const selected = await filesystemTree(root, { exclude: excluded });
  const files = new Map<string, Uint8Array>();
  let bytes = 0;
  let paths = 0;
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > bundleLimits.depth)
      throw new HostError(
        "Source snapshot exceeds the Bundle tree depth limit.",
      );
    const prefix = directory ? `${directory}/` : "";
    try {
      const text = await readBytes(
        original,
        `${prefix}.gitignore`,
        64 * 1024,
        options,
      );
      rules.set(
        prefix,
        ignore({ ignorecase: false }).add(
          new TextDecoder("utf-8", { fatal: true }).decode(text),
        ),
      );
    } catch (cause) {
      if (!nodeError(cause, "ENOENT")) throw cause;
    }
    for (const entry of await listTree(selected, directory, options)) {
      if (++paths > bundleLimits.files)
        throw new HostError("Source snapshot exceeds the Bundle path limit.");
      const path = `${prefix}${entry.name}`;
      if (entry.kind === "directory") await visit(path, depth + 1);
      else {
        const content = await readBytes(
          selected,
          path,
          bundleLimits.bytes - bytes,
          options,
        );
        bytes += content.length;
        files.set(path, content);
      }
    }
  };
  await visit("", 0);
  if (!files.has(".bundle.yaml")) {
    if (excluded(".bundle.yaml", false))
      throw new HostError("Source .bundle.yaml is excluded by .gitignore.");
    files.set(
      ".bundle.yaml",
      new TextEncoder().encode(stringify(sourceSchema)),
    );
  }
  if (!files.has("package.json"))
    throw new HostError("Source package.json is excluded by .gitignore.");
  return files;
}

export function sourceFingerprint(
  files: ReadonlyMap<string, Uint8Array>,
): string {
  const hash = createHash("sha256");
  for (const [path, bytes] of [...files].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    hash.update(JSON.stringify([path, bytes.length]));
    hash.update(bytes);
  }
  return hash.digest("hex");
}
