import { expect, expectTypeOf, it, vi } from "vitest";
import { canonicalJson } from "@ipab/bundle/data";
import { memoryFile } from "@ipab/bundle-builder";
import { checkSpecDefinition, splitCheckSpec } from "@ipab/check-spec/bundle";
import {
  defineCheck,
  defineCheckpoint,
  executeCheck,
  modelOf,
  runCheck,
  type CheckAppContext,
  type CheckpointContext,
  type CheckpointResult,
} from "../src/index.js";
import { readJson } from "../src/io.js";

interface Input {
  text: string;
}
const parameters = {
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["text"],
    properties: { text: { type: "string" } },
  },
  parse(value: unknown): Input {
    if (
      typeof value !== "object" ||
      value === null ||
      !("text" in value) ||
      typeof value.text !== "string"
    )
      throw new Error("Expected text.");
    return value as Input;
  },
};
const documentation = {
  id: "text",
  description: "Check the input.",
  instructions: "Read text and check it.",
  rules: [{ code: "text-valid", description: "Text is valid." }] as const,
  output: { description: "Verified text." },
};
const good = (id = "text") =>
  defineCheckpoint({
    ...documentation,
    id,
    check: (input: Input) => ({ pass: true, output: input.text }),
  });
const signal = () => new AbortController().signal;
const create = (checkpoints = [good()]) =>
  defineCheck({
    name: "Text Check",
    description: "Check text.",
    parameters,
    checkpoints,
  });
const json = (value: unknown) => memoryFile(canonicalJson(value));

it("composes ordered checkpoints and retains typed execution-local output identity", async () => {
  const output = { map: new Map<string, string>(), self: {} as object };
  output.self = output;
  const first = defineCheckpoint({
    ...documentation,
    output: {
      description: "Execution-local facts.",
      fields: [{ name: "map", description: "Shared capability." }],
    },
    check: () => ({ pass: true, output }),
  });
  let retained: CheckpointContext | undefined;
  const foreign = good("foreign");
  const second = defineCheckpoint({
    ...documentation,
    id: "second",
    check: (_input: Input, context) => {
      retained = context;
      const observed = context.outputOf(first);
      expectTypeOf(observed).toEqualTypeOf<Readonly<typeof output>>();
      expect(observed).toBe(output);
      expect(observed.map).toBe(output.map);
      expect(() => {
        context.outputOf(second);
      }).toThrow("not available");
      expect(() => context.outputOf(foreign)).toThrow("not available");
      return { pass: true, output: undefined };
    },
  });
  const check = defineCheck({
    name: "Composed Check",
    description: "Read facts in order.",
    parameters,
    checkpoints: [first, second],
  });
  expect(await executeCheck(check, { text: "hello" }, signal())).toEqual({
    check: "check",
    checkpoint: "second",
    pass: true,
  });
  expect(() => retained?.outputOf(first)).toThrow("not available");
  await executeCheck(check, { text: "hello" }, signal());
  expect(output.self).toBe(output);
});

it("stops at the first failure and preserves all problem contexts without documents", async () => {
  const last = vi.fn(() => ({
    pass: true as const,
    output: undefined,
  }));
  const failure = defineCheckpoint({
    ...documentation,
    id: "failure",
    check: () => ({
      pass: false,
      problems: [
        { code: "text-valid", context: { actual: "one" } },
        { code: "text-valid", context: { actual: "two" } },
      ],
    }),
  });
  const check = defineCheck({
    name: "Failing Check",
    description: "Check in order.",
    parameters,
    checkpoints: [
      good(),
      failure,
      defineCheckpoint({ ...documentation, id: "last", check: last }),
    ],
  });
  expect(await executeCheck(check, { text: "hello" }, signal())).toEqual({
    check: "check",
    checkpoint: "failure",
    pass: false,
    problems: [
      { code: "text-valid", context: { actual: "one" } },
      { code: "text-valid", context: { actual: "two" } },
    ],
  });
  expect(last).not.toHaveBeenCalled();
});

it("accepts a single checkpoint and validates global parameters before invoking it", async () => {
  const check = defineCheck({
    name: "Single Check",
    description: "Single step.",
    parameters,
    checkpoints: good(),
  });
  expectTypeOf(
    check.parameters.parse({ text: "hello" }),
  ).toEqualTypeOf<Input>();
  expect((await executeCheck(check, { text: "hello" }, signal())).pass).toBe(
    true,
  );
  for (const input of [{}, { text: 1 }, { text: "hello", secret: true }])
    await expect(executeCheck(check, input, signal())).rejects.toThrow(
      "Invalid Check input",
    );
  const broken = defineCheck({
    name: "Parser Check",
    description: "Parser errors propagate.",
    parameters: {
      ...parameters,
      parse() {
        throw new Error("parser failed");
      },
    },
    checkpoints: good(),
  });
  await expect(
    executeCheck(broken, { text: "hello" }, signal()),
  ).rejects.toThrow("parser failed");
});

it.each([
  { id: "CON" },
  { title: "" },
  { description: " " },
  { instructions: "" },
  { rules: [{ code: "BAD", description: "Bad identifier." }] },
  {
    rules: [
      { code: "same", description: "One." },
      { code: "same", description: "Two." },
    ],
  },
  { output: { description: "" } },
  { output: { description: "Facts.", fields: [] } },
  {
    output: {
      description: "Facts.",
      fields: [
        { name: "x", description: "One." },
        { name: "x", description: "Two." },
      ],
    },
  },
])("rejects invalid author metadata: %j", (override) => {
  expect(() =>
    defineCheckpoint({
      ...documentation,
      ...override,
      // @ts-expect-error Deliberately exercise invalid JavaScript author input.
      rules: override.rules ?? documentation.rules,
      check: () => ({ pass: true, output: undefined }),
    }),
  ).toThrow();
});

it("rejects empty/duplicate compositions and invalid parameter schemas", () => {
  const base = { name: "Check", description: "Check input.", parameters };
  expect(() => defineCheck({ ...base, checkpoints: [] })).toThrow("requires");
  expect(() => defineCheck({ ...base, checkpoints: [good(), good()] })).toThrow(
    "Duplicate",
  );
  expect(() =>
    defineCheck({
      ...base,
      parameters: { ...parameters, schema: { type: "array" } },
      checkpoints: good(),
    }),
  ).toThrow("object JSON Schema");
  expect(() =>
    defineCheck({
      ...base,
      parameters: {
        ...parameters,
        schema: { type: "object", $ref: "missing" },
      },
      checkpoints: good(),
    }),
  ).toThrow();
});

it("copies and freezes the global schema so later author mutations cannot change the model", async () => {
  const schema = structuredClone(parameters.schema);
  const check = defineCheck({
    name: "Stable parameters",
    description: "Stable model and validation.",
    parameters: { ...parameters, schema },
    checkpoints: good(),
  });
  schema.properties.text.type = "number";
  expect((await executeCheck(check, { text: "hello" }, signal())).pass).toBe(
    true,
  );
  expect(modelOf(check).parameter.schema).not.toEqual(schema);
  expect(() => {
    Reflect.set(check.parameters.schema, "type", "array");
  }).not.toThrow();
  expect(check.parameters.schema.type).toBe("object");
});

it.each([
  null,
  { pass: true },
  { pass: false, problems: [] },
  { pass: false, problems: [{ code: "unknown", context: {} }] },
  { pass: false, problems: [{ code: "text-valid" }] },
  { pass: false, problems: [{ code: "text-valid", context: new Map() }] },
  { pass: false, problems: [{ code: "text-valid", context: { value: NaN } }] },
])(
  "treats invalid callback output as an execution error: %j",
  async (value) => {
    const step = defineCheckpoint({
      ...documentation,
      // @ts-expect-error Deliberately return an invalid JavaScript result.
      check: () => value,
    });
    const check = defineCheck({
      name: "Invalid output",
      description: "Reject invalid results.",
      parameters,
      checkpoints: step,
    });
    await expect(
      executeCheck(check, { text: "hello" }, signal()),
    ).rejects.toThrow();
  },
);

it.each(["before", "during", "throw"] as const)(
  "propagates %s cancellation or execution errors",
  async (mode) => {
    const abort = new AbortController();
    const cause = new Error("stopped");
    const later = vi.fn(() => ({
      pass: true as const,
      output: undefined,
    }));
    if (mode === "before") abort.abort(cause);
    const first = defineCheckpoint({
      ...documentation,
      check: async (): Promise<CheckpointResult<undefined, "text-valid">> => {
        await Promise.resolve();
        if (mode === "throw") throw cause;
        abort.abort(cause);
        return { pass: true, output: undefined };
      },
    });
    const check = defineCheck({
      name: "Abort",
      description: "Stop safely.",
      parameters,
      checkpoints: [
        first,
        defineCheckpoint({ ...documentation, id: "later", check: later }),
      ],
    });
    await expect(
      executeCheck(check, { text: "hello" }, abort.signal),
    ).rejects.toBe(cause);
    expect(later).not.toHaveBeenCalled();
  },
);

it("bounds and strictly parses STDIN, cancelling oversized streams", async () => {
  expect(await readJson(json({ text: "hello" }), signal())).toEqual({
    text: "hello",
  });
  for (const source of [
    '{"text":"one","text":"two"}',
    '{"text":"hello"}{}',
    "",
  ])
    await expect(
      readJson(memoryFile(Buffer.from(source)), signal()),
    ).rejects.toThrow();
  await expect(
    readJson(memoryFile(Uint8Array.of(0xff)), signal()),
  ).rejects.toThrow();
  const cancel = vi.fn();
  const oversized = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(1024 * 1024 + 1));
    },
    cancel,
  });
  await expect(readJson(oversized, signal())).rejects.toThrow("1 MiB");
  expect(cancel).toHaveBeenCalledOnce();
});

function host(check = create()) {
  const cid = "bafybeiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const { spec, files: instructions } = splitCheckSpec(modelOf(check));
  const files = new Map<string, Uint8Array>([
    ["resources/check-model.json", canonicalJson({ cid })],
    [".bundle.yaml", canonicalJson(checkSpecDefinition)],
    ["check.yaml", canonicalJson(spec)],
    ...[...instructions].map(([path, text]): [string, Uint8Array] => [
      path,
      Buffer.from(text),
    ]),
  ]);
  const written = new Map<string, unknown>();
  const context: CheckAppContext = {
    appCid: cid,
    readFile: vi.fn<CheckAppContext["readFile"]>((root, path) => {
      if (root !== cid) return Promise.reject(new Error("Unexpected root."));
      const bytes = files.get(path);
      if (!bytes) return Promise.reject(new Error(`Missing ${path}`));
      return Promise.resolve(memoryFile(bytes));
    }),
    output: {
      link: vi.fn<CheckAppContext["output"]["link"]>(() => Promise.resolve()),
      writeFile: vi.fn<CheckAppContext["output"]["writeFile"]>(
        async (path, stream) => {
          written.set(path, await readJson(stream, signal()));
          return cid;
        },
      ),
    },
  };
  return { check, cid, context, files, written };
}

it("writes the result entry and real model link without publishing execution-local output", async () => {
  const fixture = host();
  const abortSignal = signal();
  const result = await runCheck(fixture.check, {
    context: fixture.context,
    input: json({ text: "hello" }),
    signal: abortSignal,
  });
  expect(fixture.context.output.link).toHaveBeenCalledWith(
    "check",
    fixture.cid,
    { signal: abortSignal },
  );
  expect(fixture.written.get("result.json")).toEqual(result);
  expect(JSON.stringify(fixture.written.get("result.json"))).not.toContain(
    "output",
  );
  expect(fixture.written.has(".bundle.yaml")).toBe(true);
});

it.each([
  "metadata",
  "cid",
  "type",
  "model",
  "instructions",
  "input",
  "link",
  "write",
] as const)(
  "does not turn %s faults into a successful result",
  async (mode) => {
    const fixture = host();
    if (mode === "metadata")
      fixture.files.set(
        "resources/check-model.json",
        canonicalJson({ bad: true }),
      );
    if (mode === "cid")
      fixture.files.set(
        "resources/check-model.json",
        canonicalJson({
          cid: "bafkreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        }),
      );
    if (mode === "type")
      fixture.files.set(
        ".bundle.yaml",
        canonicalJson({ ...checkSpecDefinition, name: "Other type" }),
      );
    if (mode === "model") {
      const { spec } = splitCheckSpec({
        ...modelOf(fixture.check),
        name: "Other Check",
      });
      fixture.files.set("check.yaml", canonicalJson(spec));
    }
    if (mode === "instructions") fixture.files.delete("instructions/text.md");
    if (mode === "link")
      vi.mocked(fixture.context.output.link).mockRejectedValue(
        new Error("link fault"),
      );
    if (mode === "write")
      vi.mocked(fixture.context.output.writeFile).mockRejectedValue(
        new Error("write fault"),
      );
    await expect(
      runCheck(fixture.check, {
        context: fixture.context,
        input: json(mode === "input" ? {} : { text: "hello" }),
        signal: signal(),
      }),
    ).rejects.toThrow();
    expect(fixture.written.has("result.json")).toBe(false);
  },
);

it("uses the global IPAB context and removes owned signal handlers on completion", async () => {
  const fixture = host();
  const before = [
    process.listenerCount("SIGINT"),
    process.listenerCount("SIGTERM"),
  ];
  vi.stubGlobal("ipab", fixture.context);
  try {
    await runCheck(fixture.check, { input: json({ text: "hello" }) });
    expect([
      process.listenerCount("SIGINT"),
      process.listenerCount("SIGTERM"),
    ]).toEqual(before);
  } finally {
    vi.unstubAllGlobals();
  }
  await expect(
    runCheck(fixture.check, { input: json({ text: "hello" }) }),
  ).rejects.toThrow("IPAB context");
});

it("enforces the inclusive Bundle result-entry byte limit before output operations", async () => {
  const header = {
    check: "check",
    checkpoint: "text",
    pass: false,
    problems: [{ code: "text-valid", context: "" }],
  };
  const size = 8 * 1024 * 1024;
  const overhead = canonicalJson(header).byteLength;
  for (const extra of [0, 1]) {
    const step = defineCheckpoint({
      ...documentation,
      check: () => ({
        pass: false,
        problems: [
          { code: "text-valid", context: "x".repeat(size - overhead + extra) },
        ],
      }),
    });
    const check = defineCheck({
      name: "Result budget",
      description: "Keep the entry loadable.",
      parameters,
      checkpoints: step,
    });
    const fixture = host(check);
    vi.mocked(fixture.context.output.writeFile).mockImplementation(
      async (path, stream) => {
        fixture.written.set(path, null);
        await stream.pipeTo(new WritableStream<Uint8Array>());
        return fixture.cid;
      },
    );
    const run = runCheck(check, {
      context: fixture.context,
      input: json({ text: "hello" }),
      signal: signal(),
    });
    if (extra === 0) {
      expect((await run).pass).toBe(false);
      expect(fixture.context.output.link).toHaveBeenCalledOnce();
    } else {
      await expect(run).rejects.toThrow("8 MiB");
      expect(fixture.context.output.link).not.toHaveBeenCalled();
      expect(fixture.context.output.writeFile).not.toHaveBeenCalled();
    }
  }
});

it.each(["SIGINT", "SIGTERM"] as const)(
  "cancels on %s without writing a result and removes owned listeners",
  async (event) => {
    const fixture = host();
    const before = process.listenerCount(event);
    const exitCode = process.exitCode;
    vi.mocked(fixture.context.readFile).mockImplementationOnce(() => {
      process.emit(event);
      return Promise.resolve(json({ cid: fixture.cid }));
    });
    try {
      await expect(
        runCheck(fixture.check, {
          context: fixture.context,
          input: json({ text: "hello" }),
        }),
      ).rejects.toThrow(event === "SIGINT" ? "interrupted" : "terminated");
      expect(process.exitCode).toBe(event === "SIGINT" ? 130 : 143);
      expect(fixture.written.size).toBe(0);
      expect(process.listenerCount(event)).toBe(before);
    } finally {
      process.exitCode = exitCode;
    }
  },
);
