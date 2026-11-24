export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export const MAX_BYTES = 64 * 1024;

export function json(value: unknown): JsonValue {
  let nodes = 0;
  function visit(input: unknown, depth: number): asserts input is JsonValue {
    if (++nodes > 4096 || depth > 16) throw new Error("JSON limit exceeded");
    if (
      input === null ||
      typeof input === "boolean" ||
      typeof input === "string"
    )
      return;
    if (typeof input === "number" && Number.isFinite(input)) return;
    if (typeof input !== "object") throw new Error("Expected plain JSON");
    if (Object.getOwnPropertySymbols(input).length)
      throw new Error("Unsafe JSON property");
    if (Array.isArray(input)) {
      if (Object.getPrototypeOf(input) !== Array.prototype)
        throw new Error("Expected plain JSON array");
      const descriptors = Object.getOwnPropertyDescriptors(input);
      for (const key of Object.keys(descriptors)) {
        if (key === "length") continue;
        const descriptor = descriptors[key]!;
        if (!/^(0|[1-9][0-9]*)$/.test(key) || !("value" in descriptor))
          throw new Error("Unsafe JSON property");
      }
      for (let index = 0; index < input.length; ++index)
        visit(input[index], depth + 1);
      return;
    }
    if (Object.getPrototypeOf(input) !== Object.prototype)
      throw new Error("Expected plain JSON object");
    for (const [key, descriptor] of Object.entries(
      Object.getOwnPropertyDescriptors(input),
    )) {
      if (
        key === "__proto__" ||
        key === "constructor" ||
        key === "prototype" ||
        !("value" in descriptor)
      )
        throw new Error("Unsafe JSON property");
      visit(descriptor.value, depth + 1);
    }
  }
  visit(value, 0);
  if (new TextEncoder().encode(JSON.stringify(value)).length > MAX_BYTES)
    throw new Error("JSON byte limit exceeded");
  return value;
}

export function object(value: unknown): Record<string, JsonValue> {
  const parsed = json(value);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("Expected object");
  return parsed;
}

export function name(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[a-zA-Z][a-zA-Z0-9._-]{0,63}$/.test(value)
  )
    throw new Error("Invalid name");
  return value;
}

export interface BackendEvent {
  name: string;
  data: JsonValue;
}

export function errorReply(id: string, code: string) {
  return { type: "error", id, error: { code, message: code } };
}
