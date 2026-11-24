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
const keywords = new Set([
  "$id",
  "$ref",
  "$defs",
  "type",
  "enum",
  "const",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "anyOf",
  "title",
  "description",
]);
const types = new Set([
  "null",
  "boolean",
  "string",
  "number",
  "integer",
  "object",
  "array",
]);

export function inspectSchema(
  value: unknown,
  options: SchemaOptions = {},
): SchemaDefinitions {
  for (const [key, value] of Object.entries(options))
    if (
      key === "charge"
        ? typeof value !== "function"
        : !["nodes", "depth", "jsonDepth", "schemaBytes"].includes(key) ||
          !Number.isSafeInteger(value) ||
          (value as number) <= 0
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
  const definitions = new Map<string, JsonSchema>();
  const references: string[] = [];
  const visit = (
    schema: unknown,
    root: boolean,
    pointer: string,
    depth: number,
  ): void => {
    charge();
    if (depth > (options.depth ?? 64))
      throw new ContentBundleError("LIMIT_EXCEEDED", "Schema depth exceeded.");
    if (typeof schema === "boolean") {
      definitions.set(pointer, schema);
      return;
    }
    if (!record(schema))
      invalid("Expected a schema object or boolean.", pointer);
    for (const key of Object.keys(schema))
      if (!keywords.has(key))
        invalid(`Unsupported schema keyword ${key}.`, pointer);
    if (!root && Object.hasOwn(schema, "$id"))
      invalid("Nested $id is not supported.", pointer);
    if (root && schema.$id !== undefined && !absoluteId(schema.$id))
      invalid("$id must be an absolute URI.", pointer);
    definitions.set(pointer, schema);
    if (
      schema.type !== undefined &&
      (typeof schema.type !== "string" || !types.has(schema.type))
    )
      invalid("type must be one structural type name.", pointer);
    for (const key of ["title", "description"])
      if (schema[key] !== undefined && typeof schema[key] !== "string")
        invalid(`Invalid ${key}.`, pointer);
    if (
      schema.enum !== undefined &&
      (!Array.isArray(schema.enum) || !schema.enum.length)
    )
      invalid("enum requires a nonempty array.", pointer);
    if (
      Array.isArray(schema.enum) &&
      schema.enum.some((value, index, values) =>
        values
          .slice(0, index)
          .some((previous) => equal(value, previous, charge)),
      )
    )
      invalid("enum values must be unique.", pointer);
    if (schema.$ref !== undefined) {
      if (
        typeof schema.$ref !== "string" ||
        (schema.$ref !== "#" && !/^#\/(?:[^~%]|~[01])*$/u.test(schema.$ref))
      )
        invalid("$ref must be a local JSON Pointer.", pointer);
      references.push(schema.$ref);
    }
    for (const key of ["properties", "$defs"])
      if (schema[key] !== undefined) {
        if (!record(schema[key]))
          invalid(`${key} requires a schema map.`, pointer);
        for (const [name, child] of Object.entries(schema[key]))
          visit(
            child,
            false,
            `${pointer}/${key}/${pointerPart(name)}`,
            depth + 1,
          );
      }
    if (
      schema.required !== undefined &&
      (!Array.isArray(schema.required) ||
        schema.required.some((name) => typeof name !== "string") ||
        new Set(schema.required).size !== schema.required.length)
    )
      invalid("required requires unique property names.", pointer);
    for (const key of ["items", "additionalProperties"])
      if (schema[key] !== undefined)
        visit(schema[key], false, `${pointer}/${key}`, depth + 1);
    if (schema.anyOf !== undefined) {
      if (!Array.isArray(schema.anyOf) || !schema.anyOf.length)
        invalid("anyOf requires nonempty full branches.", pointer);
      for (const [index, child] of schema.anyOf.entries())
        visit(child, false, `${pointer}/anyOf/${String(index)}`, depth + 1);
    }
  };
  visit(value, true, "#", 0);
  for (const ref of references)
    if (!definitions.has(ref)) invalid(`Unknown schema pointer ${ref}.`);
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
    if (typeof schema.$ref === "string")
      productive(definitions.get(schema.$ref)!, depth + 1);
    if (Array.isArray(schema.anyOf))
      for (const child of schema.anyOf)
        productive(child as JsonSchema, depth + 1);
    active.delete(schema);
    done.add(schema);
  };
  for (const schema of definitions.values()) productive(schema);
  return {
    schema: definitions.get("#")!,
    definitions,
  };
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
  const definitions = inspectSchema(manifest.entry.schema, options);
  try {
    validateValue(definitions, manifest.entry.defaultValue, {
      charge: options.charge ?? (() => {}),
      depth: options.depth ?? 64,
    });
  } catch (cause) {
    if (
      !(cause instanceof ContentBundleError) ||
      cause.code !== "CONTENT_INVALID"
    )
      throw cause;
    throw new ContentBundleError(
      "SCHEMA_INVALID",
      "defaultValue does not satisfy entry.schema.",
      "",
      `/entry/defaultValue${cause.pointer}`,
      [],
      { cause },
    );
  }
  return { ...definitions, manifest };
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

function equal(a: unknown, b: unknown, charge: () => void): boolean {
  charge();
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b))
    return (
      a.length === b.length &&
      a.every((item, index) => equal(item, b[index], charge))
    );
  if (record(a) && record(b))
    return (
      Object.keys(a).length === Object.keys(b).length &&
      Object.keys(a).every(
        (key) => Object.hasOwn(b, key) && equal(a[key], b[key], charge),
      )
    );
  return false;
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
  const fail = (pointer: string): never => {
    throw new ContentBundleError(
      "CONTENT_INVALID",
      "Data does not satisfy its schema.",
      "",
      pointer,
    );
  };
  const visit = (
    schema: JsonSchema,
    data: unknown,
    pointer: string,
    depth: number,
  ): void => {
    context.charge();
    if (depth > context.depth)
      throw new ContentBundleError(
        "LIMIT_EXCEEDED",
        "Validation depth exceeded.",
        "",
        pointer,
      );
    if (schema === true) return;
    if (schema === false) return fail(pointer);
    const type = schema.type;
    if (type !== undefined) {
      const matches =
        type === "null"
          ? data === null
          : type === "array"
            ? Array.isArray(data)
            : type === "object"
              ? record(data)
              : type === "integer"
                ? typeof data === "number" && Number.isSafeInteger(data)
                : type === "number"
                  ? typeof data === "number" && Number.isFinite(data)
                  : typeof data === type;
      if (!matches) fail(pointer);
    }
    if (
      Object.hasOwn(schema, "const") &&
      !equal(schema.const, data, context.charge)
    )
      fail(pointer);
    if (
      Array.isArray(schema.enum) &&
      !schema.enum.some((item) => equal(item, data, context.charge))
    )
      fail(pointer);
    if (typeof schema.$ref === "string")
      visit(
        definitions.definitions.get(schema.$ref)!,
        data,
        pointer,
        depth + 1,
      );
    if (record(data)) {
      if (
        Array.isArray(schema.required) &&
        schema.required.some((name) => !Object.hasOwn(data, name as string))
      )
        fail(pointer);
      const properties = record(schema.properties) ? schema.properties : {};
      for (const [name, child] of Object.entries(data)) {
        const rule = Object.hasOwn(properties, name)
          ? (properties[name] as JsonSchema)
          : (schema.additionalProperties as JsonSchema | undefined);
        if (rule !== undefined)
          visit(rule, child, `${pointer}/${pointerPart(name)}`, depth + 1);
      }
    }
    if (Array.isArray(data) && schema.items !== undefined)
      for (const [index, child] of data.entries())
        visit(
          schema.items as JsonSchema,
          child,
          `${pointer}/${String(index)}`,
          depth + 1,
        );
    if (Array.isArray(schema.anyOf)) {
      let success = false;
      for (const child of schema.anyOf) {
        try {
          visit(child as JsonSchema, data, pointer, depth + 1);
          success = true;
          break;
        } catch (cause) {
          if (
            !(cause instanceof ContentBundleError) ||
            cause.code !== "CONTENT_INVALID"
          )
            throw cause;
        }
      }
      if (!success) fail(pointer);
    }
  };
  visit(definitions.schema, value, "", 0);
}
