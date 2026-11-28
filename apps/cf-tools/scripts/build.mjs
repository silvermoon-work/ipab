import { build } from "esbuild";
import { encodeBundleCar, encodeSchemaCar } from "@ipab/bundle-builder";
import { filesystemTree } from "@ipab/bundle-builder/node";
import { appSchema } from "../../cli/dist/app-definition.js";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rename,
  rm,
} from "node:fs/promises";
import { join } from "node:path";

const definition = JSON.parse(
  await readFile(
    "../../packages/pointer-worker/bundle-definition.json",
    "utf8",
  ),
);
await mkdir("dist", { recursive: true });
for (const mode of ["local", "deploy"]) {
  const stage = await mkdtemp(join("dist", `.cf-${mode}-`));
  try {
    await mkdir(join(stage, "resources", "payload"), { recursive: true });
    await build({
      entryPoints: [`src/${mode}.ts`],
      outfile: join(stage, "resources", "app.cjs"),
      platform: "node",
      format: "cjs",
      target: "node22.15",
      bundle: true,
    });
    for (const file of [
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
    ]) {
      await writeFile(
        join(stage, "resources", "payload", file),
        await readFile(join("payload", file)),
      );
    }
    const supported = await encodeSchemaCar(definition);
    try {
      await writeFile(
        join(stage, "resources", "supported-schemas.car"),
        supported.stream,
      );
    } finally {
      await supported.close();
    }
    await writeFile(
      join(stage, ".bundle.yaml"),
      JSON.stringify({
        title: `cf-${mode}`,
        entry: "app.json",
        type: ".bundle-type.yaml",
      }),
    );
    await writeFile(
      join(stage, ".bundle-type.yaml"),
      JSON.stringify(appSchema),
    );
    await writeFile(
      join(stage, "app.json"),
      JSON.stringify({
        name: `cf-${mode}`,
        version: "0.0.0",
        description: `Self-installing Cloudflare Worker ${mode} App.`,
        entry: "resources/app.cjs",
        supportedSchemas: "resources/supported-schemas.car",
      }),
    );
    const car = await encodeBundleCar(await filesystemTree(stage));
    try {
      await writeFile(join(stage, "app.car"), car.stream);
      await rename(join(stage, "app.car"), join("dist", `cf-${mode}.car`));
      await writeFile(join("dist", `cf-${mode}.cid`), `${car.cid}\n`);
      console.log(`cf-${mode} App Bundle: ${car.cid}`);
    } finally {
      await car.close();
    }
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
