import { isMap, isSeq, parseAllDocuments } from "yaml";
import { ContentBundleError } from "./errors.js";
import type { BundleManifest, ContentType } from "./types.js";

export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function safePath(path: string): string {
  if (
    !path ||
    path.length > 1024 ||
    path.split("/").some((part) => !part || part === "." || part === "..") ||
    /[\\:%?#]/u.test(path) ||
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
      path,
    ) ||
    [...path].some(
      (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
    )
  )
    throw new ContentBundleError(
      "PATH_INVALID",
      "Unsafe bundle-relative path.",
      path,
    );
  return path;
}

export function assertJson(
  value: unknown,
  maximumNodes = 100_000,
  maximumDepth = 64,
  charge: () => void = () => {},
): void {
  jsonLimits(maximumNodes, maximumDepth);
  const ancestors = new Set<object>();
  let nodes = 0;
  const visit = (item: unknown, depth: number): void => {
    charge();
    if (++nodes > maximumNodes || depth > maximumDepth)
      throw new ContentBundleError(
        "LIMIT_EXCEEDED",
        "JSON value exceeds node/depth limits.",
      );
    if (typeof item === "string") {
      if (
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
          item,
        )
      )
        throw new ContentBundleError(
          "CONTENT_INVALID",
          "Invalid Unicode surrogate.",
        );
      return;
    }
    if (item === null || typeof item === "boolean") return;
    if (
      typeof item === "number" &&
      Number.isFinite(item) &&
      (!Number.isInteger(item) || Number.isSafeInteger(item))
    )
      return;
    if (
      typeof item !== "object" ||
      ancestors.has(item) ||
      (!Array.isArray(item) &&
        Object.getPrototypeOf(item) !== Object.prototype &&
        Object.getPrototypeOf(item) !== null)
    )
      throw new ContentBundleError(
        "CONTENT_INVALID",
        "Expected finite, acyclic JSON-compatible data with safe integers.",
      );
    ancestors.add(item);
    if (
      Array.isArray(item) &&
      (Object.keys(item).length !== item.length ||
        Object.keys(item).some((key, index) => key !== String(index)))
    )
      throw new ContentBundleError(
        "CONTENT_INVALID",
        "Expected a dense JSON array without extra properties.",
      );
    for (const [key, child] of Object.entries(item)) {
      if (!Array.isArray(item)) visit(key, depth + 1);
      visit(child, depth + 1);
    }
    ancestors.delete(item);
  };
  visit(value, 0);
}

function jsonLimits(nodes: number, depth: number): void {
  if (
    ![nodes, depth].every((value) => Number.isSafeInteger(value) && value > 0)
  )
    throw new ContentBundleError(
      "OPTIONS_INVALID",
      "JSON limits must be positive safe integers.",
    );
}

function json(source: string, maximumDepth: number): unknown {
  let offset = 0;
  const space = () => {
    while (/[ \t\r\n]/u.test(source[offset] ?? "") && offset < source.length)
      offset++;
  };
  const string = (): string => {
    const start = offset++;
    while (offset < source.length) {
      const char = source[offset++];
      if (char === "\\") offset++;
      else if (char === '"')
        return JSON.parse(source.slice(start, offset)) as string;
    }
    throw new Error("Unterminated JSON string.");
  };
  const value = (depth: number): unknown => {
    if (depth > maximumDepth)
      throw new ContentBundleError("LIMIT_EXCEEDED", "JSON depth exceeded.");
    space();
    const char = source[offset];
    if (char === '"') return string();
    if (char === "{" || char === "[") {
      offset++;
      const object: Record<string, unknown> = Object.create(null) as Record<
        string,
        unknown
      >;
      const array: unknown[] = [];
      const close = char === "{" ? "}" : "]";
      space();
      if (source[offset] === close) {
        offset++;
        return char === "{" ? object : array;
      }
      for (;;) {
        if (char === "{") {
          space();
          if (source[offset] !== '"') throw new Error("Expected JSON key.");
          const key = string();
          if (Object.hasOwn(object, key))
            throw new Error("Duplicate JSON key.");
          space();
          if (source[offset++] !== ":") throw new Error("Expected colon.");
          object[key] = value(depth + 1);
        } else array.push(value(depth + 1));
        space();
        const next = source[offset++];
        if (next === close) return char === "{" ? object : array;
        if (next !== ",") throw new Error("Expected comma.");
      }
    }
    const token =
      /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/u.exec(
        source.slice(offset),
      );
    if (!token) throw new Error("Invalid JSON token.");
    offset += token[0].length;
    return JSON.parse(token[0]) as unknown;
  };
  const result = value(0);
  space();
  if (offset !== source.length) throw new Error("Trailing JSON input.");
  return result;
}

export function canonicalJson(
  value: unknown,
  nodes = 100_000,
  depth = 64,
  charge: () => void = () => {},
): Uint8Array {
  assertJson(value, nodes, depth, charge);
  const serialize = (item: unknown): string => {
    if (Array.isArray(item)) return `[${item.map(serialize).join(",")}]`;
    if (record(item))
      return `{${Object.keys(item)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${serialize(item[key])}`)
        .join(",")}}`;
    return JSON.stringify(item);
  };
  return new TextEncoder().encode(serialize(value));
}

export function parseData(
  bytes: Uint8Array,
  type: ContentType,
  nodes = 100_000,
  depth = 64,
  charge: () => void = () => {},
): unknown {
  jsonLimits(nodes, depth);
  try {
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    let value: unknown;
    if (type === "application/json") value = json(source, depth);
    else if (type === "application/jsonl") {
      const lines = source.split("\n");
      if (lines.at(-1) === "") lines.pop();
      value = lines.map((line, index): unknown => {
        try {
          return json(line, depth);
        } catch (cause) {
          const failure =
            cause instanceof ContentBundleError ? cause : undefined;
          throw new ContentBundleError(
            failure?.code ?? "CONTENT_INVALID",
            failure
              ? `${failure.message} (JSONL line ${String(index + 1)}).`
              : `Invalid JSONL at line ${String(index + 1)}.`,
            failure?.path ?? "",
            `/${String(index)}${failure?.pointer ?? ""}`,
            failure?.referenceChain ?? [],
            { cause },
          );
        }
      });
    } else {
      const documents = parseAllDocuments(source, {
        schema: "core",
        uniqueKeys: true,
      });
      if (documents.length !== 1)
        throw new ContentBundleError(
          "CONTENT_INVALID",
          "Expected one YAML document.",
        );
      const document = documents[0]!;
      const issue = document.errors[0] ?? document.warnings[0];
      if (issue) throw new ContentBundleError("CONTENT_INVALID", issue.message);
      let visited = 0;
      const inspect = (node: unknown, level: number): void => {
        charge();
        if (++visited > nodes || level > depth)
          throw new ContentBundleError(
            "LIMIT_EXCEEDED",
            "YAML value exceeds node/depth limits.",
          );
        if (isMap(node))
          for (const pair of node.items) {
            inspect(pair.key, level + 1);
            inspect(pair.value, level + 1);
          }
        else if (isSeq(node))
          for (const child of node.items) inspect(child, level + 1);
      };
      inspect(document.contents, 0);
      value = document.toJS({ maxAliasCount: 100 });
    }
    assertJson(value, nodes, depth, charge);
    return value;
  } catch (cause) {
    if (cause instanceof ContentBundleError) throw cause;
    throw new ContentBundleError(
      "CONTENT_INVALID",
      "Invalid UTF-8 or document syntax.",
      "",
      "",
      [],
      { cause },
    );
  }
}

export function normalizeBundleManifest(value: unknown): BundleManifest {
  if (
    !record(value) ||
    Object.keys(value).some(
      (key) => !["name", "description", "entry"].includes(key),
    ) ||
    typeof value.name !== "string" ||
    !value.name.trim() ||
    (value.description !== undefined &&
      typeof value.description !== "string") ||
    !record(value.entry) ||
    Object.keys(value.entry).some(
      (key) => !["path", "schema", "contentType", "defaultValue"].includes(key),
    )
  )
    throw new Error(
      "Expected name, optional description and a complete entry definition.",
    );
  const { path, schema, contentType, defaultValue } = value.entry;
  if (
    typeof path !== "string" ||
    (typeof schema !== "boolean" && !record(schema)) ||
    !Object.hasOwn(value.entry, "defaultValue")
  )
    throw new Error(
      "Entry requires path, schema, contentType and defaultValue.",
    );
  safePath(path);
  if (
    [".bundle.yaml", ".bundle-ignore"].some(
      (control) => path === control || path.startsWith(`${control}/`),
    )
  )
    throw new Error("Entry path conflicts with a bundle control file.");
  if (
    contentType !== "application/json" &&
    contentType !== "application/yaml" &&
    contentType !== "application/jsonl"
  )
    throw new Error("Unsupported content type.");
  if (contentType === "application/jsonl" && !Array.isArray(defaultValue))
    throw new Error("JSONL defaultValue must be an array.");
  return Object.freeze({
    name: value.name,
    description: value.description ?? "",
    entry: Object.freeze({
      path,
      schema,
      contentType,
      defaultValue,
    } satisfies BundleManifest["entry"]),
  });
}

export function parseBundleManifest(
  bytes: Uint8Array,
  maximum = 64 * 1024 * 1024,
  charge: () => void = () => {},
): BundleManifest {
  if (bytes.byteLength > maximum)
    throw new ContentBundleError(
      "LIMIT_EXCEEDED",
      "Bundle manifest exceeds its parsing byte limit.",
    );
  try {
    const value = parseData(bytes, "application/yaml", 100_000, 64, charge);
    return normalizeBundleManifest(value);
  } catch (cause) {
    if (cause instanceof ContentBundleError && cause.code === "LIMIT_EXCEEDED")
      throw cause;
    throw new ContentBundleError(
      "MANIFEST_INVALID",
      `Invalid .bundle.yaml: ${cause instanceof Error ? cause.message : "invalid data"}`,
      ".bundle.yaml",
      "",
      [],
      { cause },
    );
  }
}
