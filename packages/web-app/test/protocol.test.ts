import { describe, expect, it } from "vitest";
import { defineWebAppMethod } from "../src/index.js";
import { json, name, object } from "../src/protocol.js";

describe("bounded JSON", () => {
  it("accepts plain finite JSON and rejects unsafe values", () => {
    expect(json({ x: [null, true, 1, "text", {}] })).toEqual({
      x: [null, true, 1, "text", {}],
    });
    for (const value of [
      undefined,
      NaN,
      Infinity,
      () => 1,
      new Date(),
      Object.create(null) as unknown,
      JSON.parse('{"__proto__":1}') as unknown,
      { constructor: 1 },
      { prototype: 1 },
      { [Symbol("x")]: 1 },
      Object.assign([], { extra: 1 }),
      new (class extends Array<number> {})(),
      Object.defineProperty([1], "0", {
        get() {
          throw new Error("Must not invoke");
        },
      }),
      Array(1) as unknown,
      {
        get x() {
          throw new Error("Must not invoke");
        },
      },
      "x".repeat(65536),
      Array.from({ length: 4097 }, () => 1),
    ])
      expect(() => json(value)).toThrow();
    let nested: unknown = 1;
    for (let i = 0; i < 18; ++i) nested = [nested];
    expect(() => json(nested)).toThrow("limit");
    for (const value of [null, [], true]) expect(() => object(value)).toThrow();
    expect(object({ a: 1 })).toEqual({ a: 1 });
    expect(name("greet.person-1")).toBe("greet.person-1");
    for (const value of ["", "x".repeat(65), "a b", 1])
      expect(() => name(value)).toThrow();
  });

  it("parses both boundaries around the explicitly registered method", async () => {
    const parse = (value: unknown): string => {
      if (typeof value !== "string") throw new Error("Expected string");
      return value.trim();
    };
    const method = defineWebAppMethod({
      request: { parse },
      response: { parse },
      handle: (input) => ` ${input}! `,
    });
    const tools = { signal: new AbortController().signal, emit: () => {} };
    expect(await method.invoke(" hello ", tools)).toBe("hello!");
    await expect(method.invoke(1, tools)).rejects.toThrow("Expected string");
    const bad = defineWebAppMethod({
      request: { parse },
      response: { parse },
      handle: () => 1 as unknown as string,
    });
    await expect(bad.invoke("x", tools)).rejects.toThrow("Expected string");
  });
});
