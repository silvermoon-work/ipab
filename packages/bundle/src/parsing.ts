import { isMap, isSeq, parseAllDocuments } from "yaml";
import { ContentBundleError } from "./errors.js";
import type {
  BundleManifest,
  BundleType,
  ContentType,
  EntryValidation,
} from "./types.js";

const mimeToken = "[!#$%&'*+.^_`|~0-9A-Za-z-]+";
const mime = new RegExp(
  `^${mimeToken}/${mimeToken}(?:[ \\t]*;[ \\t]*${mimeToken}[ \\t]*=[ \\t]*(?:${mimeToken}|"(?:[\\x20\\x21\\x23-\\x5b\\x5d-\\x7e]|\\\\[\\x20-\\x7e])*"))*$`,
  "u",
);
const dataTypes = new Set([
  "application/json",
  "application/yaml",
  "application/jsonl",
  "text/markdown",
]);

export function entryValidation(entry: BundleType): EntryValidation {
  return Object.freeze({
    status: dataTypes.has(entry.contentType.toLowerCase())
      ? entry.schema === undefined
        ? "schema-absent"
        : "validated"
      : "unsupported",
    contentType: entry.contentType,
  });
}

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

function markdownFrontmatter(source: string): string {
  const opening = /^---(?:\r?\n|$)/u.exec(source);
  if (!opening) return "{}";
  const closing = /\n---(?:\r?\n|$)/gu;
  closing.lastIndex = opening[0].length - 1;
  const end = closing.exec(source);
  if (!end)
    throw new ContentBundleError(
      "CONTENT_INVALID",
      "Markdown frontmatter requires a closing --- line.",
    );
  const frontmatter = source.slice(opening[0].length, end.index + 1);
  const empty = frontmatter
    .split(/\r?\n|\r/u)
    .every((line) => /^[ \t]*(?:#[^\r\n]*)?$/u.test(line));
  return empty ? "{}" : frontmatter;
}

export function parseData(
  bytes: Uint8Array,
  type: ContentType,
  nodes = 100_000,
  depth = 64,
  charge: () => void = () => {},
): unknown {
  jsonLimits(nodes, depth);
  if (!dataTypes.has(type.toLowerCase()))
    throw new ContentBundleError(
      "CONTENT_INVALID",
      `No data parser is available for content type ${type}.`,
    );
  type = type.toLowerCase();
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const source =
      type === "text/markdown" ? markdownFrontmatter(decoded) : decoded;
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
    if (type === "text/markdown" && !record(value))
      throw new ContentBundleError(
        "CONTENT_INVALID",
        "Markdown frontmatter must be an object.",
      );
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
      (key) => !["title", "description", "entry", "type"].includes(key),
    ) ||
    typeof value.title !== "string" ||
    !value.title.trim() ||
    (value.description !== undefined &&
      typeof value.description !== "string") ||
    typeof value.entry !== "string" ||
    typeof value.type !== "string"
  )
    throw new Error(
      "Expected title, optional description, entry and type file paths.",
    );
  const entry = safePath(value.entry);
  const type = safePath(value.type);
  const paths = [
    entry.toLowerCase(),
    type.toLowerCase(),
    ".bundle.yaml",
    ".bundle-ignore",
  ];
  if (
    paths.some((path, index) =>
      paths.some(
        (other, otherIndex) =>
          index !== otherIndex &&
          (path === other || path.startsWith(`${other}/`)),
      ),
    )
  )
    throw new Error("Required file paths conflict.");
  return Object.freeze({
    title: value.title,
    description: value.description ?? "",
    entry,
    type,
  });
}

export function normalizeBundleType(value: unknown): BundleType {
  if (
    !record(value) ||
    Object.keys(value).some((key) => !["contentType", "schema"].includes(key))
  )
    throw new Error(
      "Expected a pure type definition with contentType and optional schema.",
    );
  const { schema, contentType } = value;
  if (
    (schema !== undefined && typeof schema !== "boolean" && !record(schema)) ||
    (Object.hasOwn(value, "schema") && schema === undefined)
  )
    throw new Error("Expected an optional JSON Schema.");
  if (
    typeof contentType !== "string" ||
    /[\r\n]/u.test(contentType) ||
    !mime.test(contentType)
  )
    throw new Error("contentType must be a valid MIME type.");
  return Object.freeze({
    ...(schema === undefined ? {} : { schema }),
    contentType,
  });
}

export function parseBundleType(
  bytes: Uint8Array,
  maximum = 64 * 1024 * 1024,
  charge: () => void = () => {},
): BundleType {
  if (bytes.byteLength > maximum)
    throw new ContentBundleError(
      "LIMIT_EXCEEDED",
      "Type definition exceeds its parsing byte limit.",
    );
  try {
    return normalizeBundleType(
      parseData(bytes, "application/yaml", 100_000, 64, charge),
    );
  } catch (cause) {
    if (
      cause instanceof ContentBundleError &&
      ["LIMIT_EXCEEDED", "ABORTED"].includes(cause.code)
    )
      throw cause;
    throw new ContentBundleError(
      "SCHEMA_INVALID",
      "Invalid bundle type definition.",
      "",
      "",
      [],
      { cause },
    );
  }
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
    if (
      cause instanceof ContentBundleError &&
      ["LIMIT_EXCEEDED", "ABORTED"].includes(cause.code)
    )
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
