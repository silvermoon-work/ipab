import { build as buildNode } from "esbuild";
import { build as buildWeb } from "vite";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const output = process.env.IPAB_BUILD_DIR;
if (!output) throw new Error("Run ipab build to provide IPAB_BUILD_DIR.");
const require = createRequire(import.meta.url);
await buildNode({
  entryPoints: ["src/server/main.ts"],
  outfile: join(output, "app.cjs"),
  platform: "node",
  format: "cjs",
  target: "node22.15",
  bundle: true,
  alias: {
    react: dirname(require.resolve("react/package.json")),
    "react-dom": dirname(require.resolve("react-dom/package.json")),
  },
});
await buildWeb({
  configFile: "vite.config.mjs",
  build: { outDir: join(output, "web"), emptyOutDir: false },
});
