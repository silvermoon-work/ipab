import { build as buildNode } from "esbuild";
import { build as buildWeb } from "vite";
import { join } from "node:path";

const output = process.env.IPAB_BUILD_DIR;
if (!output) throw new Error("Run ipab build to provide IPAB_BUILD_DIR.");

await buildNode({
  entryPoints: ["src/server/main.ts"],
  outfile: join(output, "app.cjs"),
  platform: "node",
  format: "cjs",
  target: "node22.15",
  bundle: true,
});
await buildWeb({
  configFile: "vite.config.mjs",
  build: { outDir: join(output, "web"), emptyOutDir: false },
});
