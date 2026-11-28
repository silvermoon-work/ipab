import { vi } from "vitest";

// Run the existing protocol/service regressions against the public source entrypoints,
// so moving portable code does not lose its owning package's coverage enforcement.
vi.mock(
  "@ipab/bundle/pointer/protocol",
  async () => import("../src/pointer/protocol.js"),
);
vi.mock(
  "@ipab/bundle/pointer/crypto",
  async () => import("../src/pointer/crypto.js"),
);
vi.mock(
  "@ipab/bundle/pointer/scope",
  async () => import("../src/pointer/scope.js"),
);
vi.mock(
  "@ipab/bundle/pointer/protected-files",
  async () => import("../src/pointer/protected-files.js"),
);
vi.mock(
  "@ipab/bundle/pointer/node-runtime",
  async () => import("../src/pointer/node-runtime.js"),
);

await import(
  new URL("../../pointer-worker/test/core.test.ts", import.meta.url).href
);
await import(
  new URL("../../pointer-worker/test/client.test.ts", import.meta.url).href
);
await import(
  new URL("../../pointer-worker/test/service.test.ts", import.meta.url).href
);
await import(
  new URL("../../pointer-worker/test/lifecycle.test.ts", import.meta.url).href
);
