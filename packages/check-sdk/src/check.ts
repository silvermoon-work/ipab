import { Ajv2020 } from "ajv/dist/2020.js";
import { canonicalJson, parseData } from "@ipab/bundle/data";
import type { CheckBundleSpec } from "@ipab/check-spec/bundle";
import {
  isCheckpoint,
  text,
  type Checkpoint,
  type CheckpointContext,
  type Problem,
} from "./checkpoint.js";

export interface Parameters<Input> {
  readonly schema: Record<string, unknown>;
  parse(value: unknown): Input;
}
const checkBrand: unique symbol = Symbol.for("@ipab/check-sdk/definition/v1");
export interface CheckDefinition<Input = unknown> {
  readonly [checkBrand]: true;
  readonly name: string;
  readonly description: string;
  readonly parameters: Parameters<Input>;
  readonly checkpoints: readonly Checkpoint<Input>[];
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function freezeJson(value: unknown): void {
  if (typeof value !== "object" || value === null) return;
  for (const child of Object.values(value)) freezeJson(child);
  Object.freeze(value);
}
export function defineCheck<Input>(definition: {
  readonly name: string;
  readonly description: string;
  readonly parameters: Parameters<Input>;
  readonly checkpoints:
    Checkpoint<NoInfer<Input>> | readonly Checkpoint<NoInfer<Input>>[];
}): CheckDefinition<Input> {
  text(definition.name);
  text(definition.description);
  const schema = parseData(
    canonicalJson(definition.parameters.schema),
    "application/json",
  );
  if (!record(schema) || schema.type !== "object")
    throw new Error("Check parameters require an object JSON Schema.");
  const validate = new Ajv2020({
    strict: false,
    validateFormats: false,
    addUsedSchema: false,
  }).compile(schema);
  const checkpoints: readonly Checkpoint<Input>[] = isCheckpoint<Input>(
    definition.checkpoints,
  )
    ? [definition.checkpoints]
    : Array.from(definition.checkpoints);
  if (
    !checkpoints.length ||
    checkpoints.some((step) => !isCheckpoint<Input>(step))
  )
    throw new Error("Check requires defined Checkpoints.");
  if (new Set(checkpoints.map((step) => step.id)).size !== checkpoints.length)
    throw new Error("Duplicate Checkpoint ID.");
  const parse = definition.parameters.parse.bind(definition.parameters);
  freezeJson(schema);
  const check: CheckDefinition<Input> = Object.freeze({
    [checkBrand]: true as const,
    name: definition.name,
    description: definition.description,
    parameters: Object.freeze({
      schema,
      parse(value: unknown) {
        if (!validate(value))
          throw new Error(
            `Invalid Check input: ${JSON.stringify(validate.errors)}`,
          );
        return parse(value);
      },
    }),
    checkpoints: Object.freeze(checkpoints),
  });
  return check;
}
export function isCheckDefinition(value: unknown): value is CheckDefinition {
  return (
    typeof value === "object" &&
    value !== null &&
    checkBrand in value &&
    value[checkBrand] === true
  );
}
export function modelOf<Input>(check: CheckDefinition<Input>): CheckBundleSpec {
  return {
    specVersion: "1.0",
    name: check.name,
    description: check.description,
    parameter: { schema: check.parameters.schema },
    checkpoints: check.checkpoints.map((step) => ({
      id: step.id,
      title: step.title,
      description: step.description,
      instructions: step.instructions,
      rules: step.rules.map((rule) => ({ ...rule })),
      output: {
        description: step.output.description,
        ...(step.output.fields
          ? { fields: step.output.fields.map((field) => ({ ...field })) }
          : {}),
      },
    })),
  };
}
export type CheckResult =
  | {
      readonly check: "check";
      readonly checkpoint: string;
      readonly pass: true;
    }
  | {
      readonly check: "check";
      readonly checkpoint: string;
      readonly pass: false;
      readonly problems: readonly [Problem, ...Problem[]];
    };
export async function executeCheck<Input>(
  check: CheckDefinition<Input>,
  value: unknown,
  signal: AbortSignal,
): Promise<CheckResult> {
  signal.throwIfAborted();
  if (!isCheckDefinition(check)) throw new Error("Expected a defined Check.");
  const input = check.parameters.parse(value);
  const outputs = new Map<object, unknown>();
  const context: CheckpointContext = Object.freeze({
    signal,
    outputOf<I, O, C extends string>(checkpoint: Checkpoint<I, O, C>) {
      signal.throwIfAborted();
      if (!outputs.has(checkpoint))
        throw new Error(
          "Checkpoint output is not available in this execution.",
        );
      return outputs.get(checkpoint) as Readonly<O>;
    },
  });
  try {
    for (const step of check.checkpoints) {
      signal.throwIfAborted();
      const result = await step.invoke(input, context);
      signal.throwIfAborted();
      if (!result.pass)
        return {
          check: "check",
          checkpoint: step.id,
          pass: false,
          problems: result.problems,
        };
      outputs.set(step, result.output);
    }
    return {
      check: "check",
      checkpoint: check.checkpoints[check.checkpoints.length - 1]!.id,
      pass: true,
    };
  } finally {
    outputs.clear();
  }
}
