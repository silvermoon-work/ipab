import { afterEach, describe, expect, it, vi } from "vitest";
import { runBundleViewer } from "@ipab/bundle-viewer";

vi.mock("@ipab/bundle-viewer", () => ({ runBundleViewer: vi.fn() }));
vi.mock("../src/shared/viewer.js", () => ({ viewer: vi.fn() }));
vi.mock("@ipab/check-spec/bundle", () => ({
  resolveCheckInstructions: vi.fn(),
}));
const argv = process.argv;
const exitCode = process.exitCode;
afterEach(() => {
  process.argv = argv;
  process.exitCode = exitCode;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.mocked(runBundleViewer).mockReset();
});
describe("Check App startup", { tags: ["mock"] }, () => {
  it("accepts explicit folder watch mode without treating the path as a CID", async () => {
    vi.resetModules();
    process.argv = [
      process.execPath,
      "app.cjs",
      "--folder",
      ".\\check",
      "--no-open",
    ];
    vi.stubGlobal("ipab", { appCid: "app" });
    vi.mocked(runBundleViewer).mockResolvedValue();
    await import("../src/server/main.js");
    await vi.waitFor(() => {
      expect(runBundleViewer).toHaveBeenCalledTimes(1);
    });
    expect(runBundleViewer).toHaveBeenCalledWith(
      expect.objectContaining({ folder: ".\\check" }),
    );
    expect(vi.mocked(runBundleViewer).mock.calls[0]![0]).not.toHaveProperty(
      "contentCid",
    );
  });
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
        source: "content-cid",
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
        expect.objectContaining({
          message: "Expected one folder, pin or CID, or --folder PATH",
        }),
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
