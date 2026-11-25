import { Ajv2020 } from "ajv/dist/2020.js";
import type { AnySchemaObject } from "ajv";
import { validateCheckView, type SpecValidation } from "./spec.js";

export function validateCheckBundleSpec(value: unknown): SpecValidation {
  return validateCheckView(value, (schema) => {
    try {
      new Ajv2020({
        allErrors: true,
        strict: false,
        validateFormats: false,
        addUsedSchema: false,
      }).compile(schema as AnySchemaObject);
      return undefined;
    } catch (error) {
      return {
        path: "/parameter/schema",
        message: `无效的参数 JSON Schema：${String(error)}`,
      };
    }
  });
}
