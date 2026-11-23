import { ContentBundleError } from "./errors.js";
import { assertJson, record, safePath } from "./parsing.js";
import type {
  JsonSchema,
  SchemaDefinitions,
  SchemaDescriptor,
} from "./types.js";

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
  "x-content-ref",
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

/** Check every listed definition, including definitions not reachable from main. */
export function inspectSchemaBundle(
  descriptor: unknown,
  files: ReadonlyMap<string, unknown>,
  options: {
    nodes?: number;
    depth?: number;
    jsonDepth?: number;
    schemas?: number;
    charge?: () => void;
  } = {},
): SchemaDefinitions {
  for (const [key, value] of Object.entries(options))
    if (
      key === "charge"
        ? typeof value !== "function"
        : !["nodes", "depth", "jsonDepth", "schemas"].includes(key) ||
          !Number.isSafeInteger(value) ||
          (value as number) <= 0
    )
      throw new ContentBundleError(
        "OPTIONS_INVALID",
        "Schema limits must be positive safe integers.",
      );
  const charge = options.charge ?? (() => {});
  assertJson(descriptor, options.nodes, options.jsonDepth, charge);
  if (
    !record(descriptor) ||
    Object.keys(descriptor).some(
      (key) => !["schemas", "main", "title", "description"].includes(key),
    ) ||
    !Array.isArray(descriptor.schemas) ||
    !descriptor.schemas.length ||
    !absoluteId(descriptor.main)
  )
    invalid("Descriptor requires explicit schemas and an absolute main ID.");
  for (const key of ["title", "description"])
    if (descriptor[key] !== undefined && typeof descriptor[key] !== "string")
      invalid(`Invalid descriptor ${key}.`);
  if (descriptor.schemas.length > (options.schemas ?? 128))
    throw new ContentBundleError(
      "LIMIT_EXCEEDED",
      "Schema file count exceeded.",
    );
  const paths = new Set<string>();
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
    if (typeof schema === "boolean") return;
    if (!record(schema))
      invalid("Expected a schema object or boolean.", pointer);
    for (const key of Object.keys(schema))
      if (!keywords.has(key))
        invalid(`Unsupported schema keyword ${key}.`, pointer);
    if (!root && Object.hasOwn(schema, "$id"))
      invalid("Nested $id is not supported.", pointer);
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
      if (!absoluteId(schema.$ref))
        invalid("$ref must be a full explicit absolute ID.", pointer);
      references.push(schema.$ref);
    }
    if (schema["x-content-ref"] !== undefined) {
      const rule = schema["x-content-ref"];
      if (
        schema.type !== "string" ||
        typeof rule !== "string" ||
        (rule !== "bundle" &&
          (!rule.startsWith("file:") || !absoluteId(rule.slice(5))))
      )
        invalid(
          "x-content-ref requires type:string and bundle or file:<absolute ID>.",
          pointer,
        );
      if (rule !== "bundle") references.push(rule.slice(5));
    }
    if (schema.properties !== undefined) {
      if (!record(schema.properties))
        invalid("properties requires a schema map.", pointer);
      for (const [name, child] of Object.entries(schema.properties))
        visit(
          child,
          false,
          `${pointer}/properties/${pointerPart(name)}`,
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
  for (const path of descriptor.schemas) {
    if (typeof path !== "string")
      invalid("Schema paths must be relative strings.");
    safePath(path);
    if (paths.has(path)) invalid("Duplicate schema file path.");
    paths.add(path);
    const schema = files.get(path);
    if (!record(schema) || !absoluteId(schema.$id))
      invalid(`Schema file ${path} requires a root absolute $id.`);
    if (definitions.has(schema.$id))
      invalid(`Duplicate schema ID ${schema.$id}.`);
    assertJson(schema, options.nodes, options.jsonDepth, charge);
    definitions.set(schema.$id, schema);
    visit(schema, true, path, 0);
  }
  if (!definitions.has(descriptor.main))
    invalid("main is not an exact schema ID in this bundle.");
  for (const ref of references)
    if (!definitions.has(ref)) invalid(`Unknown schema ID ${ref}.`);
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
    if (record(schema.properties))
      for (const child of Object.values(schema.properties))
        productive(child as JsonSchema, depth + 1);
    for (const key of ["items", "additionalProperties"])
      if (schema[key] !== undefined)
        productive(schema[key] as JsonSchema, depth + 1);
  };
  for (const schema of definitions.values()) productive(schema);
  return {
    descriptor: Object.freeze({
      schemas: Object.freeze([...paths]),
      main: descriptor.main,
      ...(descriptor.title === undefined
        ? {}
        : { title: descriptor.title as string }),
      ...(descriptor.description === undefined
        ? {}
        : { description: descriptor.description as string }),
    }) satisfies SchemaDescriptor,
    definitions,
  };
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
  reference(
    rule: string,
    value: string,
    pointer: string,
    inBranch: boolean,
  ): Promise<void>;
}

/** Structural checks and content references are evaluated together in each branch. */
export async function validateValue(
  definitions: SchemaDefinitions,
  id: string,
  value: unknown,
  context: ValidationContext,
): Promise<void> {
  const fail = (pointer: string): never => {
    throw new ContentBundleError(
      "CONTENT_INVALID",
      "Data does not satisfy its schema.",
      "",
      pointer,
    );
  };
  const visit = async (
    schema: JsonSchema,
    data: unknown,
    pointer: string,
    depth: number,
    branch: boolean,
    contentChecks = true,
  ): Promise<void> => {
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
      await visit(
        definitions.definitions.get(schema.$ref)!,
        data,
        pointer,
        depth + 1,
        branch,
        contentChecks,
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
          await visit(
            rule,
            child,
            `${pointer}/${pointerPart(name)}`,
            depth + 1,
            branch,
            contentChecks,
          );
      }
    }
    if (Array.isArray(data) && schema.items !== undefined)
      for (const [index, child] of data.entries())
        await visit(
          schema.items as JsonSchema,
          child,
          `${pointer}/${String(index)}`,
          depth + 1,
          branch,
          contentChecks,
        );
    if (Array.isArray(schema.anyOf)) {
      let success = false;
      for (const child of schema.anyOf) {
        try {
          if (contentChecks)
            await visit(
              child as JsonSchema,
              data,
              pointer,
              depth + 1,
              true,
              false,
            );
          await visit(
            child as JsonSchema,
            data,
            pointer,
            depth + 1,
            true,
            contentChecks,
          );
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
    if (contentChecks && typeof schema["x-content-ref"] === "string")
      await context.reference(
        schema["x-content-ref"],
        data as string,
        pointer,
        branch,
      );
  };
  const schema = definitions.definitions.get(id);
  if (schema === undefined) invalid(`Unknown schema ID ${id}.`);
  await visit(schema, value, "", 0, false, false);
  await visit(schema, value, "", 0, false);
}
