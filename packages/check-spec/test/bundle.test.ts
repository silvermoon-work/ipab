import { describe, expect, it, vi } from "vitest";
import { resolveCheckInstructions, splitCheckSpec } from "../src/bundle.js";
import { orderedSpec } from "./fixtures.js";

const encode = (text: string) => new TextEncoder().encode(text);
function source(files: ReadonlyMap<string, Uint8Array>) {
  return {
    signal: new AbortController().signal,
    readFile: vi.fn((path: string) => {
      const bytes = files.get(path);
      if (!bytes) return Promise.reject(new Error("Missing resource"));
      return Promise.resolve(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        }),
      );
    }),
  };
}
describe("explicit Check content conversion", () => {
  it("rejects generated resource paths beyond the loader's path budget", () => {
    const spec = orderedSpec();
    spec.checkpoints[0]!.id = "a".repeat(1024);
    expect(() => splitCheckSpec(spec)).toThrow("safe Bundle-relative");
  });
  it("round-trips ordered Check instructions through Markdown without changing semantics", async () => {
    const original = orderedSpec();
    const before = structuredClone(original);
    const split = splitCheckSpec(original);
    const context = source(
      new Map([...split.files].map(([path, value]) => [path, encode(value)])),
    );
    expect(split.spec.checkpoints[0]!.instructions).toEqual({
      path: "instructions/context.md",
    });
    expect(await resolveCheckInstructions(split.spec, context)).toEqual(
      original,
    );
    expect(original).toEqual(before);
    expect(split.files.size).toBe(original.checkpoints.length);
  });
  it("retains inline instructions and reuses shared Markdown reads", async () => {
    const split = splitCheckSpec(orderedSpec());
    split.spec.checkpoints[1]!.instructions =
      split.spec.checkpoints[0]!.instructions;
    split.spec.checkpoints[2]!.instructions = "Inline instruction";
    const context = source(
      new Map([
        ["instructions/context.md", encode("# Shared\n\nUse `evidence`.\n")],
      ]),
    );
    const result = await resolveCheckInstructions(split.spec, context);
    expect(result.checkpoints[0]!.instructions).toBe(
      result.checkpoints[1]!.instructions,
    );
    expect(result.checkpoints[2]!.instructions).toBe("Inline instruction");
    expect(context.readFile).toHaveBeenCalledTimes(1);
  });
  it.each([
    {},
    null,
    { path: "../escape.md" },
    { path: "/absolute.md" },
    { path: "https://example.test/a.md" },
    { path: "instructions\\a.md" },
    { path: "instructions/a.md?x" },
    { path: "a.txt" },
    { path: "instructions/%2e%2e/a.md" },
    { path: "a.md", extra: true },
    { path: ".bundle.yaml" },
    { path: "a".repeat(1025) + ".md" },
  ])(
    "rejects unsafe references before reading resources: %j",
    async (instructions) => {
      const split = splitCheckSpec(orderedSpec());
      const value = {
        ...split.spec,
        checkpoints: [{ ...split.spec.checkpoints[0], instructions }],
      };
      const context = source(new Map());
      await expect(resolveCheckInstructions(value, context)).rejects.toThrow(
        "safe Bundle-relative",
      );
      expect(context.readFile).not.toHaveBeenCalled();
    },
  );
  it.each([
    null,
    {},
    { checkpoints: [] },
    { checkpoints: [null] },
    { checkpoints: [{}] },
  ])("rejects invalid Spec before reading %j", async (value) => {
    const context = source(new Map());
    await expect(resolveCheckInstructions(value, context)).rejects.toThrow();
    expect(context.readFile).not.toHaveBeenCalled();
    expect(() => splitCheckSpec(value)).toThrow("Invalid Check Spec");
  });
  it("retains AJV target Schema and identifier uniqueness validation", async () => {
    const split = splitCheckSpec(orderedSpec());
    split.spec.checkpoints[1]!.id = split.spec.checkpoints[0]!.id;
    await expect(
      resolveCheckInstructions(split.spec, source(new Map())),
    ).rejects.toThrow("Invalid Check Spec");
  });
  it.each([
    ["missing", undefined],
    ["invalid UTF-8", new Uint8Array([255])],
    ["blank", encode(" \n\t")],
    ["oversize", new Uint8Array(256 * 1024 + 1)],
  ] as const)(
    "reports %s Markdown with its exact resource path",
    async (_failure, bytes) => {
      const split = splitCheckSpec(orderedSpec());
      const context = source(
        bytes ? new Map([["instructions/context.md", bytes]]) : new Map(),
      );
      await expect(
        resolveCheckInstructions(split.spec, context),
      ).rejects.toThrow(
        "Cannot load Check instructions instructions/context.md",
      );
    },
  );
  it("bounds reference count and aggregate bytes, including shared paths", async () => {
    const split = splitCheckSpec(orderedSpec());
    const checkpoint = split.spec.checkpoints[0]!;
    split.spec.checkpoints = Array.from({ length: 257 }, (_, index) => ({
      ...checkpoint,
      id: `c${index}`,
    }));
    await expect(
      resolveCheckInstructions(split.spec, source(new Map())),
    ).rejects.toThrow("256 references");
    split.spec.checkpoints = Array.from({ length: 5 }, (_, index) => ({
      ...checkpoint,
      id: `c${index}`,
      instructions: { path: `instructions/c${index}.md` },
    }));
    const files = new Map(
      split.spec.checkpoints.map((value) => [
        `instructions/${value.id}.md`,
        encode("x".repeat(256 * 1024)),
      ]),
    );
    await expect(
      resolveCheckInstructions(split.spec, source(files)),
    ).rejects.toThrow("Cannot load Check instructions instructions/c4.md");
  });
  it("propagates abort and cancels an in-progress Markdown stream", async () => {
    const split = splitCheckSpec(orderedSpec());
    const controller = new AbortController();
    const cancel = vi.fn();
    const context = {
      signal: controller.signal,
      readFile: () =>
        Promise.resolve(
          new ReadableStream<Uint8Array>({
            pull() {
              setTimeout(() => {
                controller.abort();
              }, 0);
            },
            cancel,
          }),
        ),
    };
    await expect(resolveCheckInstructions(split.spec, context)).rejects.toThrow(
      "Cannot load",
    );
    expect(cancel).toHaveBeenCalledTimes(1);
    await expect(
      resolveCheckInstructions(split.spec, context),
    ).rejects.toThrow();
  });
});
