// @vitest-environment jsdom
import { act, createElement, useId, useState } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectWebApp } from "@ipab/web-app/browser";
import { hydrateBundleViewer, type BundleViewer } from "../src/browser.js";
import { liveView } from "../src/live.js";

vi.mock("@ipab/web-app/browser", () => ({ connectWebApp: vi.fn() }));
const closeConnection = vi.fn();
let closeViewer: (() => void) | undefined;
beforeEach(() => {
  vi.mocked(connectWebApp).mockResolvedValue({
    close: closeConnection,
    request: vi.fn(),
    onEvent: vi.fn(),
  });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});
afterEach(async () => {
  await act(async () => {
    closeViewer?.();
    await Promise.resolve();
  });
  closeViewer = undefined;
  document.body.replaceChildren();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const viewer: BundleViewer = ({ data }) => {
  const id = useId();
  const [count, setCount] = useState(0);
  return createElement(
    "button",
    {
      id,
      onClick: () => {
        setCount(count + 1);
      },
    },
    `${String(data)}: ${String(count)}`,
  );
};
function markup(data: unknown = "SSR") {
  document.body.innerHTML = `<div id="ipab-viewer">${renderToString(createElement(viewer, { data }), { identifierPrefix: "ipab-viewer-" })}</div><script id="ipab-viewer-state" type="application/json">${JSON.stringify(data)}</script>`;
}
describe("isomorphic hydration", () => {
  it("updates in-place, preserves component state while hiding errors, and stops polling on close", async () => {
    vi.useFakeTimers();
    markup("Initial");
    document.body.insertAdjacentHTML(
      "beforeend",
      '<script id="ipab-viewer-live" type="application/json">{"revision":"one","error":""}</script>',
    );
    document.getElementById("ipab-viewer")!.innerHTML = renderToString(
      liveView(viewer, { data: "Initial", error: "" }),
      { identifierPrefix: "ipab-viewer-" },
    );
    const diagnostic = vi.spyOn(console, "error");
    let state = { revision: "two", error: "", chunks: 1 };
    const request = vi.fn((method: string) =>
      Promise.resolve(
        method === "viewerRevision" ? state : JSON.stringify("Updated"),
      ),
    );
    vi.mocked(connectWebApp).mockResolvedValue({
      close: closeConnection,
      request,
      onEvent: vi.fn(),
    });
    await act(async () => {
      closeViewer = (await hydrateBundleViewer(viewer)).close;
    });
    await act(async () => {
      document.querySelector("button")!.click();
      await Promise.resolve();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(document.querySelector("button")!.textContent).toBe("Updated: 1");
    state = { revision: "invalid", error: "Broken Markdown", chunks: 0 };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(document.querySelector('[role="alert"]')!.textContent).toBe(
      "Broken Markdown",
    );
    expect(
      document.querySelector("button")!.closest("[hidden]"),
    ).not.toBeNull();
    state = { revision: "three", error: "", chunks: 1 };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(document.querySelector("button")!.textContent).toBe("Updated: 1");
    expect(document.querySelector("button")!.closest("[hidden]")).toBeNull();
    await act(async () => {
      closeViewer?.();
      await Promise.resolve();
    });
    const calls = request.mock.calls.length;
    await vi.advanceTimersByTimeAsync(3000);
    expect(request.mock.calls.length).toBe(calls);
    expect(diagnostic).not.toHaveBeenCalled();
    diagnostic.mockRestore();
  });
  it("shows failed update transport and retries rather than displaying stale success", async () => {
    vi.useFakeTimers();
    markup();
    document.getElementById("ipab-viewer")!.innerHTML =
      '<div style="height:100%"><p role="alert">Invalid edit</p><div hidden="" style="height:100%"></div></div>';
    document.body.insertAdjacentHTML(
      "beforeend",
      '<script id="ipab-viewer-live" type="application/json">{"revision":"invalid","error":"Invalid edit"}</script>',
    );
    const request = vi.fn().mockRejectedValue(new Error("Disconnected"));
    vi.mocked(connectWebApp).mockResolvedValue({
      close: closeConnection,
      request,
      onEvent: vi.fn(),
    });
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
    await act(async () => {
      closeViewer = (await hydrateBundleViewer(viewer)).close;
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(document.querySelector('[role="alert"]')!.textContent).toContain(
      "Retrying",
    );
    expect(diagnostic).toHaveBeenCalledWith(
      "Folder preview update failed",
      expect.any(Error),
    );
    diagnostic.mockRestore();
  });
  it("reuses SSR nodes and IDs, then becomes interactive and cleans up once", async () => {
    markup();
    const node = document.querySelector("button")!;
    const id = node.id;
    const diagnostic = vi.spyOn(console, "error");
    await act(async () => {
      closeViewer = (await hydrateBundleViewer(viewer)).close;
    });
    expect(document.querySelector("button")).toBe(node);
    expect(node.id).toBe(id);
    await act(async () => {
      node.click();
      await Promise.resolve();
    });
    expect(node.textContent).toBe("SSR: 1");
    expect(diagnostic).not.toHaveBeenCalled();
    await act(async () => {
      window.dispatchEvent(new Event("pagehide"));
      closeViewer?.();
      await Promise.resolve();
    });
    expect(document.querySelector("button")).toBeNull();
    expect(closeConnection).toHaveBeenCalledTimes(1);
    diagnostic.mockRestore();
  });
  it("unmounts and disconnects on abort", async () => {
    markup();
    const controller = new AbortController();
    await act(async () => {
      closeViewer = (
        await hydrateBundleViewer(viewer, { signal: controller.signal })
      ).close;
    });
    await act(async () => {
      controller.abort();
      await Promise.resolve();
    });
    expect(document.querySelector("button")).toBeNull();
    expect(closeConnection).toHaveBeenCalledTimes(1);
  });
  it("closes if cancellation wins the connection race", async () => {
    markup();
    const controller = new AbortController();
    vi.mocked(connectWebApp).mockImplementation(() => {
      controller.abort();
      return Promise.resolve({
        close: closeConnection,
        request: vi.fn(),
        onEvent: vi.fn(),
      });
    });
    await expect(
      hydrateBundleViewer(viewer, { signal: controller.signal }),
    ).rejects.toThrow("aborted");
    expect(closeConnection).toHaveBeenCalledTimes(1);
  });
  it.each(["missing", "invalid", "oversize"])(
    "rejects %s bootstrap data without connecting",
    async (failure) => {
      if (failure !== "missing") {
        markup();
        document.getElementById("ipab-viewer-state")!.textContent =
          failure === "invalid" ? "{" : "x".repeat(6 * 1024 * 1024 + 1);
      }
      await expect(hydrateBundleViewer(viewer)).rejects.toThrow();
      expect(connectWebApp).not.toHaveBeenCalled();
    },
  );
  it("preserves SSR content and reports a failed connection", async () => {
    markup();
    vi.mocked(connectWebApp).mockRejectedValue(new Error("Connection failed"));
    await expect(hydrateBundleViewer(viewer)).rejects.toThrow(
      "Connection failed",
    );
    expect(document.querySelector("button")!.textContent).toBe("SSR: 0");
  });
  it("reports hydration mismatch instead of claiming SSR succeeded", async () => {
    markup("server");
    document.getElementById("ipab-viewer-state")!.textContent = '"client"';
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
    await act(async () => {
      closeViewer = (await hydrateBundleViewer(viewer)).close;
    });
    expect(diagnostic).toHaveBeenCalledWith(
      "Bundle Viewer hydration failed",
      expect.any(Error),
    );
    diagnostic.mockRestore();
  });
});
