import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/main.js";

vi.mock("../src/main.js", () => ({ main: vi.fn(() => Promise.resolve()) }));
const originalExitCode = process.exitCode;
afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.clearAllMocks();
  process.exitCode = originalExitCode;
});
describe("App entries", { tags: ["mock"] }, () => {
  it("starts the correct consumer mode", async () => {
    await import("../src/local.js");
    await import("../src/deploy.js");
    expect(main).toHaveBeenCalledWith("local");
    expect(main).toHaveBeenCalledWith("deploy");
  });
  it("surfaces bootstrap errors while retaining a subprocess exit code", async () => {
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(main).mockRejectedValue(new Error("setup failed"));
    process.exitCode = undefined;
    await import("../src/local.js");
    await Promise.resolve();
    expect(process.exitCode).toBe(1);
    process.exitCode = 7;
    await import("../src/deploy.js");
    await Promise.resolve();
    expect(process.exitCode).toBe(7);
    expect(diagnostic).toHaveBeenCalled();
  });
});
