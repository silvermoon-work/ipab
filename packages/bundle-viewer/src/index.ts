import { createElement } from "react";
import { renderToString } from "react-dom/server";
import {
  canonicalJson,
  encodeSchema,
  parseBundleManifest,
  parseBundleType,
  parseData,
  validateSchemaValue,
} from "@ipab/bundle/data";
import {
  defineWebAppMethod,
  runWebApp,
  type JsonValue,
  type RunWebAppOptions,
} from "@ipab/web-app";
import { createHash } from "node:crypto";
import { folderSnapshot } from "./folder.js";
import { liveView } from "./live.js";
import { resolveViewerSource } from "./source.js";
import {
  identifierPrefix,
  stateMarker,
  viewerMarker,
  type BundleViewer,
} from "./viewer.js";

export type { BundleViewer } from "./viewer.js";

async function readBytes(
  stream: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let length = 0;
  await stream.pipeTo(
    new WritableStream<Uint8Array>({
      write(part) {
        signal.throwIfAborted();
        length += part.byteLength;
        if (length > 1024 * 1024) throw new Error("Viewer input exceeds 1 MiB");
        parts.push(part);
      },
    }),
    { signal },
  );
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
}

export interface RunBundleViewerOptions extends Omit<
  RunWebAppOptions,
  "renderFrontend" | "handlers"
> {
  contentCid?: string;
  folder?: string;
  source?: string;
  schema: unknown;
  viewer: BundleViewer;
  prepareData?: (
    data: unknown,
    context: {
      signal: AbortSignal;
      readFile(path: string): Promise<ReadableStream<Uint8Array>>;
    },
  ) => Promise<unknown>;
}

export async function runBundleViewer(
  options: RunBundleViewerOptions,
): Promise<void> {
  if (options.source !== undefined) {
    if (options.contentCid !== undefined || options.folder !== undefined)
      throw new Error(
        "Viewer source cannot be combined with folder or contentCid",
      );
    const { source, ...rest } = options;
    return runBundleViewer({
      ...rest,
      ...(await resolveViewerSource(source, options.context)),
    });
  }
  const lifetime = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, lifetime.signal])
    : lifetime.signal;
  if (Boolean(options.contentCid) === Boolean(options.folder))
    throw new Error("Provide exactly one Content Bundle CID or local folder");
  const schema = await encodeSchema(options.schema);
  const read = async (cid: string, path: string, requestSignal: AbortSignal) =>
    readBytes(
      await options.context.readFile(cid, path, { signal: requestSignal }),
      requestSignal,
    );
  async function load() {
    const snapshot = options.folder
      ? await folderSnapshot(options.folder, signal)
      : undefined;
    const contentRead = snapshot
      ? (path: string) => snapshot.readFile(path)
      : (path: string) =>
          options.context.readFile(options.contentCid!, path, { signal });
    const manifest = parseBundleManifest(
      await readBytes(await contentRead(".bundle.yaml"), signal),
      1024 * 1024,
    );
    const type = parseBundleType(
      await readBytes(await contentRead(manifest.type), signal),
      1024 * 1024,
    );
    if ((await encodeSchema(type)).cid.toString() !== schema.cid.toString())
      throw new Error("Content Bundle type does not match this viewer");
    const data = parseData(
      await readBytes(await contentRead(manifest.entry), signal),
      type.contentType,
    );
    let work = 0;
    validateSchemaValue(schema, data, {
      depth: 64,
      charge() {
        if (++work > 100_000)
          throw new Error("Viewer validation budget exceeded");
      },
    });
    const prepared = options.prepareData
      ? await options.prepareData(data, {
          signal,
          readFile: contentRead,
        })
      : data;
    signal.throwIfAborted();
    const stateBytes = canonicalJson(prepared);
    if (stateBytes.byteLength > 1024 * 1024)
      throw new Error("Viewer state exceeds 1 MiB");
    await snapshot?.verify();
    return { prepared, serialized: new TextDecoder().decode(stateBytes) };
  }
  let current: {
    prepared: unknown;
    serialized: string;
    error: string;
    revision: string;
  } = { prepared: undefined, serialized: "", error: "", revision: "" };
  let initialized = false;
  let nextRead = 0;
  let reading: Promise<void> | undefined;
  async function refresh() {
    if (reading) return reading;
    if (initialized && !options.folder) return;
    if (initialized && Date.now() < nextRead) return;
    reading = (async () => {
      try {
        const loaded = await load();
        const revision = createHash("sha256")
          .update(loaded.serialized)
          .digest("hex");
        current = { ...loaded, revision, error: "" };
        initialized = true;
      } catch (error) {
        if (!options.folder || signal.aborted) throw error;
        const message = error instanceof Error ? error.message : String(error);
        const cause =
          error instanceof Error && error.cause instanceof Error
            ? `: ${error.cause.message}`
            : "";
        const failure = `Folder preview invalid: ${message}${cause}`.slice(
          0,
          1024,
        );
        const revision = createHash("sha256").update(failure).digest("hex");
        if (revision !== current.revision)
          (options.onDiagnostic ?? console.error)(failure);
        current = {
          prepared: undefined,
          serialized: "",
          error: failure,
          revision,
        };
        initialized = true;
      } finally {
        nextRead = Date.now() + 1000;
      }
    })();
    try {
      await reading;
    } finally {
      reading = undefined;
    }
  }
  await refresh();
  const plain = {
    parse(value: unknown): JsonValue {
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("Expected viewer request object");
      return value as { [key: string]: JsonValue };
    },
  };
  const handlers = options.folder
    ? {
        viewerRevision: defineWebAppMethod({
          request: plain,
          response: plain,
          async handle() {
            await refresh();
            return {
              revision: current.revision,
              error: current.error,
              chunks: Math.ceil(current.serialized.length / 8000),
            };
          },
        }),
        viewerChunk: defineWebAppMethod({
          request: plain,
          response: {
            parse(value: unknown): string {
              if (typeof value !== "string")
                throw new Error("Expected viewer chunk");
              return value;
            },
          },
          handle(input) {
            if (
              !input ||
              typeof input !== "object" ||
              Array.isArray(input) ||
              input.revision !== current.revision ||
              !Number.isSafeInteger(input.index) ||
              typeof input.index !== "number" ||
              input.index < 0 ||
              input.index >= Math.ceil(current.serialized.length / 8000)
            )
              throw new Error("Viewer revision changed; retry");
            return current.serialized.slice(
              input.index * 8000,
              (input.index + 1) * 8000,
            );
          },
        }),
      }
    : {};
  const escapeState = (source: string) =>
    source
      .replaceAll("<", "\\u003c")
      .replaceAll(">", "\\u003e")
      .replaceAll("&", "\\u0026");
  try {
    await runWebApp({
      ...options,
      handlers,
      async renderFrontend({ signal: requestSignal }) {
        await refresh();
        const selected = current;
        const page = new TextDecoder("utf-8", { fatal: true }).decode(
          await read(
            options.context.appCid,
            `${options.frontendRoot}/index.html`,
            requestSignal,
          ),
        );
        if (
          page.split(viewerMarker).length !== 2 ||
          page.split(stateMarker).length !== 2
        )
          throw new Error(
            "Frontend requires exactly one viewer and state marker",
          );
        const html = renderToString(
          options.folder
            ? liveView(options.viewer, {
                data: selected.prepared,
                error: selected.error,
              })
            : createElement(options.viewer, { data: selected.prepared }),
          {
            identifierPrefix,
          },
        );
        requestSignal.throwIfAborted();
        return page
          .replace(
            stateMarker,
            () =>
              `<script id="ipab-viewer-state" type="application/json">${escapeState(selected.serialized || "null")}</script>` +
              (options.folder
                ? `<script id="ipab-viewer-live" type="application/json">${escapeState(JSON.stringify({ revision: selected.revision, error: selected.error }))}</script>`
                : ""),
          )
          .replace(viewerMarker, () => html);
      },
    });
  } finally {
    lifetime.abort();
  }
}
