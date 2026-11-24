export class HostError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
    readonly code = "OPERATION_FAILED",
    readonly phase = "state",
  ) {
    super(message);
    this.name = "HostError";
  }
}

export function syntax(message: string): never {
  throw new HostError(
    `${message} Run ipab --help.`,
    2,
    "INVALID_ARGUMENT",
    "arguments",
  );
}

export function message(error: unknown): string {
  let text =
    error instanceof Error ? error.message : "Unknown operation failure.";
  if (error instanceof ContentBundleError)
    text += `${error.path ? ` [${error.path}]` : ""}${error.pointer ? ` at ${error.pointer}` : ""}`;
  return text.replace(/https?:\/\/[^\s"']+/g, (value) => {
    try {
      const url = new URL(value);
      url.username = "";
      url.password = "";
      url.search = "";
      url.hash = "";
      return url.toString();
    } catch {
      return "[redacted URL]";
    }
  });
}

export function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new HostError(`Invalid ${label}.`);
  return value as Record<string, unknown>;
}
import { ContentBundleError } from "@ipab/bundle";
