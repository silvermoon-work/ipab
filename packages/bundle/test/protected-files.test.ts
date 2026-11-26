import { vi } from "vitest";

vi.mock(
  "@ipab/bundle/pointer/protected-files",
  async () => import("../src/pointer/protected-files.js"),
);
vi.mock(
  "@ipab/bundle/pointer/node-runtime",
  async () => import("../src/pointer/node-runtime.js"),
);

await import(
  new URL("../../pointer-worker/test/protected-files.test.ts", import.meta.url)
    .href
);
