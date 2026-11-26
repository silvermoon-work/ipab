import { spawnSync } from "node:child_process";
import { Ajv2020 } from "ajv/dist/2020.js";
import standalone from "ajv/dist/standalone/index.js";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
const compilation = spawnSync(
  process.execPath,
  [
    fileURLToPath(import.meta.resolve("typescript/bin/tsc")),
    "--project",
    "tsconfig.build.json",
  ],
  { stdio: "inherit", shell: false },
);
if (compilation.error) throw compilation.error;
if (compilation.status !== 0)
  throw new Error("Check Spec TypeScript build failed");
const { checkBundleSpecSchema } = await import("../dist/shape-schema.js");
const ajv = new Ajv2020({
  allErrors: true,
  strict: false,
  code: { source: true, esm: true },
});
const validate = ajv.compile(checkBundleSpecSchema);
await build({
  stdin: {
    contents: standalone(ajv, validate),
    resolveDir: import.meta.dirname,
  },
  outfile: fileURLToPath(
    new URL("../dist/shape-validator.js", import.meta.url),
  ),
  platform: "neutral",
  format: "esm",
  bundle: true,
});
