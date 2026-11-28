import { encodeSchema, parseData } from "@ipab/bundle";
import { CID } from "multiformats/cid";
import { HostError, object } from "./errors.js";

const parameterSchema = {
  type: "object",
  additionalProperties: false,
  required: ["type"],
  properties: {
    type: { enum: ["string", "number", "boolean", "json"] },
    required: { type: "boolean" },
    default: true,
  },
} as const;

export const templateSchema = {
  contentType: "application/yaml",
  schema: {
    $id: "urn:ipab:project-template.v1",
    type: "object",
    additionalProperties: false,
    required: ["version", "root", "render", "parameters"],
    properties: {
      version: { enum: [1] },
      root: { enum: ["project"] },
      render: {
        type: "object",
        additionalProperties: false,
        required: ["suffix"],
        properties: { suffix: { enum: [".liquid"] } },
      },
      parameters: {
        type: "object",
        required: ["name", "description"],
        additionalProperties: parameterSchema,
        properties: {
          name: {
            type: "object",
            additionalProperties: false,
            required: ["type", "required"],
            properties: {
              type: { enum: ["string"] },
              required: { enum: [true] },
            },
          },
          description: {
            type: "object",
            additionalProperties: false,
            required: ["type", "default"],
            properties: {
              type: { enum: ["string"] },
              default: { enum: [""] },
            },
          },
        },
      },
    },
  },
} as const;

export const templateBuiltinAlias = "builtin:project-template.v1";
export const templateSchemaCid = CID.parse(
  "bafyreieosvcalrhqa3brr3zmxuoryztfmqez2y5ugb37kgrsamvq6n6v5u",
);
export async function builtinTemplateSchema() {
  const block = await encodeSchema(templateSchema);
  if (!block.cid.equals(templateSchemaCid))
    throw new HostError(
      "Builtin Template definition does not match its canonical CID.",
    );
  return block;
}
export interface TemplateParameter {
  type: "string" | "number" | "boolean" | "json";
  required?: boolean;
  default?: unknown;
}
export interface TemplateDefinition {
  version: 1;
  root: "project";
  render: { suffix: ".liquid" };
  parameters: Record<string, TemplateParameter>;
}
function parameterName(name: string) {
  if (
    !/^[A-Za-z][A-Za-z0-9_]*$/.test(name) ||
    ["constructor", "prototype", "__proto__"].includes(name)
  )
    throw new HostError(`Invalid template parameter name: ${name}.`);
}
function jsonData(value: unknown, depth = 0): void {
  if (depth > 32) throw new HostError("Template parameter JSON is too deep.");
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    for (const item of value) jsonData(item, depth + 1);
    return;
  }
  const item = object(value, "Template JSON parameter");
  for (const [key, child] of Object.entries(item)) {
    if (["constructor", "prototype", "__proto__"].includes(key))
      throw new HostError(`Unsafe template JSON key: ${key}.`);
    jsonData(child, depth + 1);
  }
}
function parameterValue(
  value: unknown,
  declaration: TemplateParameter,
  name: string,
) {
  jsonData(value);
  if (declaration.type !== "json" && typeof value !== declaration.type)
    throw new HostError(
      `Template parameter ${name} must be ${declaration.type}.`,
    );
}
export function templateDefinition(bytes: Uint8Array): TemplateDefinition {
  const value = object(
    parseData(bytes, "application/yaml"),
    "Template definition",
  );
  const render = object(value.render, "Template render");
  if (
    value.version !== 1 ||
    value.root !== "project" ||
    render.suffix !== ".liquid" ||
    Object.keys(render).length !== 1 ||
    Object.keys(value).some(
      (key) => !["version", "root", "render", "parameters"].includes(key),
    )
  )
    throw new HostError(
      "Template requires version: 1, root: project and render.suffix: .liquid; no other options are supported.",
    );
  const parameters = object(value.parameters, "Template parameters");
  if (Object.keys(parameters).length > 64)
    throw new HostError("Template supports at most 64 parameters.");
  for (const [name, item] of Object.entries(parameters)) {
    parameterName(name);
    const declaration = object(item, `Template parameter ${name}`);
    if (
      !["string", "number", "boolean", "json"].includes(
        String(declaration.type),
      ) ||
      (declaration.required !== undefined &&
        typeof declaration.required !== "boolean") ||
      Object.keys(declaration).some(
        (key) => !["type", "required", "default"].includes(key),
      )
    )
      throw new HostError(`Invalid template parameter declaration: ${name}.`);
    if (Object.hasOwn(declaration, "default"))
      parameterValue(
        declaration.default,
        declaration as unknown as TemplateParameter,
        name,
      );
  }
  const name = object(parameters.name, "Template name parameter");
  const description = object(
    parameters.description,
    "Template description parameter",
  );
  if (
    name.type !== "string" ||
    name.required !== true ||
    Object.keys(name).length !== 2 ||
    description.type !== "string" ||
    description.default !== "" ||
    Object.keys(description).length !== 2
  )
    throw new HostError(
      "Template must declare required string name and string description with default ''.",
    );
  return value as unknown as TemplateDefinition;
}
export function templateParameters(
  definition: TemplateDefinition,
  name: string,
  inputs: readonly string[] = [],
): Record<string, unknown> {
  const supplied = new Map<string, unknown>([["name", name]]);
  let bytes = Buffer.byteLength(name);
  if (bytes > 64 * 1024)
    throw new HostError("Template parameters exceed 64 KiB.");
  for (const input of inputs) {
    bytes += Buffer.byteLength(input);
    if (bytes > 64 * 1024)
      throw new HostError("Template parameters exceed 64 KiB.");
    const equals = input.indexOf("=");
    const key = input.slice(0, equals);
    parameterName(key);
    if (equals < 1) throw new HostError("--param requires KEY=VALUE.");
    if (supplied.has(key))
      throw new HostError(
        `Duplicate template parameter: ${key}. NAME supplies name.`,
      );
    if (!Object.hasOwn(definition.parameters, key))
      throw new HostError(`Unknown template parameter: ${key}.`);
    const declaration = definition.parameters[key]!;
    const text = input.slice(equals + 1);
    let value: unknown = text;
    if (declaration.type !== "string") {
      try {
        value = JSON.parse(text) as unknown;
      } catch {
        throw new HostError(
          `Template parameter ${key} requires valid JSON (${declaration.type}).`,
        );
      }
    }
    parameterValue(value, declaration, key);
    supplied.set(key, value);
  }
  const values: Record<string, unknown> = {};
  for (const [key, declaration] of Object.entries(definition.parameters)) {
    if (supplied.has(key)) values[key] = supplied.get(key);
    else if (Object.hasOwn(declaration, "default"))
      values[key] = declaration.default;
    else if (declaration.required)
      throw new HostError(
        `Missing template parameter: ${key}. Use --param ${key}=VALUE.`,
      );
    else values[key] = null;
  }
  return values;
}
