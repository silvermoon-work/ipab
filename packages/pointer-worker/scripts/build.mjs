import { build } from "esbuild";
import { unstable_readConfig } from "wrangler";
import { encodeBundleCar } from "@ipab/bundle-builder";
import { filesystemTree } from "@ipab/bundle-builder/node";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rename,
  rm,
} from "node:fs/promises";
import { join } from "node:path";

await mkdir("dist", { recursive: true });
const stage = await mkdtemp(join("dist", ".worker-build-"));
try {
  const config = unstable_readConfig({ config: "wrangler.toml" });
  if (!config.main) throw new Error("Worker configuration requires main.");
  await build({
    entryPoints: [config.main],
    outfile: join(stage, "worker.mjs"),
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    external: ["cloudflare:*"],
  });
  await writeFile(
    join(stage, ".bundle.yaml"),
    JSON.stringify({
      title: "IPAB Pointer Worker",
      entry: "worker.json",
      type: ".bundle-type.yaml",
    }),
  );
  await writeFile(
    join(stage, ".bundle-type.yaml"),
    await readFile("bundle-definition.json"),
  );
  await writeFile(
    join(stage, "worker.json"),
    JSON.stringify({
      version: 1,
      files: ["worker.mjs"],
      config: {
        main: "worker.mjs",
        compatibility_date: config.compatibility_date,
        compatibility_flags: config.compatibility_flags,
        durable_objects: config.durable_objects,
        migrations: config.migrations,
        observability: config.observability,
      },
    }),
  );
  const car = await encodeBundleCar(await filesystemTree(stage));
  try {
    await writeFile(join(stage, "worker.car"), car.stream);
    await rename(join(stage, "worker.car"), join("dist", "worker.car"));
    await writeFile("dist/worker.cid", `${car.cid}\n`);
    console.log(`Pointer Worker Bundle: ${car.cid}`);
  } finally {
    await car.close();
  }
} finally {
  await rm(stage, { recursive: true, force: true });
}
