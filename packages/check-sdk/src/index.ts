import { Readable } from "node:stream";
import { CID } from "multiformats/cid";
import {
  canonicalJson,
  encodeSchema,
  parseBundleManifest,
  validateSchemaValue,
} from "@ipab/bundle/data";
import {
  checkSpecDefinition,
  resolveCheckInstructions,
} from "@ipab/check-spec/bundle";
import {
  executeCheck,
  modelOf,
  type CheckDefinition,
  type CheckResult,
} from "./check.js";
import { jsonStream, readJson } from "./io.js";
import { resultDefinition } from "./result.js";
import type { ContentType } from "@ipab/bundle";

export * from "./checkpoint.js";
export * from "./check.js";
export { resultDefinition } from "./result.js";
export interface CheckAppContext {
  readonly appCid: string;
  readFile(
    this: void,
    rootCid: string,
    path: string,
    options?: { signal?: AbortSignal },
  ): Promise<ReadableStream<Uint8Array>>;
  readonly output: {
    writeFile(
      this: void,
      path: string,
      stream: ReadableStream<Uint8Array>,
      options?: { signal?: AbortSignal },
    ): Promise<string>;
    link(
      this: void,
      path: string,
      unixfsCid: string,
      options?: { signal?: AbortSignal },
    ): Promise<void>;
  };
}
function isContext(value: unknown): value is CheckAppContext {
  return (
    typeof value === "object" &&
    value !== null &&
    "appCid" in value &&
    typeof value.appCid === "string" &&
    "readFile" in value &&
    typeof value.readFile === "function" &&
    "output" in value &&
    typeof value.output === "object" &&
    value.output !== null &&
    "writeFile" in value.output &&
    typeof value.output.writeFile === "function" &&
    "link" in value.output &&
    typeof value.output.link === "function"
  );
}
function appContext(): CheckAppContext {
  const value: unknown = Reflect.get(globalThis, "ipab");
  if (!isContext(value))
    throw new Error("Check App requires the IPAB context.");
  return value;
}
function validationBudget() {
  let remaining = 100_000;
  return {
    depth: 64,
    charge() {
      if (--remaining < 0)
        throw new Error("Check validation exceeds its work budget.");
    },
  };
}
export async function runCheck<Input>(
  check: CheckDefinition<Input>,
  options: {
    readonly context?: CheckAppContext;
    readonly input?: ReadableStream<Uint8Array>;
    readonly signal?: AbortSignal;
  } = {},
): Promise<CheckResult> {
  const context = options.context ?? appContext();
  const abort = new AbortController();
  const signal = options.signal ?? abort.signal;
  const interrupt = () => {
    process.exitCode = 130;
    abort.abort(new Error("Check interrupted."));
  };
  const terminate = () => {
    process.exitCode = 143;
    abort.abort(new Error("Check terminated."));
  };
  if (!options.signal) {
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", terminate);
  }
  try {
    signal.throwIfAborted();
    const read = async (
      root: string,
      path: string,
      contentType: ContentType = "application/json",
    ) =>
      readJson(
        await context.readFile(root, path, { signal }),
        signal,
        contentType,
      );
    const metadata = await read(context.appCid, "resources/check-model.json");
    if (
      typeof metadata !== "object" ||
      metadata === null ||
      !("cid" in metadata) ||
      typeof metadata.cid !== "string" ||
      Object.keys(metadata).length !== 1
    )
      throw new Error("Invalid embedded Check model identity.");
    const cid = CID.parse(metadata.cid);
    if (cid.code !== 0x70)
      throw new Error("Check model must be a UnixFS directory.");
    const manifest = parseBundleManifest(
      canonicalJson(
        await read(cid.toString(), ".bundle.yaml", "application/yaml"),
      ),
    );
    const actual = await encodeSchema(manifest);
    const expected = await encodeSchema(checkSpecDefinition);
    if (!actual.cid.equals(expected.cid))
      throw new Error("Unsupported Check model type.");
    const data = await read(
      cid.toString(),
      manifest.entry.path,
      manifest.entry.contentType,
    );
    validateSchemaValue(actual, data, validationBudget());
    const model = await resolveCheckInstructions(data, {
      signal,
      readFile: (path) => context.readFile(cid.toString(), path, { signal }),
    });
    if (
      !Buffer.from(canonicalJson(model)).equals(canonicalJson(modelOf(check)))
    )
      throw new Error(
        "Embedded Check model does not match the executable Check.",
      );
    const input = await readJson(
      options.input ?? Readable.toWeb(process.stdin),
      signal,
    );
    const result = await executeCheck(check, input, signal);
    const resultBytes = canonicalJson(result);
    if (resultBytes.byteLength > 8 * 1024 * 1024)
      throw new Error("Check result exceeds the Bundle entry limit of 8 MiB.");
    const schema = await encodeSchema(resultDefinition);
    validateSchemaValue(schema, result, validationBudget());
    await context.output.link("check", cid.toString(), { signal });
    await context.output.writeFile(
      ".bundle.yaml",
      jsonStream(canonicalJson(resultDefinition)),
      { signal },
    );
    await context.output.writeFile(
      resultDefinition.entry.path,
      jsonStream(resultBytes),
      { signal },
    );
    signal.throwIfAborted();
    return result;
  } finally {
    if (!options.signal) {
      process.removeListener("SIGINT", interrupt);
      process.removeListener("SIGTERM", terminate);
    }
  }
}
