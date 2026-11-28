import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { canonicalJson, safePath } from "@ipab/bundle/data";
import { encodeBundleCar, memoryTree, readBytes } from "@ipab/bundle-builder";
import { filesystemTree } from "@ipab/bundle-builder/node";
import { checkSpecDefinition, splitCheckSpec } from "@ipab/check-spec/bundle";
import { isCheckDefinition, modelOf } from "./check.js";

export async function buildCheckApp(options: {
  readonly root: string;
  readonly outputDir: string;
  readonly definition: string;
  readonly entry: string;
  readonly resources?: Readonly<Record<string, string>>;
}): Promise<{ modelCid: string }> {
  const root = resolve(options.root);
  const output = resolve(options.outputDir);
  const local = relative(root, output);
  if (
    !local ||
    isAbsolute(local) ||
    local === ".." ||
    local.startsWith(`..${sep}`)
  )
    throw new Error("Check build output must be inside the project.");
  safePath(options.definition);
  safePath(options.entry);
  await mkdir(output, { recursive: true });
  if ((await readdir(output)).length)
    throw new Error("Check build requires an empty output directory.");
  const module = join(output, "check-definition.mjs");
  try {
    await build({
      absWorkingDir: root,
      entryPoints: [options.definition],
      outfile: module,
      bundle: true,
      packages: "external",
      platform: "node",
      format: "esm",
      target: "node22.15",
    });
    const imported: unknown = await import(pathToFileURL(module).href);
    if (
      typeof imported !== "object" ||
      imported === null ||
      !("default" in imported) ||
      !isCheckDefinition(imported.default)
    )
      throw new Error(
        "Check definition entry must default-export defineCheck().",
      );
    const { spec, files: instructions } = splitCheckSpec(
      modelOf(imported.default),
    );
    const encode = (text: string) => new TextEncoder().encode(text);
    const files = new Map<string, Uint8Array>([
      [
        ".bundle.yaml",
        canonicalJson({
          title: "IPAB Check Spec",
          entry: "check.yaml",
          type: ".bundle-type.yaml",
        }),
      ],
      [".bundle-type.yaml", canonicalJson(checkSpecDefinition)],
      ["check.yaml", canonicalJson(spec)],
      ...[...instructions].map(([path, text]): [string, Uint8Array] => [
        path,
        encode(text),
      ]),
    ]);
    const tree = await filesystemTree(root);
    for (const [path, source] of Object.entries(options.resources ?? {})) {
      safePath(path);
      if (
        path.split("/").some((part) => part.startsWith(".")) ||
        files.has(path)
      )
        throw new Error(`Invalid or colliding Check resource: ${path}`);
      files.set(path, await readBytes(tree, source, 1024 * 1024));
    }
    const encoded = await encodeBundleCar(memoryTree(files));
    const modelCid = encoded.cid.toString();
    await encoded.close();
    for (const [path, bytes] of files) {
      const target = join(output, "check", ...path.split("/"));
      await mkdir(join(target, ".."), { recursive: true });
      await writeFile(target, bytes, { flag: "wx" });
    }
    await writeFile(
      join(output, "check-model.json"),
      canonicalJson({ cid: modelCid }),
      {
        flag: "wx",
      },
    );
    await build({
      absWorkingDir: root,
      entryPoints: [options.entry],
      outfile: join(output, "app.cjs"),
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node22.15",
    });
    return { modelCid };
  } finally {
    await rm(module, { force: true });
  }
}
