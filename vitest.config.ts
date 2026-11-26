import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    tags: [
      {
        name: "unit",
        description: "Isolated unit tests without real application execution",
      },
      {
        name: "mock",
        description:
          "Tests with mocked external execution and service boundaries",
      },
      {
        name: "release-e2e",
        description:
          "Real builds, application execution and service/storage integration validated before release",
      },
    ],
    coverage: {
      autoAttachSubprocess: true,
      include: ["src/**/*.{ts,tsx}"],
      provider: "v8",
      reporter: ["text", "json", "html"],
      thresholds: {
        branches: 90,
        functions: 90,
        lines: 90,
        statements: 90,
      },
    },
    include: ["test/**/*.test.{ts,tsx}"],
  },
});
