import { canonicalJson } from "@ipab/bundle/data";

export interface Rule<Code extends string = string> {
  readonly code: Code;
  readonly description: string;
}
export interface OutputDocumentation {
  readonly description: string;
  readonly fields?: readonly {
    readonly name: string;
    readonly description: string;
  }[];
}
export type JsonValue =
  | null
  | string
  | boolean
  | number
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };
export interface Problem<Code extends string = string> {
  readonly code: Code;
  readonly context: JsonValue;
}
export type CheckpointResult<Output, Code extends string = string> =
  | { readonly pass: true; readonly output: Output }
  | {
      readonly pass: false;
      readonly problems: readonly [Problem<Code>, ...Problem<Code>[]];
    };
export interface CheckpointContext {
  readonly signal: AbortSignal;
  outputOf<Input, Output, Code extends string>(
    checkpoint: Checkpoint<Input, Output, Code>,
  ): Readonly<Output>;
}
const checkpointBrand: unique symbol = Symbol.for(
  "@ipab/check-sdk/checkpoint/v1",
);
export interface Checkpoint<
  Input = unknown,
  Output = unknown,
  Code extends string = string,
> {
  readonly [checkpointBrand]: true;
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly instructions: string;
  readonly rules: readonly Rule<Code>[];
  readonly output: OutputDocumentation;
  readonly invoke: (
    input: Input,
    context: CheckpointContext,
  ) => Promise<CheckpointResult<Output, Code>>;
}
export function identifier(value: string): void {
  if (
    !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(value) ||
    /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(value)
  )
    throw new Error(`Invalid Check identifier: ${value}`);
}
export function text(value: string): void {
  if (!value.trim()) throw new Error("Check documentation must not be blank.");
}
export function isCheckpoint<Input = unknown>(
  value: unknown,
): value is Checkpoint<Input> {
  return (
    typeof value === "object" &&
    value !== null &&
    checkpointBrand in value &&
    value[checkpointBrand] === true
  );
}
function exact(value: object, keys: readonly string[]): boolean {
  return (
    Reflect.ownKeys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}
function validateResult(value: unknown, rules: readonly Rule[]): void {
  if (typeof value !== "object" || value === null || !("pass" in value))
    throw new Error("Invalid Checkpoint result.");
  if (value.pass === true && exact(value, ["pass", "output"])) return;
  if (
    value.pass !== false ||
    !exact(value, ["pass", "problems"]) ||
    !("problems" in value) ||
    !Array.isArray(value.problems) ||
    !value.problems.length
  )
    throw new Error("Invalid Checkpoint result.");
  for (const item of value.problems) {
    const problem: unknown = item;
    if (
      typeof problem !== "object" ||
      problem === null ||
      !exact(problem, ["code", "context"]) ||
      !("code" in problem) ||
      !rules.some((rule) => rule.code === problem.code) ||
      !("context" in problem)
    )
      throw new Error("Invalid or undeclared Checkpoint problem.");
    canonicalJson(problem.context);
  }
}
export function defineCheckpoint<
  Input,
  Output,
  const Rules extends readonly [Rule, ...Rule[]],
>(definition: {
  readonly id: string;
  readonly title?: string;
  readonly description: string;
  readonly instructions: string;
  readonly rules: Rules;
  readonly output: OutputDocumentation;
  readonly check: (
    input: Input,
    context: CheckpointContext,
  ) =>
    | CheckpointResult<Output, Rules[number]["code"]>
    | Promise<CheckpointResult<Output, Rules[number]["code"]>>;
}): Checkpoint<Input, Output, Rules[number]["code"]> {
  identifier(definition.id);
  const title = definition.title ?? definition.id;
  for (const value of [
    title,
    definition.description,
    definition.instructions,
    definition.output.description,
  ])
    text(value);
  if (!definition.rules.length) throw new Error("Checkpoint requires rules.");
  const codes = new Set<string>();
  const rules = definition.rules.map((rule) => {
    identifier(rule.code);
    text(rule.description);
    if (codes.has(rule.code))
      throw new Error("Duplicate Checkpoint rule code.");
    codes.add(rule.code);
    return Object.freeze({ ...rule });
  });
  const names = new Set<string>();
  const fields = definition.output.fields?.map((field) => {
    text(field.name);
    text(field.description);
    if (names.has(field.name)) throw new Error("Duplicate output field.");
    names.add(field.name);
    return Object.freeze({ ...field });
  });
  if (fields?.length === 0) throw new Error("Output fields must not be empty.");
  const check = definition.check;
  return Object.freeze({
    [checkpointBrand]: true as const,
    id: definition.id,
    title,
    description: definition.description,
    instructions: definition.instructions,
    rules: Object.freeze(rules),
    output: Object.freeze({
      description: definition.output.description,
      ...(fields ? { fields: Object.freeze(fields) } : {}),
    }),
    async invoke(input: Input, context: CheckpointContext) {
      context.signal.throwIfAborted();
      const result = await check(input, context);
      context.signal.throwIfAborted();
      validateResult(result, rules);
      return result;
    },
  });
}
