import { createElement } from "react";
import { hydrateRoot } from "react-dom/client";
import { connectWebApp } from "@ipab/web-app/browser";
import { identifierPrefix, type BundleViewer } from "./viewer.js";

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
  const connection = await connectWebApp(options);
  if (options.signal?.aborted) {
    connection.close();
    options.signal.throwIfAborted();
  }
  let root: ReturnType<typeof hydrateRoot>;
  try {
    root = hydrateRoot(container, createElement(viewer, { data }), {
      identifierPrefix,
      onRecoverableError(error) {
        console.error("Bundle Viewer hydration failed", error);
      },
    });
  } catch (error) {
    connection.close();
    throw error;
  }
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
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
  return { close };
}
