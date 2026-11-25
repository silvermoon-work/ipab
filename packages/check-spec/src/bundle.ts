import type { CheckBundleSpec } from "./spec.js";
import { validateCheckBundleSpec } from "./node-spec.js";
export { validateCheckBundleSpec } from "./node-spec.js";

export interface MarkdownReference {
  path: string;
}
export type CheckContentSpec = Omit<CheckBundleSpec, "checkpoints"> & {
  checkpoints: (Omit<CheckBundleSpec["checkpoints"][number], "instructions"> & {
    instructions: string | MarkdownReference;
  })[];
};

function reference(value: unknown): string {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    !("path" in value) ||
    typeof value.path !== "string" ||
    value.path.length > 1024 ||
    !value.path.endsWith(".md") ||
    value.path
      .split("/")
      .some((part) => !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(part))
  )
    throw new Error(
      "Instructions require text or one safe Bundle-relative .md path",
    );
  return value.path;
}

export function splitCheckSpec(value: unknown): {
  spec: CheckContentSpec;
  files: ReadonlyMap<string, string>;
} {
  const result = validateCheckBundleSpec(value);
  if (!result.valid)
    throw new Error(`Invalid Check Spec: ${JSON.stringify(result.issues)}`);
  const files = new Map<string, string>();
  const checkpoints = result.spec.checkpoints.map((checkpoint) => {
    const path = `instructions/${checkpoint.id}.md`;
    reference({ path });
    files.set(path, checkpoint.instructions);
    return { ...checkpoint, instructions: { path } };
  });
  return { spec: { ...result.spec, checkpoints }, files };
}

export async function resolveCheckInstructions(
  value: unknown,
  context: {
    signal: AbortSignal;
    readFile(path: string): Promise<ReadableStream<Uint8Array>>;
  },
): Promise<CheckBundleSpec> {
  context.signal.throwIfAborted();
  if (
    !value ||
    typeof value !== "object" ||
    !("checkpoints" in value) ||
    !Array.isArray(value.checkpoints)
  )
    throw new Error("Expected Check Spec with ordered checkpoints");
  const paths = new Map<number, string>();
  const checkpoints = value.checkpoints.map((checkpoint: unknown, index) => {
    if (
      !checkpoint ||
      typeof checkpoint !== "object" ||
      !("instructions" in checkpoint)
    )
      return checkpoint;
    if (typeof checkpoint.instructions === "string") return checkpoint;
    const path = reference(checkpoint.instructions);
    paths.set(index, path);
    return { ...checkpoint, instructions: "Referenced Markdown" };
  });
  const parsed = validateCheckBundleSpec({ ...value, checkpoints });
  if (!parsed.valid)
    throw new Error(`Invalid Check Spec: ${JSON.stringify(parsed.issues)}`);
  if (paths.size > 256)
    throw new Error("Check instructions exceed 256 references");
  const loaded = new Map<string, string>();
  let total = 0;
  const resolved = [];
  for (const [index, checkpoint] of parsed.spec.checkpoints.entries()) {
    context.signal.throwIfAborted();
    const path = paths.get(index);
    let instructions = checkpoint.instructions;
    if (path) {
      let text = loaded.get(path);
      if (text === undefined) {
        const parts: Uint8Array[] = [];
        let size = 0;
        try {
          const stream = await context.readFile(path);
          await stream.pipeTo(
            new WritableStream<Uint8Array>({
              write(part) {
                size += part.byteLength;
                total += part.byteLength;
                if (size > 256 * 1024 || total > 1024 * 1024)
                  throw new Error(
                    "Check Markdown exceeds 256 KiB/file or 1 MiB total",
                  );
                parts.push(part);
              },
            }),
            { signal: context.signal },
          );
          const bytes = new Uint8Array(size);
          let offset = 0;
          for (const part of parts) {
            bytes.set(part, offset);
            offset += part.byteLength;
          }
          text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
          if (!text.trim())
            throw new Error("Instructions Markdown must not be blank");
          loaded.set(path, text);
        } catch (cause) {
          throw new Error(`Cannot load Check instructions ${path}`, { cause });
        }
      }
      instructions = text;
    }
    resolved.push({ ...checkpoint, instructions });
  }
  return { ...parsed.spec, checkpoints: resolved };
}
