import { Ajv2020 } from "ajv/dist/2020.js";
import { Check, Errors } from "typebox/schema";
import { ContentBundleError } from "./errors.js";
import { assertJson, record, normalizeBundleManifest } from "./parsing.js";
import * as dagCbor from "@ipld/dag-cbor";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import type {
  BundleManifest,
  JsonSchema,
  SchemaDefinitions,
  SchemaBlock,
} from "./types.js";

export const schemaBlockBytes = 1024 * 1024;
export const schemaDialect = "https://json-schema.org/draft/2020-12/schema";
const meta = new Ajv2020({ strict: false, validateFormats: false });

export function declaresBundleSchema(bytes: Uint8Array): boolean {
  const value: unknown = dagCbor.decode(bytes);
  return record(value) && Object.hasOwn(value, "entry");
}
export interface SchemaOptions {
  nodes?: number;
  depth?: number;
  jsonDepth?: number;
  schemaBytes?: number;
  charge?: () => void;
}
export function pointerPart(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}
export function absoluteId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z][A-Za-z0-9+.-]*:[A-Za-z0-9._~:/?[\]@!$&'()*+,;=%-]+$/u.test(
      value,
    ) &&
    !/%(?![0-9A-Fa-f]{2})/u.test(value)
  );
}
function invalid(message: string, pointer = ""): never {
  throw new ContentBundleError("SCHEMA_INVALID", message, "", pointer);
}
const schemaMaps = [
  "$defs",
  "definitions",
  "properties",
  "patternProperties",
  "dependentSchemas",
];
const schemaArrays = ["allOf", "anyOf", "oneOf", "prefixItems"];
const schemaChildren = [
  "additionalProperties",
  "unevaluatedProperties",
  "propertyNames",
  "items",
  "unevaluatedItems",
  "contains",
  "not",
  "if",
  "then",
  "else",
  "contentSchema",
];
const annotations = new Set([
  "format",
  "dependencies",
  "additionalItems",
  "id",
  "$recursiveRef",
  "$recursiveAnchor",
  "optional",
  "~kind",
  "~refine",
]);
function schemaUri(reference: string, base: string): URL {
  return URL.canParse(reference, base)
    ? new URL(reference, base)
    : new URL(
        base === "urn:typebox:root"
          ? `${base}:${reference}`
          : `${base.slice(0, base.lastIndexOf(":"))}:${reference}`,
      );
}

export function inspectSchema(
  value: unknown,
  options: SchemaOptions = {},
): SchemaDefinitions {
  for (const [key, limit] of Object.entries(options))
    if (
      key === "charge"
        ? typeof limit !== "function"
        : !["nodes", "depth", "jsonDepth", "schemaBytes"].includes(key) ||
          !Number.isSafeInteger(limit) ||
          (limit as number) <= 0
    )
      throw new ContentBundleError(
        "OPTIONS_INVALID",
        "Schema limits must be positive safe integers.",
      );
  const charge = options.charge ?? (() => {});
  try {
    assertJson(value, options.nodes, options.jsonDepth, charge);
  } catch (cause) {
    if (cause instanceof ContentBundleError && cause.code === "CONTENT_INVALID")
      invalid(cause.message);
    throw cause;
  }
  if (typeof value !== "boolean" && !record(value))
    invalid("Expected a JSON Schema object or boolean.");
  const definitions = new Map<string, JsonSchema>();
  const anchors = new Map<string, JsonSchema>();
  const resources = new Map<string, string>();
  const references: {
    schema: JsonSchema;
    reference: string;
    pointer: string;
    resource: string;
    base: string;
  }[] = [];
  const targets = new Map<JsonSchema, JsonSchema[]>();
  const visit = (
    schema: JsonSchema,
    pointer: string,
    depth: number,
    resource = "#",
    base = "urn:typebox:root",
  ): void => {
    charge();
    if (depth > (options.depth ?? 64))
      throw new ContentBundleError("LIMIT_EXCEEDED", "Schema depth exceeded.");
    definitions.set(pointer, schema);
    if (typeof schema === "boolean") return;
    if (pointer === "#" && schema.$id === undefined)
      resources.set(base, pointer);
    if (schema.$id !== undefined) {
      if (
        typeof schema.$id !== "string" ||
        [...schema.$id].some((character) => character.charCodeAt(0) <= 32) ||
        /%(?![0-9A-Fa-f]{2})/u.test(schema.$id)
      )
        invalid("Invalid schema resource $id.", pointer);
      try {
        base = schemaUri(schema.$id, base).href;
      } catch (cause) {
        throw new ContentBundleError(
          "SCHEMA_INVALID",
          "Invalid schema resource $id.",
          "",
          pointer,
          [],
          { cause },
        );
      }
      if (resources.has(base) && resources.get(base) !== pointer)
        invalid("Duplicate schema resource $id.", pointer);
      resources.set(base, pointer);
      resource = pointer;
    }
    if (schema.$schema !== undefined && schema.$schema !== schemaDialect)
      invalid(
        `Only JSON Schema Draft 2020-12 is supported (${schemaDialect}).`,
        pointer,
      );
    if (record(schema.$vocabulary))
      for (const [vocabulary, required] of Object.entries(schema.$vocabulary))
        if (
          required === true &&
          ![
            "core",
            "applicator",
            "unevaluated",
            "validation",
            "meta-data",
            "format-annotation",
            "content",
          ].some(
            (name) =>
              vocabulary ===
              `https://json-schema.org/draft/2020-12/vocab/${name}`,
          )
        )
          invalid(
            `Unsupported required schema vocabulary ${vocabulary}.`,
            pointer,
          );
    const patterns = [
      ...(typeof schema.pattern === "string" ? [schema.pattern] : []),
      ...(record(schema.patternProperties)
        ? Object.keys(schema.patternProperties)
        : []),
    ];
    for (const pattern of patterns)
      try {
        new RegExp(pattern, "u");
      } catch (cause) {
        throw new ContentBundleError(
          "SCHEMA_INVALID",
          "Invalid schema regular expression.",
          "",
          pointer,
          [],
          { cause },
        );
      }
    for (const keyword of ["$ref", "$dynamicRef"]) {
      const reference = schema[keyword];
      if (reference !== undefined) {
        if (typeof reference !== "string")
          invalid("Schema references must be URI strings.", pointer);
        references.push({ schema, reference, pointer, resource, base });
      }
    }
    for (const keyword of ["$anchor", "$dynamicAnchor"]) {
      const anchor = schema[keyword];
      if (typeof anchor === "string") {
        const key = `${base}#${anchor}`;
        if (anchors.has(key) && anchors.get(key) !== schema)
          invalid("Duplicate schema anchor.", pointer);
        anchors.set(key, schema);
      }
    }
    for (const keyword of schemaMaps) {
      const children = schema[keyword];
      if (record(children))
        for (const [name, child] of Object.entries(children))
          if (typeof child === "boolean" || record(child))
            visit(
              child,
              `${pointer}/${keyword}/${pointerPart(name)}`,
              depth + 1,
              resource,
              base,
            );
    }
    for (const keyword of schemaArrays) {
      const children = schema[keyword];
      if (Array.isArray(children))
        for (const [index, child] of children.entries())
          if (typeof child === "boolean" || record(child))
            visit(
              child,
              `${pointer}/${keyword}/${String(index)}`,
              depth + 1,
              resource,
              base,
            );
    }
    for (const keyword of schemaChildren) {
      const child = schema[keyword];
      if (typeof child === "boolean" || record(child))
        visit(child, `${pointer}/${keyword}`, depth + 1, resource, base);
    }
  };
  visit(value, "#", 0);
  try {
    if (!meta.validateSchema(value)) invalid(meta.errorsText(meta.errors));
  } catch (cause) {
    if (cause instanceof ContentBundleError) throw cause;
    throw new ContentBundleError(
      "SCHEMA_INVALID",
      "Invalid Draft 2020-12 schema.",
      "",
      "",
      [],
      { cause },
    );
  }
  for (const { schema, reference, pointer, base } of references) {
    let decoded: string;
    let resource: string | undefined;
    let uri: URL;
    try {
      uri = schemaUri(reference, base);
      decoded = decodeURIComponent(uri.hash || "#");
      uri.hash = "";
      resource = resources.get(uri.href);
    } catch (cause) {
      throw new ContentBundleError(
        "SCHEMA_INVALID",
        "Invalid schema reference encoding.",
        "",
        pointer,
        [],
        { cause },
      );
    }
    if (resource === undefined)
      invalid(
        "Schema references must stay within the schema document; external loading is disabled.",
        pointer,
      );
    const target =
      decoded === "#" || decoded.startsWith("#/")
        ? definitions.get(`${resource}${decoded.slice(1)}`)
        : anchors.get(`${uri.href}${decoded}`);
    if (target === undefined)
      invalid(`Unknown schema reference ${reference}.`, pointer);
    const found = targets.get(schema) ?? [];
    found.push(target);
    targets.set(schema, found);
  }
  const active = new Set<JsonSchema>();
  const done = new Set<JsonSchema>();
  const productive = (schema: JsonSchema, depth = 0): void => {
    charge();
    if (depth > (options.depth ?? 64))
      throw new ContentBundleError(
        "LIMIT_EXCEEDED",
        "Schema reference depth exceeded.",
      );
    if (typeof schema === "boolean" || done.has(schema)) return;
    if (active.has(schema)) invalid("Nonproductive schema reference cycle.");
    active.add(schema);
    for (const target of targets.get(schema) ?? [])
      productive(target, depth + 1);
    for (const keyword of ["allOf", "anyOf", "oneOf"])
      if (Array.isArray(schema[keyword]))
        for (const child of schema[keyword])
          productive(child as JsonSchema, depth + 1);
    for (const keyword of ["not", "if", "then", "else", "dependentSchemas"])
      if (typeof schema[keyword] === "boolean" || record(schema[keyword])) {
        if (keyword === "dependentSchemas") {
          for (const child of Object.values(schema[keyword]))
            productive(child as JsonSchema, depth + 1);
        } else productive(schema[keyword], depth + 1);
      }
    active.delete(schema);
    done.add(schema);
  };
  for (const schema of definitions.values()) productive(schema);
  return { schema: value, definitions };
}

function checkSize(bytes: Uint8Array, options: SchemaOptions): void {
  if (
    bytes.byteLength >
    Math.min(schemaBlockBytes, options.schemaBytes ?? schemaBlockBytes)
  )
    throw new ContentBundleError(
      "LIMIT_EXCEEDED",
      "Schema exceeds its single-block byte limit.",
    );
}
function schemaBlock(
  cid: CID,
  bytes: Uint8Array,
  definitions: SchemaDefinitions & { manifest: BundleManifest },
): SchemaBlock {
  const identity = Uint8Array.from(cid.bytes);
  const encoded = Uint8Array.from(bytes);
  return Object.freeze({
    ...definitions,
    get cid() {
      return CID.decode(Uint8Array.from(identity));
    },
    get bytes() {
      return Uint8Array.from(encoded);
    },
  });
}
export function inspectBundleSchema(
  value: unknown,
  options: SchemaOptions = {},
): SchemaDefinitions & { manifest: BundleManifest } {
  let manifest: BundleManifest;
  try {
    assertJson(value, options.nodes, options.jsonDepth, options.charge);
    manifest = normalizeBundleManifest(value);
  } catch (cause) {
    if (cause instanceof ContentBundleError && cause.code !== "CONTENT_INVALID")
      throw cause;
    throw new ContentBundleError(
      "SCHEMA_INVALID",
      `Invalid bundle type definition: ${cause instanceof Error ? cause.message : "invalid data"}`,
      "",
      "",
      [],
      { cause },
    );
  }
  return { ...inspectSchema(manifest.entry.schema ?? true, options), manifest };
}
export async function encodeSchema(
  value: unknown,
  options: SchemaOptions = {},
): Promise<SchemaBlock> {
  const definitions = inspectBundleSchema(value, options);
  const bytes = dagCbor.encode(definitions.manifest);
  checkSize(bytes, options);
  const cid = CID.createV1(dagCbor.code, await sha256.digest(bytes));
  return schemaBlock(
    cid,
    bytes,
    inspectBundleSchema(dagCbor.decode(bytes), options),
  );
}
export async function decodeSchema(
  cid: CID,
  bytes: Uint8Array,
  options: SchemaOptions = {},
): Promise<SchemaBlock> {
  if (
    cid.version !== 1 ||
    cid.code !== dagCbor.code ||
    cid.multihash.code !== sha256.code
  )
    invalid("Schema must be a CIDv1 DAG-CBOR SHA-256 block.");
  checkSize(bytes, options);
  const digest = await sha256.digest(bytes);
  if (
    digest.digest.length !== cid.multihash.digest.length ||
    !digest.digest.every((byte, index) => byte === cid.multihash.digest[index])
  )
    throw new ContentBundleError(
      "CONTENT_UNAVAILABLE",
      "Corrupt schema block.",
    );
  let value: unknown;
  try {
    value = dagCbor.decode(bytes);
  } catch (cause) {
    throw new ContentBundleError(
      "SCHEMA_INVALID",
      "Invalid DAG-CBOR schema.",
      "",
      "",
      [],
      { cause },
    );
  }
  const definitions = inspectBundleSchema(value, options);
  const canonical = dagCbor.encode(definitions.manifest);
  if (
    canonical.length !== bytes.length ||
    !canonical.every((byte, index) => byte === bytes[index])
  )
    invalid("Schema block must use canonical DAG-CBOR encoding.");
  return schemaBlock(cid, bytes, definitions);
}
export interface ValidationContext {
  charge(this: void): void;
  depth: number;
}
export function validateValue(
  definitions: SchemaDefinitions,
  value: unknown,
  context: ValidationContext,
): void {
  assertJson(value, 100_000, context.depth, context.charge);
  const schemas = new Set<object>(
    [...definitions.definitions.values()].filter(record),
  );
  const proxies = new WeakMap<object, object>();
  // Meter interpreter accesses without modifying caller-owned or frozen JSON.
  const track = (value: unknown): unknown => {
    if (value === null || typeof value !== "object") return value;
    const existing = proxies.get(value);
    if (existing) return existing;
    const target = Array.isArray(value)
      ? [...(value as unknown[])]
      : { ...value };
    const isSchema = schemas.has(value);
    const proxy = new Proxy(target, {
      get(target, key, receiver): unknown {
        context.charge();
        if (isSchema && typeof key === "string" && annotations.has(key))
          return undefined;
        return track(Reflect.get(target, key, receiver));
      },
      ownKeys(target) {
        context.charge();
        return Reflect.ownKeys(target);
      },
      has(target, key) {
        context.charge();
        return Reflect.has(target, key);
      },
    });
    proxies.set(value, proxy);
    return proxy;
  };
  const trackedSchema = track(definitions.schema);
  if (typeof trackedSchema !== "boolean" && !record(trackedSchema))
    invalid("Expected a JSON Schema object or boolean.");
  try {
    const trackedValue = track(value);
    if (Check(trackedSchema, trackedValue)) return;
    const [, errors] = Errors(trackedSchema, trackedValue);
    const error = errors[0];
    throw new ContentBundleError(
      "CONTENT_INVALID",
      error?.message ?? "Data does not satisfy its schema.",
      "",
      error?.instancePath ?? "",
    );
  } catch (cause) {
    if (cause instanceof ContentBundleError) throw cause;
    throw new ContentBundleError(
      "SCHEMA_INVALID",
      "Schema evaluation failed.",
      "",
      "",
      [],
      { cause },
    );
  }
}
