import type { ErrorObject } from "ajv";
import validateShape from "#check-shape";
export { checkBundleSpecSchema } from "./shape-schema.js";

export interface CheckpointDefinition {
  id: string;
  title: string;
  description: string;
  instructions: string;
  output: {
    description: string;
    fields?: { name: string; description: string }[];
  };
  rules: { code: string; description: string }[];
}

export interface CheckBundleSpec {
  $schema?: "urn:ipfsaw:check-bundle:1";
  specVersion: "1.0";
  name: string;
  description: string;
  parameter: {
    schema: Record<string, unknown>;
  };
  checkpoints: CheckpointDefinition[];
}

export interface SpecIssue {
  path: string;
  message: string;
}
export type SpecValidation =
  | { valid: true; spec: CheckBundleSpec }
  | { valid: false; issues: SpecIssue[] };

function isJson(value: unknown, ancestors = new Set<object>()): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || ancestors.has(value)) return false;
  if (
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  )
    return false;
  const next = new Set(ancestors).add(value);
  return Object.values(value).every((item: unknown) => isJson(item, next));
}

function shapeIssues(errors: ErrorObject[]): SpecIssue[] {
  return errors.map((error) => ({
    path: error.instancePath || "/",
    message: `${error.message ?? "invalid"} ${JSON.stringify(error.params)}`,
  }));
}

export function validateCheckView(
  value: unknown,
  validateParameter?: (
    schema: Record<string, unknown>,
  ) => SpecIssue | undefined,
): SpecValidation {
  try {
    if (!isJson(value))
      return {
        valid: false,
        issues: [{ path: "/", message: "Spec 必须是无循环的 JSON 数据。" }],
      };
    if (!validateShape(value))
      return { valid: false, issues: shapeIssues(validateShape.errors ?? []) };
    const issues: SpecIssue[] = [];
    const parameterIssue = validateParameter?.(value.parameter.schema);
    if (parameterIssue) issues.push(parameterIssue);
    const ids = new Set<string>();
    value.checkpoints.forEach((checkpoint, index) => {
      const base = `/checkpoints/${String(index)}`;
      if (ids.has(checkpoint.id))
        issues.push({
          path: `${base}/id`,
          message: `重复的 checkpoint ID：${checkpoint.id}`,
        });
      ids.add(checkpoint.id);
      const names = new Set<string>();
      checkpoint.output.fields?.forEach((field, fieldIndex) => {
        if (names.has(field.name))
          issues.push({
            path: `${base}/output/fields/${String(fieldIndex)}/name`,
            message: `本 checkpoint 中重复的输出字段名：${field.name}`,
          });
        names.add(field.name);
      });
      const codes = new Set<string>();
      checkpoint.rules.forEach((rule, ruleIndex) => {
        if (codes.has(rule.code))
          issues.push({
            path: `${base}/rules/${String(ruleIndex)}/code`,
            message: `本 checkpoint 中重复的规则码：${rule.code}`,
          });
        codes.add(rule.code);
      });
    });
    return issues.length
      ? { valid: false, issues }
      : { valid: true, spec: value };
  } catch (error) {
    return {
      valid: false,
      issues: [{ path: "/", message: `无法读取 Spec：${String(error)}` }],
    };
  }
}
