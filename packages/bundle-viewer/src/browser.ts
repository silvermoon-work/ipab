import { createElement } from "react";
import { hydrateRoot } from "react-dom/client";
import { connectWebApp } from "@ipab/web-app/browser";
import { identifierPrefix, type BundleViewer } from "./viewer.js";
import { liveView } from "./live.js";

export type { BundleViewer } from "./viewer.js";

export async function hydrateBundleViewer(
  viewer: BundleViewer,
  options: { signal?: AbortSignal } = {},
): Promise<{ close(this: void): void }> {
  const container = document.getElementById("ipab-viewer");
  const state = document.getElementById("ipab-viewer-state");
  if (!container || !state) throw new Error("Missing SSR viewer or state");
  const source = state.textContent;
  if (new TextEncoder().encode(source).byteLength > 6 * 1024 * 1024)
    throw new Error("Viewer state exceeds its encoded byte limit");
  const data: unknown = JSON.parse(source);
  const liveElement = document.getElementById("ipab-viewer-live");
  function revision(value: unknown): {
    revision: string;
    error: string;
    chunks: number;
  } {
    if (
      !value ||
      typeof value !== "object" ||
      !("revision" in value) ||
      typeof value.revision !== "string" ||
      !("error" in value) ||
      typeof value.error !== "string" ||
      !("chunks" in value) ||
      typeof value.chunks !== "number" ||
      !Number.isInteger(value.chunks) ||
      value.chunks < 0 ||
      value.chunks > 132
    )
      throw new Error("Invalid viewer revision");
    return {
      revision: value.revision,
      error: value.error,
      chunks: value.chunks,
    };
  }
  const initial: unknown = liveElement
    ? JSON.parse(liveElement.textContent)
    : null;
  const live = liveElement
    ? revision({ ...(initial as object), chunks: 0 })
    : undefined;
  const connection = await connectWebApp(options);
  if (options.signal?.aborted) {
    connection.close();
    options.signal.throwIfAborted();
  }
  let root: ReturnType<typeof hydrateRoot>;
  try {
    root = hydrateRoot(
      container,
      live
        ? liveView(viewer, {
            data: live.error ? undefined : data,
            error: live.error,
          })
        : createElement(viewer, { data }),
      {
        identifierPrefix,
        onRecoverableError(error) {
          console.error("Bundle Viewer hydration failed", error);
        },
      },
    );
  } catch (error) {
    connection.close();
    throw error;
  }
  let closed = false;
  const polling = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastData = live?.error ? undefined : data;
  let seen = live?.revision;
  async function update() {
    try {
      const next = revision(
        await connection.request(
          "viewerRevision",
          {},
          { signal: polling.signal },
        ),
      );
      if (next.revision !== seen) {
        if (next.error) {
          root.render(liveView(viewer, { data: lastData, error: next.error }));
        } else {
          let serialized = "";
          for (let index = 0; index < next.chunks; index++) {
            const chunk = await connection.request(
              "viewerChunk",
              { revision: next.revision, index },
              { signal: polling.signal },
            );
            if (typeof chunk !== "string" || chunk.length > 8000)
              throw new Error("Invalid viewer data chunk");
            serialized += chunk;
          }
          lastData = JSON.parse(serialized) as unknown;
          root.render(liveView(viewer, { data: lastData, error: "" }));
        }
        seen = next.revision;
      }
    } catch (error) {
      if (!closed) {
        console.error("Folder preview update failed", error);
        root.render(
          liveView(viewer, {
            data: lastData,
            error: "Folder preview update failed. Retrying...",
          }),
        );
        seen = undefined;
      }
    } finally {
      if (!closed)
        timer = setTimeout(() => {
          void update();
        }, 1000);
    }
  }
  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    polling.abort();
    window.removeEventListener("pagehide", close);
    options.signal?.removeEventListener("abort", close);
    try {
      root.unmount();
    } finally {
      connection.close();
    }
  };
  window.addEventListener("pagehide", close, { once: true });
  options.signal?.addEventListener("abort", close, { once: true });
  if (live)
    timer = setTimeout(() => {
      void update();
    }, 1000);
  return { close };
}
