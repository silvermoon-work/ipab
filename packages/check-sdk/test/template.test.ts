import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { CID } from "multiformats/cid";
import { openBundle, parseData } from "@ipab/bundle";
import { buildCheckApp } from "../src/build.js";
import { initApp, buildApp } from "../../../apps/cli/dist/app-authoring.js";
import { importBundle } from "../../../apps/cli/dist/authoring.js";
import { State } from "../../../apps/cli/dist/state.js";
import { IpfsStore } from "../../ipfs-store/dist/index.js";

const require = createRequire(import.meta.url);
async function project() {
  const work = await mkdtemp(join(tmpdir(), "ipab-check-sdk-"));
  const root = join(work, "project");
  await initApp("greeting-check", root, {
    template: fileURLToPath(
      new URL("../../../templates/check", import.meta.url),
    ),
    parameters: [`checkSdkDependency=link:${resolve(".")}`],
  });
  await mkdir(join(root, "node_modules", "@ipab"), { recursive: true });
  await mkdir(join(root, "node_modules", "@types"), { recursive: true });
  const link = async (source: string, target: string) =>
    symlink(source, target, process.platform === "win32" ? "junction" : "dir");
  await link(resolve("."), join(root, "node_modules", "@ipab", "check-sdk"));
  for (const name of ["typescript", "@types/node"])
    await link(
      dirname(require.resolve(`${name}/package.json`)),
      join(root, "node_modules", name),
    );
  return { work, root };
}

it(
  "builds and runs the generated Check App with STDIN and reuses the original model DAG in both outcomes",
  { tags: ["release-e2e"], timeout: 120_000 },
  async () => {
    const { work, root } = await project();
    const stateDir = join(work, "state");
    const store = new IpfsStore({
      backend: "local",
      dataDir: join(work, "blocks"),
    });
    const config = join(work, "store.json");
    await writeFile(config, JSON.stringify(store.configuration));
    const env = { ...process.env, TASK_CONTENT_CONFIG: config };
    vi.stubEnv("TASK_CONTENT_CONFIG", config);
    const cli = fileURLToPath(
      new URL("../../../apps/cli/dist/main.js", import.meta.url),
    );
    try {
      await mkdir(join(root, "references"));
      await writeFile(
        join(root, "references", "shared.md"),
        "# Shared\n\nOriginal reference bytes.\n",
      );
      const prebuild = join(root, "scripts", "ipab-prebuild.mjs");
      await writeFile(
        prebuild,
        (await readFile(prebuild, "utf8")).replace(
          'entry: "src/main.ts",',
          'entry: "src/main.ts",\n  resources: { "references/shared.md": "references/shared.md" },',
        ),
      );
      const definition = join(root, "src", "check.ts");
      await writeFile(
        definition,
        (await readFile(definition, "utf8")).replace(
          "Compare text with hello.",
          "Read [shared instructions](../references/shared.md). Compare text with hello.",
        ),
      );
      const generated = await buildCheckApp({
        root,
        outputDir: join(root, ".ipab-app-sdk-model"),
        definition: "src/check.ts",
        entry: "src/main.ts",
        resources: { "references/shared.md": "references/shared.md" },
      });
      const built = await buildApp(root);
      await importBundle(built.output, () => Promise.resolve(store));
      const resolver = {
        resolveCid: (cid: CID) => store.block.get(cid.toString()),
      };
      const app = await openBundle(CID.parse(built.cid), resolver);
      const metadata = parseData(
        await readFileFrom(app, "resources/check-model.json"),
        "application/json",
      );
      if (
        !metadata ||
        typeof metadata !== "object" ||
        !("cid" in metadata) ||
        typeof metadata.cid !== "string"
      )
        throw new Error("Missing model CID.");
      const modelCid = metadata.cid;
      expect(modelCid).toBe(generated.modelCid);
      expect(
        (
          await store.resolveContent(CID.parse(built.cid), "resources/check")
        ).toString(),
      ).toBe(modelCid);
      const model = await openBundle(CID.parse(modelCid), resolver);
      expect(
        Buffer.from(
          await readFileFrom(model, "references/shared.md"),
        ).toString(),
      ).toContain("Original reference bytes");

      for (const [text, pass] of [
        ["hello", true],
        ["goodbye", false],
      ] as const) {
        const response = await command(
          cli,
          stateDir,
          built.cid,
          JSON.stringify({ text }),
          env,
        );
        expect(response.code, response.err).toBe(0);
        const outputCid = /Output: (\S+)/.exec(response.err)?.[1];
        expect(outputCid, response.err).toBeDefined();
        const result = await openBundle(CID.parse(outputCid!), resolver);
        const data = parseData(
          await readFileFrom(result, "result.json"),
          "application/json",
        );
        expect(data).toEqual(
          pass
            ? { check: "check", checkpoint: "text", pass: true }
            : {
                check: "check",
                checkpoint: "text",
                pass: false,
                problems: [
                  {
                    code: "text-matches-standard",
                    context: { expected: "hello", actual: "goodbye" },
                  },
                ],
              },
        );
        expect(
          (
            await store.resolveContent(CID.parse(outputCid!), "check")
          ).toString(),
        ).toBe(modelCid);
        expect(
          await readFileFrom(result, "check/references/shared.md"),
        ).toEqual(await readFileFrom(model, "references/shared.md"));
        expect(
          await readFileFrom(result, "check/instructions/text.md"),
        ).toEqual(await readFileFrom(model, "instructions/text.md"));
        const state = new State(stateDir);
        try {
          const record = state
            .runs()
            .find((run) => run.outputCid === outputCid);
          expect(record?.status).toBe("succeeded");
          expect(record?.retention.owned).toBe(true);
        } finally {
          state.close();
        }
      }
      for (const input of ['{"text":1}', '{"text":"hello","text":"goodbye"}']) {
        const response = await command(cli, stateDir, built.cid, input, env);
        expect(response.code).toBe(1);
        expect(response.err).not.toContain("Output:");
        const state = new State(stateDir);
        try {
          expect(
            state
              .runs()
              .filter((run) => run.status === "failed")
              .every((run) => run.outputCid === null),
          ).toBe(true);
        } finally {
          state.close();
        }
      }
      const original = await readFile(built.output);
      const source = await readFile(prebuild, "utf8");
      for (const directory of [false, true]) {
        const extra = directory
          ? 'await mkdir(join(outputDir, "check", ".private"));'
          : 'await writeFile(join(outputDir, "check", ".secret"), "hidden");';
        await writeFile(
          prebuild,
          `${source}\nconst {mkdir, writeFile} = await import("node:fs/promises");\nconst {join} = await import("node:path");\n${extra}`,
        );
        await expect(buildApp(root, { replace: true })).rejects.toThrow(
          "Hidden prebuilt resources",
        );
        expect(await readFile(built.output)).toEqual(original);
      }
      await store.gc();
      expect(await readFileFrom(model, "references/shared.md")).toEqual(
        Buffer.from("# Shared\n\nOriginal reference bytes.\n"),
      );
    } finally {
      vi.unstubAllEnvs();
      await store.close();
      await rm(work, { recursive: true, force: true });
    }
  },
);

async function readFileFrom(
  bundle: Awaited<ReturnType<typeof openBundle>>,
  path: string,
) {
  const parts: Uint8Array[] = [];
  for await (const bytes of await bundle.readFile(path)) parts.push(bytes);
  return Buffer.concat(parts);
}
async function command(
  cli: string,
  state: string,
  app: string,
  input: string,
  env: NodeJS.ProcessEnv,
): Promise<{ code: number | null; err: string }> {
  const child = spawn(
    process.execPath,
    [cli, "--state-dir", state, "exec", app],
    {
      env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    },
  );
  let err = "";
  child.stdout.resume();
  child.stderr.on("data", (bytes: Buffer) => {
    err += bytes.toString();
  });
  child.stdin.end(input);
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      resolve({ code, err });
    });
  });
}

it(
  "rejects invalid model exports, colliding resources and nonempty output without overwriting files",
  { tags: ["release-e2e"], timeout: 30_000 },
  async () => {
    const { root, work } = await project();
    try {
      const options = {
        root,
        definition: "src/check.ts",
        entry: "src/main.ts",
      };
      const output = join(root, "output");
      await mkdir(output);
      await writeFile(join(output, "keep.txt"), "keep");
      await expect(
        buildCheckApp({ ...options, outputDir: output }),
      ).rejects.toThrow("empty output");
      expect(await readFile(join(output, "keep.txt"), "utf8")).toBe("keep");
      await expect(
        buildCheckApp({
          ...options,
          outputDir: join(root, "collision"),
          resources: { "check.yaml": "src/check.ts" },
        }),
      ).rejects.toThrow("colliding");
      await expect(
        buildCheckApp({
          ...options,
          outputDir: join(root, "hidden"),
          resources: { ".secret": "src/check.ts" },
        }),
      ).rejects.toThrow("colliding");
      await writeFile(join(root, "src", "invalid.ts"), "export default {};");
      await expect(
        buildCheckApp({
          ...options,
          definition: "src/invalid.ts",
          outputDir: join(root, "invalid"),
        }),
      ).rejects.toThrow("default-export");
      await expect(
        readFile(join(root, "invalid", "check-definition.mjs")),
      ).rejects.toThrow();
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  },
);
