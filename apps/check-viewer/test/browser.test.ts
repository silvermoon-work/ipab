// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { hydrateBundleViewer } from "@ipab/bundle-viewer/browser";

vi.mock("@ipab/bundle-viewer/browser", () => ({
  hydrateBundleViewer: vi.fn(),
}));
afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.mocked(hydrateBundleViewer).mockReset();
});
describe("Check browser entry", () => {
  it("hydrates the shared Check view without replacing SSR markup", async () => {
    vi.resetModules();
    document.body.innerHTML = "<main>Existing SSR</main>";
    vi.mocked(hydrateBundleViewer).mockResolvedValue({ close: vi.fn() });
    await import("../src/web/main.js");
    expect(hydrateBundleViewer).toHaveBeenCalledTimes(1);
    expect(document.querySelector("main")!.textContent).toBe("Existing SSR");
  });
  it.each([new Error("Hydration unavailable"), "failed"])(
    "surfaces bootstrap failure %s",
    async (failure) => {
      vi.resetModules();
      const diagnostic = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});
      vi.mocked(hydrateBundleViewer).mockRejectedValue(failure);
      await import("../src/web/main.js");
      await vi.waitFor(() => {
        expect(document.querySelector('[role="alert"]')).not.toBeNull();
      });
      expect(diagnostic).toHaveBeenCalledWith(failure);
      expect(document.body.textContent).toBe(
        failure instanceof Error ? failure.message : "Viewer startup failed",
      );
    },
  );
});
