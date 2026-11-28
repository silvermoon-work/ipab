import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdir, readFile, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  encodeSchema,
  parseBundleManifest,
  parseBundleType,
} from "@ipab/bundle";
import { encodeBundleCar, memoryTree } from "@ipab/bundle-builder";
import {
  captureSource,
  sourceFingerprint,
  sourceSchema,
} from "../src/source-bundle.js";
import { appDescription, appSchema } from "../src/app-definition.js";
import { fixture } from "./helpers.js";

let work: Awaited<ReturnType<typeof fixture>>;
let project: string;
beforeEach(async () => {
  work = await fixture();
  project = join(work.root, "project");
  await mkdir(project);
  await writeFile(join(project, "package.json"), '{"name":"example"}\n');
  await writeFile(
    join(project, ".bundle.yaml"),
    JSON.stringify({
      title: "Source",
      entry: "package.json",
      type: ".bundle-type.yaml",
    }),
  );
  await writeFile(
    join(project, ".bundle-type.yaml"),
    JSON.stringify(sourceSchema),
  );
});
afterEach(async () => {
  await work.cleanup();
});

it(
  "follows nested project gitignores, negation and pruning without Git or machine-global rules",
  { tags: ["unit"] },
  async () => {
    await mkdir(join(project, "src", "excluded"), { recursive: true });
    await mkdir(join(project, "node_modules"));
    await mkdir(join(project, ".git"));
    await mkdir(join(project, ".ipab", "identity"), { recursive: true });
    await mkdir(join(project, "dist"));
    await mkdir(join(project, ".ipab-app-old"));
    await mkdir(join(project, "artifacts"));
    const files = {
      ".gitignore": "*.log\nsrc/*.txt\nsrc/excluded/\n!src/excluded/keep.txt\n",
      "src/.gitignore": "!keep.txt\nnested.log\n",
      "src/keep.txt": "selected by nested negation",
      "src/skip.txt": "ignored",
      "src/nested.log": "ignored",
      "src/main.ts": "untracked source",
      "src/excluded/keep.txt": "cannot reinclude a file in a pruned directory",
      "node_modules/tool.js": "dependency",
      ".git/config": "metadata",
      ".ipab/pointers.json": '{"apiKey":"credential-placeholder"}',
      ".ipab/identity/key.json": '{"privateKey":"credential-placeholder"}',
      "dist/old.car": "old output",
      ".ipab-app-old/program.cjs": "stale staging",
      "artifacts/old.car": "configured output",
      "selected.car": "custom output",
      ".bundle-ignore": "ignored control file",
    };
    for (const [path, content] of Object.entries(files))
      await writeFile(join(project, ...path.split("/")), content);
    const outputs = [
      join(project, "selected.car"),
      join(project, "artifacts"),
      join(work.root, "outside.car"),
    ];
    const first = await captureSource(project, outputs);
    expect([...first.keys()].sort()).toEqual([
      ".bundle-type.yaml",
      ".bundle.yaml",
      ".gitignore",
      "package.json",
      "src/.gitignore",
      "src/keep.txt",
      "src/main.ts",
    ]);
    expect(new TextDecoder().decode(first.get("src/main.ts"))).toBe(
      "untracked source",
    );
    const fingerprint = sourceFingerprint(first);
    await writeFile(join(project, "src", "skip.txt"), "ignored changes");
    expect(sourceFingerprint(await captureSource(project, outputs))).toBe(
      fingerprint,
    );
    await writeFile(join(project, "src", "main.ts"), "changed source");
    expect(sourceFingerprint(await captureSource(project, outputs))).not.toBe(
      fingerprint,
    );
    const encoded = await encodeBundleCar(memoryTree(first));
    await encoded.close();
  },
);

it(
  "preserves explicit definitions and fails on excluded required files, symlinks, invalid ignores or cancellation",
  { tags: ["unit"] },
  async () => {
    const definition =
      '{"title":"Custom","entry":"package.json","type":".bundle-type.yaml"}\n';
    await writeFile(join(project, ".bundle.yaml"), definition);
    await writeFile(
      join(project, ".bundle-type.yaml"),
      '{"contentType":"application/json","schema":{"type":"object"}}',
    );
    expect(
      new TextDecoder().decode(
        (await captureSource(project, [])).get(".bundle.yaml"),
      ),
    ).toBe(definition);
    for (const path of [".bundle.yaml", ".bundle-type.yaml", "package.json"]) {
      await writeFile(join(project, ".gitignore"), `${path}\n`);
      await expect(captureSource(project, [])).rejects.toThrow("excluded");
    }
    await writeFile(join(project, ".gitignore"), new Uint8Array([0xff]));
    await expect(captureSource(project, [])).rejects.toThrow();
    await unlink(join(project, ".gitignore"));
    const linked = join(project, "linked");
    await symlink(
      project,
      linked,
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(captureSource(project, [])).rejects.toThrow("regular");
    await unlink(linked);
    await expect(
      captureSource(project, [], {
        signal: AbortSignal.abort(new Error("cancelled")),
      }),
    ).rejects.toThrow("cancelled");
  },
);

it(
  "synthesizes split source controls only when the manifest is absent, without modifying the project",
  { tags: ["unit"] },
  async () => {
    await unlink(join(project, ".bundle-type.yaml"));
    await expect(captureSource(project, [])).rejects.toThrow("missing");
    await unlink(join(project, ".bundle.yaml"));
    const files = await captureSource(project, []);
    expect(parseBundleManifest(files.get(".bundle.yaml")!)).toEqual({
      title: "IPAB App Source",
      description: "",
      entry: "package.json",
      type: ".bundle-type.yaml",
    });
    expect(parseBundleType(files.get(".bundle-type.yaml")!)).toEqual(
      sourceSchema,
    );
    const encoded = await encodeBundleCar(memoryTree(files));
    expect(encoded.schema.type).toEqual(sourceSchema);
    await encoded.close();
    for (const path of [".bundle.yaml", ".bundle-type.yaml"])
      await expect(readFile(join(project, path))).rejects.toMatchObject({
        code: "ENOENT",
      });
    await writeFile(join(project, ".gitignore"), ".bundle-type.yaml\n");
    await expect(captureSource(project, [])).rejects.toThrow("excluded");
    await unlink(join(project, ".gitignore"));
    await writeFile(
      join(project, ".bundle.yaml"),
      "name: Old profile\nentry: {path: package.json, contentType: application/json}\n",
    );
    await expect(captureSource(project, [])).rejects.toThrow(
      "Invalid .bundle.yaml",
    );
  },
);

it(
  "validates weak source CID metadata locally without fetching content",
  { tags: ["unit"] },
  async () => {
    const metadata = {
      name: "Untitled App",
      version: "0.0.0",
      description: "",
      entry: "resources/app.cjs",
    };
    const cid = "bafybeigdyrzt5sfp7udm7hu76uysn5h5m5mcwq7vbgxww6nypb3q6h3csi";
    expect(appDescription({ ...metadata, source: { cid } }).source).toEqual({
      cid,
    });
    const schemaCid = (await encodeSchema(appSchema)).cid.toString();
    for (const source of [
      null,
      {},
      { cid: 1 },
      { cid, car: "source.car" },
      { cid: "not-a-cid" },
      { cid: schemaCid },
    ])
      expect(() => appDescription({ ...metadata, source })).toThrow();
  },
);
