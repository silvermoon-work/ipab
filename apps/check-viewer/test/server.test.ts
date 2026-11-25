import { afterEach, describe, expect, it, vi } from "vitest";
import { runBundleViewer } from "@ipab/bundle-viewer";

vi.mock("@ipab/bundle-viewer", () => ({ runBundleViewer: vi.fn() }));
const argv = process.argv;
const exitCode = process.exitCode;
afterEach(() => {
  process.argv = argv;
  process.exitCode = exitCode;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.mocked(runBundleViewer).mockReset();
});
describe("Check App startup", () => {
  it("passes the content CID and bounded Markdown loader to the standard template runtime", async () => {
    vi.resetModules();
    process.argv = [process.execPath, "app.cjs", "content-cid", "--no-open"];
    const context = { appCid: "app-cid", readFile: vi.fn() };
    vi.stubGlobal("ipab", context);
    vi.mocked(runBundleViewer).mockResolvedValue();
    await import("../src/server/main.js");
    const { resolveCheckInstructions } =
      await import("@ipab/check-spec/bundle");
    await vi.waitFor(() => {
      expect(runBundleViewer).toHaveBeenCalledTimes(1);
    });
    expect(runBundleViewer).toHaveBeenCalledWith(
      expect.objectContaining({
        context,
        contentCid: "content-cid",
        frontendRoot: "resources/web",
        prepareData: resolveCheckInstructions,
      }),
    );
  });
  it.each([{ args: [] }, { args: ["a", "b"] }])(
    "reports invalid App arguments %j",
    async ({ args }) => {
      vi.resetModules();
      const diagnostic = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});
      process.argv = [process.execPath, "app.cjs", ...args];
      await import("../src/server/main.js");
      await vi.waitFor(() => {
        expect(process.exitCode).toBe(1);
      });
      expect(diagnostic).toHaveBeenCalledWith(
        expect.objectContaining({ message: "Expected one Content Bundle CID" }),
      );
      expect(runBundleViewer).not.toHaveBeenCalled();
    },
  );
  it("reports runtime loading failures without claiming successful startup", async () => {
    vi.resetModules();
    const failure = new Error("Referenced Markdown missing");
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
    process.argv = [process.execPath, "app.cjs", "content"];
    vi.stubGlobal("ipab", { appCid: "app" });
    vi.mocked(runBundleViewer).mockRejectedValue(failure);
    await import("../src/server/main.js");
    await vi.waitFor(() => {
      expect(process.exitCode).toBe(1);
    });
    expect(diagnostic).toHaveBeenCalledWith(failure);
  });
});
