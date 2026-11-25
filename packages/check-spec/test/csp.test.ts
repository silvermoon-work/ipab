import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { transform } from "esbuild";
import { expect, it } from "vitest";
import { orderedSpec } from "./fixtures.js";

it("executes the actual generated shape validator when dynamic code generation is forbidden", async () => {
  const source = await readFile(
    new URL("../dist/shape-validator.js", import.meta.url),
    "utf8",
  );
  const { code } = await transform(source, {
    format: "iife",
    globalName: "shape",
  });
  const value = orderedSpec();
  const valid: unknown = runInNewContext(
    `${code}; shape.default(value);`,
    { value },
    { contextCodeGeneration: { strings: false, wasm: false } },
  );
  expect(valid).toBe(true);
  value.checkpoints[0]!.id = "../escape";
  const invalid: unknown = runInNewContext(
    `${code}; shape.default(value);`,
    { value },
    { contextCodeGeneration: { strings: false, wasm: false } },
  );
  expect(invalid).toBe(false);
});
