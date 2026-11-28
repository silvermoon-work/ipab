import { vi } from "vitest";

// Execute the shared real device journey against the owning CLI source too.
vi.mock("@ipab/cli", async () => import("../src/cli.js"));
await import(
  new URL("../../../packages/pointer-worker/test/mvp.test.ts", import.meta.url)
    .href
);
