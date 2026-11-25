import { createElement } from "react";
import { renderToString } from "react-dom/server";
import {
  canonicalJson,
  encodeSchema,
  parseBundleManifest,
  parseData,
  validateSchemaValue,
} from "@ipab/bundle/data";
import { runWebApp, type RunWebAppOptions } from "@ipab/web-app";
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
  contentCid: string;
  schema: unknown;
  viewer: BundleViewer;
}

export async function runBundleViewer(
  options: RunBundleViewerOptions,
): Promise<void> {
  const signal = options.signal ?? new AbortController().signal;
  const schema = await encodeSchema(options.schema);
  const read = async (cid: string, path: string, requestSignal: AbortSignal) =>
    readBytes(
      await options.context.readFile(cid, path, { signal: requestSignal }),
      requestSignal,
    );
  const manifest = parseBundleManifest(
    await read(options.contentCid, ".bundle.yaml", signal),
    1024 * 1024,
  );
  if ((await encodeSchema(manifest)).cid.toString() !== schema.cid.toString())
    throw new Error("Content Bundle type does not match this viewer");
  const data = parseData(
    await read(options.contentCid, manifest.entry.path, signal),
    manifest.entry.contentType,
  );
  let work = 0;
  validateSchemaValue(schema, data, {
    depth: 64,
    charge() {
      if (++work > 100_000)
        throw new Error("Viewer validation budget exceeded");
    },
  });
  const stateBytes = canonicalJson(data);
  if (stateBytes.byteLength > 1024 * 1024)
    throw new Error("Viewer state exceeds 1 MiB");
  const state = new TextDecoder()
    .decode(stateBytes)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026");
  await runWebApp({
    ...options,
    handlers: {},
    async renderFrontend({ signal: requestSignal }) {
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
      const html = renderToString(createElement(options.viewer, { data }), {
        identifierPrefix,
      });
      requestSignal.throwIfAborted();
      return page
        .replace(
          stateMarker,
          () =>
            `<script id="ipab-viewer-state" type="application/json">${state}</script>`,
        )
        .replace(viewerMarker, () => html);
    },
  });
}
