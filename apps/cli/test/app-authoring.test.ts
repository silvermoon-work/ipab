import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import * as filesystem from "node:fs/promises";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join, resolve } from "node:path";
import { CarBlockIterator } from "@ipld/car/iterator";
import type { CID } from "multiformats/cid";
import { encodeSchema, openBundle } from "@ipab/bundle";
import { buildApp, initApp } from "../src/app-authoring.js";
import { appSchema, appSchemaCid } from "../src/space.js";
import { appDescription, schemaAlias } from "../src/app-definition.js";
import { object } from "../src/errors.js";
import { cli, fixture, subprocess } from "./helpers.js";
import { State } from "../src/state.js";

const require = createRequire(import.meta.url);
vi.mock("node:fs/promises", async () => {
  const original = await vi.importActual<typeof filesystem>("node:fs/promises");
  return { ...original, lstat: vi.fn(original.lstat) };
});
const result = (out: string) => object(JSON.parse(out) as unknown, "result");
async function projectTools(root: string) {
  await mkdir(join(root, "node_modules", "@types"), { recursive: true });
  for (const [name, target] of [
    ["typescript", dirname(require.resolve("typescript/package.json"))],
    ["@types/node", dirname(require.resolve("@types/node/package.json"))],
  ])
    await symlink(
      target!,
      join(root, "node_modules", name!),
      process.platform === "win32" ? "junction" : "dir",
    );
}
async function loadCar(path: string) {
  const iterator = await CarBlockIterator.fromIterable(
    ReadableStream.from([await readFile(path)]),
  );
  const [root] = await iterator.getRoots();
  const blocks = new Map<string, Uint8Array>();
  for await (const block of iterator)
    blocks.set(block.cid.toString(), block.bytes);
  return openBundle(root!, {
    resolveCid: (cid: CID) => Promise.resolve(blocks.get(cid.toString())!),
  });
}

describe("App-first authoring", () => {
  let work: Awaited<ReturnType<typeof fixture>>;
  let project: string;
  beforeEach(async () => {
    work = await fixture();
    const config = join(work.root, "store.json");
    await writeFile(config, JSON.stringify(work.store.configuration));
    vi.stubEnv("TASK_CONTENT_CONFIG", config);
    project = join(work.root, "hello");
  });
  afterEach(async () => {
    vi.mocked(filesystem.lstat).mockReset();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await work.cleanup();
  });
  it("preserves compiler filesystem failures and locale validation causes", async () => {
    await initApp("hello", project);
    const original = (
      await vi.importActual<typeof filesystem>("node:fs/promises")
    ).lstat;
    const failure = Object.assign(new Error("Compiler access denied"), {
      code: "EACCES",
    });
    vi.mocked(filesystem.lstat).mockImplementation((path) =>
      path === join(project, "node_modules", "typescript", "bin", "tsc")
        ? Promise.reject(failure)
        : original(path),
    );
    await expect(buildApp(project)).rejects.toBe(failure);
    const cause = new RangeError("locale failure");
    vi.spyOn(Intl, "getCanonicalLocales").mockImplementationOnce(() => {
      throw cause;
    });
    expect(() =>
      appDescription({
        ...appSchema.entry.defaultValue,
        i18n: { en: { name: "Translated App" } },
      }),
    ).toThrow(expect.objectContaining({ cause }));
  });
  it("discovers root help, validates syntax and scaffolds without installing or overwriting", async () => {
    for (const name of ["init", "build"]) {
      const response = await cli(work.stateDir, [name, "-h"]);
      expect(response.code).toBe(0);
      expect(response.out).toContain(`ipab [GLOBAL_OPTIONS] ${name}`);
    }
    for (const args of [
      ["init"],
      ["init", "hello", "one", "two"],
      ["build", "one", "two"],
      ["build", "--schema-only"],
      ["init", "hello", "--replace"],
      ["build", "-o", "-"],
    ])
      expect((await cli(work.stateDir, args)).code).toBe(2);
    const response = await cli(work.stateDir, [
      "--json",
      "--store-rpc",
      "http://127.0.0.1:1",
      "init",
      "hello",
      project,
    ]);
    expect(response.code, response.err).toBe(0);
    expect(result(response.out)).toMatchObject({
      kind: "app-init",
      directory: project,
      schemaCid: appSchemaCid.toString(),
    });
    const pkg = object(
      JSON.parse(
        await readFile(join(project, "package.json"), "utf8"),
      ) as unknown,
      "package",
    );
    expect(pkg).toMatchObject({
      name: "hello",
      private: true,
      scripts: { build: "ipab build", typecheck: "tsc --noEmit" },
      devDependencies: { typescript: "6.0.3", "@types/node": "26.6.6" },
    });
    expect(await readdir(project)).not.toContain("node_modules");
    expect(await readdir(project)).not.toContain(".bundle.yaml");
    const defaultInit = await promisify(execFile)(
      process.execPath,
      [
        resolve("dist", "main.js"),
        "--state-dir",
        work.stateDir,
        "--json",
        "init",
        "default-app",
      ],
      { cwd: work.root },
    );
    expect(result(defaultInit.stdout).directory).toBe(
      join(work.root, "default-app"),
    );
    expect(await initApp("hello", project).catch(String)).toContain(
      "not empty",
    );
    expect(await initApp("Bad Name", project).catch(String)).toContain("npm");
    const missing = await cli(work.stateDir, ["build", project]);
    expect(missing.code).toBe(1);
    expect(missing.err).toContain("Project-local TypeScript is missing");
    expect(await readdir(project)).not.toContain("dist");
  });
  it("resolves the full builtin definition offline while keeping generic commands compilation-free", async () => {
    const response = await cli(work.stateDir, [
      "--json",
      "--store-rpc",
      "http://127.0.0.1:1",
      "bundle",
      "init",
      "builtin:node-app.v1",
      project,
    ]);
    expect(response.code, response.err).toBe(0);
    expect(result(response.out).schemaCid).toBe(appSchemaCid.toString());
    expect((await encodeSchema(appSchema)).cid.toString()).toBe(
      appSchemaCid.toString(),
    );
    expect(
      JSON.parse(await readFile(join(project, "app.json"), "utf8")),
    ).toEqual(appSchema.entry.defaultValue);
    expect(
      (await cli(work.stateDir, ["bundle", "build", project, "--schema-only"]))
        .code,
    ).toBe(0);
    expect(
      (await cli(work.stateDir, ["bundle", "inspect", "builtin:node-app.v1"]))
        .code,
    ).toBe(0);
    const registered = await cli(work.stateDir, [
      "--json",
      "--store-rpc",
      "http://127.0.0.1:1",
      "register",
      "set",
      "builtin:node-app.v1",
      appSchemaCid.toString(),
    ]);
    expect(registered.code, registered.err).toBe(0);
    expect(result(registered.out).schemaCid).toBe(appSchemaCid.toString());
    expect(
      (await cli(work.stateDir, ["register", "remove", "builtin:node-app.v1"]))
        .code,
    ).toBe(0);
    expect(schemaAlias(appSchemaCid.toString())).toBe(appSchemaCid.toString());
    expect(() => schemaAlias("builtin:unknown")).toThrow("Unknown builtin");
    expect(
      (await cli(work.stateDir, ["exec", "builtin:node-app.v1"])).code,
    ).toBe(1);
    expect(appDescription(appSchema.entry.defaultValue)).toEqual(
      appSchema.entry.defaultValue,
    );
    expect(await readdir(project)).not.toContain("node_modules");
  });
  it("runs real strict tsc and bundles a dependency into a self-contained CAR, selecting only explicit resources", async () => {
    await initApp("hello", project);
    await projectTools(project);
    const dependency = join(project, "node_modules", "example-dependency");
    await mkdir(dependency);
    await writeFile(
      join(dependency, "package.json"),
      JSON.stringify({
        name: "example-dependency",
        main: "index.cjs",
        types: "index.d.ts",
      }),
    );
    await writeFile(
      join(dependency, "index.cjs"),
      'exports.greeting = "Bundled dependency";\n',
    );
    await writeFile(
      join(dependency, "index.d.ts"),
      "export const greeting: string;\n",
    );
    await writeFile(
      join(project, "src", "main.ts"),
      'import { greeting } from "example-dependency";\nimport { basename } from "node:path";\nconsole.log(greeting, basename("hello"));\n',
    );
    await mkdir(join(project, "assets"));
    await writeFile(
      join(project, "assets", "message.txt"),
      "Selected resource",
    );
    await writeFile(
      join(project, "assets", "unselected.txt"),
      "Do not package",
    );
    await writeFile(join(project, ".env"), "SECRET=not-for-bundling");
    await writeFile(
      join(project, "ipab.json"),
      JSON.stringify({
        entry: "src/main.ts",
        resources: ["assets/message.txt"],
        app: {
          name: "Example App",
          version: "1.0.0",
          license: "MIT",
          icon: "resources/assets/message.txt",
          i18n: { en: { name: "Example App" } },
        },
      }),
    );
    const response = await cli(work.stateDir, ["--json", "build", project]);
    expect(response.code, response.err).toBe(0);
    expect(result(response.out)).toMatchObject({
      kind: "app-bundle",
      imported: true,
      schemaCid: appSchemaCid.toString(),
      output: join(project, "dist", "app.car"),
    });
    const bundle = await loadCar(join(project, "dist", "app.car"));
    expect(bundle.schemaKey).toBe(appSchemaCid.toString());
    expect(
      JSON.parse(
        await new Response(await bundle.readFile("app.json")).text(),
      ) as unknown,
    ).toMatchObject({
      name: "Example App",
      version: "1.0.0",
      description: "",
      license: "MIT",
      icon: "resources/assets/message.txt",
    });
    const source = await new Response(
      await bundle.readFile("resources/app.cjs"),
    ).text();
    expect(source).toContain("Bundled dependency");
    expect(source).not.toContain('require("example-dependency")');
    const run = await promisify(execFile)(
      process.execPath,
      ["--eval", source],
      { cwd: work.root },
    );
    expect(run.stdout.trim()).toBe("Bundled dependency hello");
    expect(
      await new Response(
        await bundle.readFile("resources/assets/message.txt"),
      ).text(),
    ).toBe("Selected resource");
    for (const path of [
      "src/main.ts",
      ".env",
      "node_modules/example-dependency/index.cjs",
      "resources/assets/unselected.txt",
    ])
      await expect(bundle.readFile(path)).rejects.toThrow();
    const firstCar = await readFile(join(project, "dist", "app.car"));
    const storeConfig = join(work.root, "store.json");
    expect(work.store.pins()).toEqual([]);
    const cid = String(result(response.out).cid);
    const pinned = await cli(work.stateDir, ["pin", "add", "reader", cid]);
    expect(pinned.code, pinned.err).toBe(0);
    const executed = await subprocess(
      ["--state-dir", work.stateDir, "exec", "reader"],
      storeConfig,
    );
    expect(executed.code, executed.stderr).toBe(0);
    expect(executed.stdout.toString().trim()).toBe("Bundled dependency hello");
    expect(
      (await cli(work.stateDir, ["pin", "rename", "reader", "my-reader"])).code,
    ).toBe(0);
    const again = await subprocess(
      ["--state-dir", work.stateDir, "exec", "my-reader"],
      storeConfig,
    );
    expect(again.code, again.stderr).toBe(0);
    expect(again.stdout.toString().trim()).toBe("Bundled dependency hello");
    const state = new State(work.stateDir);
    expect(state.runs().every((run) => run.appCid === cid)).toBe(true);
    state.close();
    expect(
      (await cli(work.stateDir, ["pin", "delete", "my-reader"])).code,
    ).toBe(0);
    expect((await cli(work.stateDir, ["build", project])).code).toBe(1);
    const defaultBuild = await promisify(execFile)(
      process.execPath,
      [
        resolve("dist", "main.js"),
        "--state-dir",
        work.stateDir,
        "--json",
        "--store-rpc",
        "http://127.0.0.1:1",
        "build",
        "--replace",
        "--no-import",
      ],
      { cwd: project },
    );
    expect(result(defaultBuild.stdout).output).toBe(
      join(project, "dist", "app.car"),
    );
    expect(result(defaultBuild.stdout).imported).toBe(false);
    expect(
      (await cli(work.stateDir, ["build", project, "--replace"])).code,
    ).toBe(0);
    expect(await readFile(join(project, "dist", "app.car"))).toEqual(firstCar);
    const imported = await subprocess(
      [
        "--state-dir",
        work.stateDir,
        "--json",
        "bundle",
        "import",
        join(project, "dist", "app.car"),
      ],
      storeConfig,
    );
    expect(imported.code, imported.stderr).toBe(0);
    expect(result(imported.stdout.toString()).cid).toBe(
      result(response.out).cid,
    );
    await writeFile(
      join(project, "src", "main.ts"),
      'const invalid: number = "not a number";\n',
    );
    const failed = await cli(work.stateDir, ["build", project, "--replace"]);
    expect(failed.code).toBe(1);
    expect(failed.err).toContain("typecheck failed");
    expect(await readFile(join(project, "dist", "app.car"))).toEqual(firstCar);
    expect(
      (await readdir(project)).filter((name) => name.startsWith(".ipab-app-")),
    ).toEqual([]);
  }, 60_000);
  it("rejects unsafe config/output and cleans only fresh owned staging after bundle failure", async () => {
    await initApp("hello", project);
    await projectTools(project);
    await mkdir(join(project, ".ipab-app-stale"));
    await writeFile(join(project, ".ipab-app-stale", "app.cjs"), "Old program");
    const set = async (
      entry: unknown = "src/main.ts",
      resources: unknown = [],
      extra = {},
    ) =>
      writeFile(
        join(project, "ipab.json"),
        JSON.stringify({ entry, resources, ...extra }),
      );
    for (const [entry, resources, extra] of [
      ["src/main.ts", [], { hooks: "not allowed" }],
      ["main.js", [], {}],
      ["src/main.ts", [1], {}],
      ["src/main.ts", ["../secret"], {}],
      ["src/main.ts", ["src/main.ts"], {}],
      ["src/main.ts", ["assets/.env"], {}],
      ["src/main.ts", ["assets/a", "assets/a"], {}],
    ] as const) {
      await set(entry, resources, extra);
      await expect(buildApp(project)).rejects.toThrow();
    }
    await set();
    for (const app of [
      { entry: "resources/other.cjs" },
      { icon: "resources/assets/missing.svg" },
      { profile: "ipab.node.v1" },
    ]) {
      await set("src/main.ts", [], { app });
      await expect(buildApp(project)).rejects.toThrow();
    }
    await set();
    for (const output of [
      join(project, "src", "main.ts"),
      join(project, "src", "source.car"),
      join(project, "ipab.json"),
    ])
      await expect(
        buildApp(project, { output, replace: true }),
      ).rejects.toThrow("source");
    await set("src/main.ts", ["assets/missing.txt"]);
    await expect(buildApp(project)).rejects.toThrow();
    expect(
      (await readdir(project)).filter((name) => name.startsWith(".ipab-app-")),
    ).toEqual([".ipab-app-stale"]);
    await set();
    await writeFile(
      join(project, "src", "main.ts"),
      "await Promise.resolve();\nexport {};\n",
    );
    await expect(buildApp(project)).rejects.toThrow("Top-level await");
    expect(
      (await readdir(project)).filter((name) => name.startsWith(".ipab-app-")),
    ).toEqual([".ipab-app-stale"]);
    await expect(buildApp(join(project, "package.json"))).rejects.toThrow(
      "directory",
    );
    await expect(buildApp(resolve(work.root, "missing"))).rejects.toThrow();
  }, 60_000);
  it("requires the selected entry to be typechecked and refuses dynamic runtime dependencies", async () => {
    await initApp("hello", project);
    await projectTools(project);
    await writeFile(join(project, "src", "other.ts"), "export {};\n");
    const configPath = join(project, "tsconfig.json");
    const config = object(
      JSON.parse(await readFile(configPath, "utf8")) as unknown,
      "tsconfig",
    );
    await writeFile(
      configPath,
      JSON.stringify({ ...config, include: ["src/other.ts"] }),
    );
    await expect(buildApp(project)).rejects.toThrow("not included");
    await writeFile(configPath, JSON.stringify(config));
    for (const code of [
      "require(process.argv[2]);\n",
      "void import(process.argv[2]);\n",
      "const r = require; r(process.argv[2]);\n",
    ]) {
      await writeFile(join(project, "src", "main.ts"), code);
      await expect(buildApp(project)).rejects.toThrow("will not be bundled");
    }
    expect(
      (await readdir(project)).filter((name) => name.startsWith(".ipab-app-")),
    ).toEqual([]);
    const alias = join(project, "dist");
    await symlink(
      join(project, "src"),
      alias,
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(buildApp(project, { replace: true })).rejects.toThrow(
      "symbolic links",
    );
  }, 60_000);
});
