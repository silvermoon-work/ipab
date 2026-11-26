import { buildCheckApp } from "@ipab/check-sdk/build";

const outputDir = process.env.IPAB_BUILD_DIR;
if (!outputDir)
  throw new Error(
    "Run the project prepare-app script to provide IPAB_BUILD_DIR.",
  );
await buildCheckApp({
  root: process.cwd(),
  outputDir,
  definition: "src/check.ts",
  entry: "src/main.ts",
});
