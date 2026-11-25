import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mkdir,
  readFile,
  readdir,
  symlink,
  writeFile,
  unlink,
} from "node:fs/promises";
import * as filesystem from "node:fs/promises";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import * as processes from "node:child_process";
import { promisify } from "node:util";
import { delimiter, dirname, join, resolve } from "node:path";
import { CarBlockIterator } from "@ipld/car/iterator";
import type { CID } from "multiformats/cid";
import { encodeSchema, openBundle, parseData } from "@ipab/bundle";
import { stringify } from "yaml";
import { readSupportedSchemas } from "../src/supported-schemas.js";
import { buildApp, initApp } from "../src/app-authoring.js";
import { appSchema, appSchemaCid } from "../src/space.js";
import { appDescription, schemaAlias } from "../src/app-definition.js";
import { object } from "../src/errors.js";
import { cli, fixture, subprocess } from "./helpers.js";
import { State } from "../src/state.js";
import { buildChain, projectBuild, runPrebuild } from "../src/app-prebuild.js";
import { readCar } from "../src/authoring.js";

const require = createRequire(import.meta.url);
vi.mock("node:fs/promises", async () => {
  const original = await vi.importActual<typeof filesystem>("node:fs/promises");
  return { ...original, lstat: vi.fn(original.lstat) };
});
vi.mock("node:child_process", async () => {
  const original =
    await vi.importActual<typeof processes>("node:child_process");
  return { ...original, spawn: vi.fn(original.spawn) };
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
    vi.mocked(processes.spawn).mockReset();
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
      ["build", "--with-source", "--without-source"],
      ["bundle", "build", "example", "--with-source"],
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
    expect(await readdir(project)).toContain(".bundle.yaml");
    const template = await readFile(join(project, "ipab.yaml"), "utf8");
    expect(parseData(Buffer.from(template), "application/yaml")).toEqual({
      entry: "src/main.ts",
      resources: [],
      supportedSchemas: [],
      build: { includeSource: true },
      app: { name: "hello", version: "0.0.0", description: "" },
    });
    for (const capability of [
      "assets/icon.png",
      "resources/assets/icon.png",
      "schemas/note.json",
      "NOT bare JSON Schema",
      "# i18n:",
      "#     name:",
      "#     description:",
      "# author:",
      "# license:",
    ])
      expect(template).toContain(capability);
    expect(await readdir(project)).not.toContain("ipab.json");
    expect(await readdir(project)).not.toContain("assets");
    expect(await readdir(project)).not.toContain("schemas");
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
      (
        await cli(work.stateDir, [
          "bundle",
          "build",
          project,
          "--schema-only",
          "--no-import",
        ])
      ).code,
    ).toBe(0);
    expect(
      (await cli(work.stateDir, ["bundle", "inspect", "builtin:node-app.v1"]))
        .code,
    ).toBe(0);
    expect(await readdir(project)).not.toContain("node_modules");
  });
  it("registers the exact builtin identity offline without treating it as an executable App", async () => {
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
  });
  it("runs real strict tsc and bundles a dependency into a self-contained CAR, selecting only explicit resources", async () => {
    await initApp("hello", project);
    await unlink(join(project, "ipab.yaml"));
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
    const description = object(
      JSON.parse(
        await new Response(await bundle.readFile("app.json")).text(),
      ) as unknown,
      "metadata",
    );
    expect(description).not.toHaveProperty("supportedSchemas");
    const sourceResult = object(result(response.out).source, "source result");
    expect(sourceResult.output).toBe(join(project, "dist", "app.source.car"));
    expect(description.source).toEqual({ cid: sourceResult.cid });
    const sourceBundle = await loadCar(String(sourceResult.output));
    expect(sourceBundle.cid.toString()).toBe(sourceResult.cid);
    expect(
      await new Response(await sourceBundle.readFile("src/main.ts")).text(),
    ).toContain('from "example-dependency"');
    expect(
      await new Response(
        await sourceBundle.readFile("assets/unselected.txt"),
      ).text(),
    ).toBe("Do not package");
    for (const path of [
      ".env",
      "node_modules/example-dependency/index.cjs",
      "dist/app.car",
    ])
      await expect(sourceBundle.readFile(path)).rejects.toThrow();
    const appCar = await readCar(join(project, "dist", "app.car"), {});
    expect(appCar.blocks.has(String(sourceResult.cid))).toBe(false);
    await expect(
      work.store.block.get(String(sourceResult.cid)),
    ).rejects.toThrow();
    await expect(
      bundle.readFile("resources/supported-schemas.car"),
    ).rejects.toThrow();
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
  }, 60_000);
  it("executes a built App before and after renaming its independent pin", async () => {
    await initApp("hello", project);
    await projectTools(project);
    const response = await cli(work.stateDir, ["--json", "build", project]);
    expect(response.code, response.err).toBe(0);
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
    expect(executed.stdout.toString().trim()).toBe("Hello from your IPAB App.");
    expect(
      (await cli(work.stateDir, ["pin", "rename", "reader", "my-reader"])).code,
    ).toBe(0);
    const again = await subprocess(
      ["--state-dir", work.stateDir, "exec", "my-reader"],
      storeConfig,
    );
    expect(again.code, again.stderr).toBe(0);
    expect(again.stdout.toString().trim()).toBe("Hello from your IPAB App.");
    const state = new State(work.stateDir);
    expect(state.runs().every((run) => run.appCid === cid)).toBe(true);
    state.close();
    expect(
      (await cli(work.stateDir, ["pin", "delete", "my-reader"])).code,
    ).toBe(0);
  }, 60_000);
  it(
    "rebuilds deterministic CARs from cwd and preserves outputs after typecheck failure",
    { tags: ["release-e2e"], timeout: 60_000 },
    async () => {
      await initApp("hello", project);
      await projectTools(project);
      const response = await cli(work.stateDir, ["--json", "build", project]);
      expect(response.code, response.err).toBe(0);
      const firstCar = await readFile(join(project, "dist", "app.car"));
      const storeConfig = join(work.root, "store.json");
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
      expect(await readFile(join(project, "dist", "app.car"))).toEqual(
        firstCar,
      );
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
      expect(await readFile(join(project, "dist", "app.car"))).toEqual(
        firstCar,
      );
      expect(
        (await readdir(project)).filter((name) =>
          name.startsWith(".ipab-app-"),
        ),
      ).toEqual([]);
    },
  );
  it("rejects unsafe config/output and cleans only fresh owned staging after bundle failure", async () => {
    await initApp("hello", project);
    await unlink(join(project, "ipab.yaml"));
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
      { supportedSchemas: "resources/custom.car" },
      { source: { cid: appSchemaCid.toString() } },
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
  it(
    "builds deterministic deduplicated complete Schema collections from YAML or legacy JSON",
    { tags: ["release-e2e"], timeout: 60_000 },
    async () => {
      await initApp("hello", project);
      await projectTools(project);
      const emptyBuild = await buildApp(project);
      const emptyBundle = await loadCar(emptyBuild.output);
      expect(
        JSON.parse(
          await new Response(await emptyBundle.readFile("app.json")).text(),
        ) as unknown,
      ).not.toHaveProperty("supportedSchemas");
      await expect(
        emptyBundle.readFile("resources/supported-schemas.car"),
      ).rejects.toThrow();
      expect(
        await new Response(
          await emptyBundle.readFile("resources/app.cjs"),
        ).text(),
      ).toContain("Hello from your IPAB App.");
      await mkdir(join(project, "schemas"));
      const definition = {
        name: "Note",
        entry: {
          path: "note.json",
          schema: { type: "string" },
          contentType: "application/json",
          defaultValue: "",
        },
      };
      const second = {
        ...definition,
        name: "Other note",
        description: "Second type",
      };
      for (const [name, value] of [
        ["note.json", definition],
        ["same.json", { ...definition, description: "" }],
        ["other.json", second],
      ] as const)
        await writeFile(join(project, "schemas", name), JSON.stringify(value));
      const selected = {
        entry: "src/main.ts",
        resources: [],
        build: { includeSource: false },
        supportedSchemas: [
          "schemas/note.json",
          "schemas/same.json",
          "schemas/other.json",
        ],
        app: {},
      };
      const yamlPath = join(project, "ipab.yaml");
      await writeFile(
        yamlPath,
        `# Comments do not enter the Bundle.\n${stringify(selected)}`,
      );
      const first = await buildApp(project, { replace: true });
      const firstBytes = await readFile(first.output);
      const bundle = await loadCar(first.output);
      const metadata = JSON.parse(
        await new Response(await bundle.readFile("app.json")).text(),
      ) as unknown;
      expect(metadata).toMatchObject({
        supportedSchemas: "resources/supported-schemas.car",
      });
      const nestedBytes = new Uint8Array(
        await new Response(
          await bundle.readFile("resources/supported-schemas.car"),
        ).arrayBuffer(),
      );
      const iterator = await CarBlockIterator.fromIterable(
        ReadableStream.from([nestedBytes]),
      );
      const roots = (await iterator.getRoots()).map((cid) => cid.toString());
      const encoded = await Promise.all(
        [definition, second].map((value) => encodeSchema(value)),
      );
      const expected = encoded.map((block) => block.cid.toString()).sort();
      expect(roots).toEqual(expected);
      const records: string[] = [];
      for await (const block of iterator) records.push(block.cid.toString());
      expect(records).toEqual(expected);
      expect(
        [
          ...(await readSupportedSchemas(ReadableStream.from([nestedBytes]))),
        ].sort(),
      ).toEqual(expected);
      await expect(bundle.readFile("schemas/note.json")).rejects.toThrow();
      await writeFile(
        yamlPath,
        stringify({
          ...selected,
          supportedSchemas: [...selected.supportedSchemas].reverse(),
        }),
      );
      expect((await buildApp(project, { replace: true })).cid).toBe(first.cid);
      expect(await readFile(first.output)).toEqual(firstBytes);
      await unlink(yamlPath);
      await writeFile(join(project, "ipab.json"), JSON.stringify(selected));
      expect((await buildApp(project, { replace: true })).cid).toBe(first.cid);
      expect(await readFile(first.output)).toEqual(firstBytes);
      for (const invalid of [
        "{",
        '{"name":"One","name":"Two","entry":{}}',
        JSON.stringify({ type: "string" }),
        JSON.stringify({
          ...definition,
          entry: { ...definition.entry, defaultValue: 1 },
        }),
      ]) {
        await writeFile(join(project, "schemas", "note.json"), invalid);
        await expect(buildApp(project, { replace: true })).rejects.toThrow();
        expect(await readFile(first.output)).toEqual(firstBytes);
      }
      expect(
        (await readdir(project)).filter((name) =>
          name.startsWith(".ipab-app-"),
        ),
      ).toEqual([]);
    },
  );

  it("rejects ambiguous or invalid data configs and unsafe, missing or symlinked Schema sources", async () => {
    await initApp("hello", project);
    const configPath = join(project, "ipab.yaml");
    const selected = {
      entry: "src/main.ts",
      resources: [],
      supportedSchemas: [],
      app: {},
    };
    await writeFile(join(project, "ipab.json"), JSON.stringify(selected));
    await expect(buildApp(project)).rejects.toThrow("exactly one");
    await unlink(join(project, "ipab.json"));
    for (const source of [
      "entry: src/main.ts\nentry: src/main.ts\nresources: []\n",
      "entry: src/main.ts\nresources: []\nsupportedSchemas: invalid\n",
      "entry: src/main.ts\nresources: []\nhooks: execute\n",
      "!!js/function 'function() {}'",
      "entry: src/main.ts\nresources: []\n---\nentry: src/main.ts\n",
    ]) {
      await writeFile(configPath, source);
      await expect(buildApp(project)).rejects.toThrow();
    }
    for (const supportedSchemas of [
      [1],
      ["../note.json"],
      ["assets/note.json"],
      ["schemas/.hidden.json"],
      ["schemas/folder/.hidden/note.json"],
      ["schemas/note.yaml"],
      ["schemas/*.json"],
      ["schemas/note.json", "schemas/note.json"],
      ["schemas/missing.json"],
    ]) {
      await writeFile(configPath, stringify({ ...selected, supportedSchemas }));
      await expect(buildApp(project)).rejects.toThrow();
    }
    await mkdir(join(project, "schemas"));
    await mkdir(join(project, "schemas", "directory.json"));
    await writeFile(
      configPath,
      stringify({ ...selected, supportedSchemas: ["schemas/directory.json"] }),
    );
    await expect(buildApp(project)).rejects.toThrow();
    const target = join(work.root, "outside.json");
    await writeFile(target, "{}");
    await symlink(target, join(project, "schemas", "link.json"), "file");
    await writeFile(
      configPath,
      stringify({ ...selected, supportedSchemas: ["schemas/link.json"] }),
    );
    await expect(buildApp(project)).rejects.toThrow("Symlinks");
    for (const app of [
      { supportedSchemas: "resources/custom.car" },
      { entry: "resources/custom.cjs" },
    ]) {
      await writeFile(configPath, stringify({ ...selected, app }));
      await expect(buildApp(project)).rejects.toThrow("override");
    }
    await unlink(configPath);
    await expect(buildApp(project)).rejects.toThrow("missing");
  });
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
  it("extends init with explicit data-only local templates and preserves binary files", async () => {
    const template = join(work.root, "template");
    await mkdir(template);
    const definition = {
      version: 1,
      files: [
        { source: "package.txt", target: "package.json", render: true },
        { source: "config.json", target: "ipab.json" },
        { source: "image.bin", target: "assets/image.bin" },
      ],
    };
    await writeFile(
      join(template, "ipab-template.json"),
      JSON.stringify(definition),
    );
    await writeFile(
      join(template, "package.txt"),
      '{"name":"{{name}}","private":true}',
    );
    await writeFile(
      join(template, "config.json"),
      '{"entry":"src/main.ts","resources":[]}',
    );
    await writeFile(join(template, "image.bin"), new Uint8Array([0, 255, 128]));
    const created = await cli(work.stateDir, [
      "--json",
      "init",
      "custom",
      project,
      "--template",
      template,
    ]);
    expect(created.code, created.err).toBe(0);
    expect(result(created.out).template).toBe(template);
    expect(
      JSON.parse(await readFile(join(project, "package.json"), "utf8")),
    ).toMatchObject({ name: "custom" });
    expect(await readFile(join(project, "assets", "image.bin"))).toEqual(
      Buffer.from([0, 255, 128]),
    );
    expect(
      (await cli(work.stateDir, ["init", "unknown", "--template", "unknown"]))
        .err,
    ).toContain("Unknown template");
    for (const files of [
      [{ source: "../outside", target: "package.json" }],
      [{ source: "package.txt", target: "../outside" }],
      [{ source: "package.txt", target: "node_modules/foo" }],
      [
        { source: "package.txt", target: "package.json" },
        { source: "config.json", target: "PACKAGE.JSON" },
      ],
      [
        { source: "package.txt", target: "package.json" },
        { source: "config.json", target: "package.json/child" },
      ],
      [{ source: "package.txt", target: "package.json", unknown: true }],
      [{ source: "package.txt", target: "package.json", render: "true" }],
      [{ source: "package.txt", target: "package.json" }],
    ]) {
      await writeFile(
        join(template, "ipab-template.json"),
        JSON.stringify({ version: 1, files }),
      );
      await expect(
        initApp("invalid", join(work.root, "invalid"), { template }),
      ).rejects.toThrow();
    }
    await writeFile(
      join(template, "ipab-template.json"),
      JSON.stringify(definition),
    );
    await writeFile(join(template, "package.txt"), "{{unknown}}");
    await expect(
      initApp("invalid", join(work.root, "invalid"), { template }),
    ).rejects.toThrow("Unknown template variable");
  });
  it("validates hook contracts and detects recursive builds without guessing a strategy", async () => {
    expect(projectBuild(undefined)).toBeUndefined();
    expect(projectBuild({ includeSource: true })).toBeUndefined();
    for (const build of [
      { includeSource: "true" },
      { unknown: true },
      { strategy: "ipab-prebuild", typecheck: [] },
      { strategy: "ipab-prebuild", typecheck: [{}] },
      {
        strategy: "ipab-prebuild",
        typecheck: [{ config: "../secret", entry: "src/main.ts" }],
      },
      {
        strategy: "ipab-prebuild",
        typecheck: [{ config: "config.js", entry: "src/main.ts" }],
      },
      {
        strategy: "ipab-prebuild",
        typecheck: [{ config: "tsconfig.json", entry: "other.ts" }],
      },
      {
        strategy: "ipab-prebuild",
        typecheck: [{ config: "tsconfig.json", entry: "src/main.js" }],
      },
      {
        strategy: "ipab-prebuild",
        typecheck: [
          { config: "tsconfig.json", entry: "src/main.ts", unknown: true },
        ],
      },
    ])
      expect(() => projectBuild(build)).toThrow();
    await mkdir(project);
    const chain = await buildChain(project);
    vi.stubEnv("IPAB_BUILD_CHAIN", JSON.stringify(chain));
    await expect(buildChain(project)).rejects.toThrow("Recursive");
    vi.stubEnv("IPAB_BUILD_CHAIN", '["parent",1]');
    await expect(buildChain(project)).rejects.toThrow("Invalid");
    vi.stubEnv("IPAB_BUILD_CHAIN", "{");
    await expect(buildChain(project)).rejects.toThrow(
      "Invalid IPAB_BUILD_CHAIN",
    );
  });
  it(
    "builds the real Web App template with Vite, preserving front-end assets in one Node App CAR",
    { tags: ["release-e2e"], timeout: 120_000 },
    async () => {
      const initialized = await initApp("web-demo", project, {
        template: "web-app",
      });
      expect(initialized.templateCid).toMatch(/^bafy/);
      await projectTools(project);
      for (const name of ["esbuild", "vite", "@ipab/web-app"]) {
        if (name.startsWith("@ipab/"))
          await mkdir(join(project, "node_modules", "@ipab"), {
            recursive: true,
          });
        await symlink(
          dirname(require.resolve(`${name}/package.json`)),
          join(project, "node_modules", name),
          process.platform === "win32" ? "junction" : "dir",
        );
      }
      const pkgPath = join(project, "package.json");
      const pkg = object(
        JSON.parse(await readFile(pkgPath, "utf8")) as unknown,
        "package",
      );
      expect(pkg.packageManager).toBeUndefined();
      await writeFile(
        pkgPath,
        JSON.stringify({
          ...pkg,
          scripts: {
            ...object(pkg.scripts, "scripts"),
            build: `node ${JSON.stringify(resolve("dist", "main.js"))} --state-dir ${JSON.stringify(work.stateDir)} --json build`,
          },
        }),
      );
      const runner = process.env.npm_execpath!;
      expect(runner).toMatch(/pnpm(?:\.cjs|\.mjs|\.js|\.exe)?$/);
      const built = await promisify(execFile)(
        runner.endsWith(".exe") ? runner : process.execPath,
        [...(runner.endsWith(".exe") ? [] : [runner]), "run", "build"],
        { cwd: project },
      );
      expect(result(built.stdout)).toMatchObject({
        kind: "app-bundle",
        imported: true,
      });
      const bundle = await loadCar(join(project, "dist", "app.car"));
      const html = await new Response(
        await bundle.readFile("resources/web/index.html"),
      ).text();
      expect(html).toContain("<title>web-demo</title>");
      const js = /src="\.\/([^"]+\.js)"/.exec(html)?.[1];
      const css = /href="\.\/([^"]+\.css)"/.exec(html)?.[1];
      expect(js).toBeDefined();
      expect(css).toBeDefined();
      expect(
        await new Response(
          await bundle.readFile(`resources/web/${js!}`),
        ).text(),
      ).toContain("Send a greeting");
      expect(
        await new Response(
          await bundle.readFile(`resources/web/${css!}`),
        ).text(),
      ).toContain("#18334b");
      const backend = await new Response(
        await bundle.readFile("resources/app.cjs"),
      ).text();
      expect(backend).toContain("Your App is listening");
      await expect(bundle.readFile("src/server/main.ts")).rejects.toThrow();
      await expect(
        bundle.readFile("node_modules/vite/package.json"),
      ).rejects.toThrow();
      await expect(
        bundle.readFile("scripts/ipab-prebuild.mjs"),
      ).rejects.toThrow();
      const oldCar = await readFile(join(project, "dist", "app.car"));
      await writeFile(
        pkgPath,
        JSON.stringify({
          ...pkg,
          scripts: {
            "ipab-prebuild": `node ${JSON.stringify(resolve("dist", "main.js"))} --state-dir ${JSON.stringify(work.stateDir)} build --no-import`,
          },
        }),
      );
      const recursive = await cli(work.stateDir, [
        "build",
        project,
        "--replace",
        "--no-import",
      ]);
      expect(recursive.code).toBe(1);
      expect(recursive.err).toContain("Recursive ipab build");
      expect(await readFile(join(project, "dist", "app.car"))).toEqual(oldCar);
    },
  );
  it(
    "builds the React viewer template with shared SSR code, hydration assets and an exact supported type",
    { timeout: 120_000 },
    async () => {
      await initApp("reader", project, {
        template: resolve("../../templates/bundle-viewer"),
        parameters: [
          `bundleViewerDependency=link:${dirname(require.resolve("@ipab/bundle-viewer/package.json")).replaceAll("\\", "/")}`,
        ],
      });
      await projectTools(project);
      for (const name of [
        "esbuild",
        "vite",
        "@ipab/bundle-viewer",
        "react",
        "react-dom",
        "@types/react",
        "@types/react-dom",
      ]) {
        await mkdir(dirname(join(project, "node_modules", name)), {
          recursive: true,
        });
        await symlink(
          dirname(require.resolve(`${name}/package.json`)),
          join(project, "node_modules", name),
          process.platform === "win32" ? "junction" : "dir",
        );
      }
      const built = await buildApp(project, { includeSource: false });
      const bundle = await loadCar(built.output);
      const html = await new Response(
        await bundle.readFile("resources/web/index.html"),
      ).text();
      expect(html).toContain("<!--ipab:viewer-->");
      expect(html).toContain("<!--ipab:state-->");
      const js = /src="\.\/([^"]+\.js)"/.exec(html)?.[1];
      expect(js).toBeDefined();
      expect(
        await new Response(
          await bundle.readFile(`resources/web/${js!}`),
        ).text(),
      ).toContain("Missing SSR viewer or state");
      const backend = await new Response(
        await bundle.readFile("resources/app.cjs"),
      ).text();
      expect(backend).toContain(
        "Content Bundle type does not match this viewer",
      );
      const schemas = await readSupportedSchemas(
        await bundle.readFile("resources/supported-schemas.car"),
      );
      expect(schemas.size).toBe(1);
      const declared = JSON.parse(
        await readFile(join(project, "schemas/content.json"), "utf8"),
      ) as unknown;
      expect(schemas).toContain((await encodeSchema(declared)).cid.toString());
    },
  );
  it(
    "assembles fresh hook output, skips lifecycle hooks and rejects invalid programs without replacing the CAR",
    { tags: ["release-e2e"], timeout: 120_000 },
    async () => {
      await initApp("hello", project);
      await projectTools(project);
      const config = {
        entry: "app.cjs",
        resources: ["web"],
        build: {
          strategy: "ipab-prebuild",
          typecheck: [{ config: "tsconfig.json", entry: "src/main.ts" }],
        },
        app: { icon: "resources/web/icon.svg" },
      };
      await writeFile(join(project, "ipab.yaml"), stringify(config));
      const hook = join(project, "prebuild.mjs");
      const writeHook = async (source: string) =>
        writeFile(
          hook,
          `
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
console.error("prebuild diagnostic");
const output = process.env.IPAB_BUILD_DIR;
await mkdir(join(output, "web"));
await writeFile(join(output, "app.cjs"), ${JSON.stringify(source)});
await writeFile(join(output, "web", "index.html"), "<h1>Fresh output</h1>");
await writeFile(join(output, "web", "icon.svg"), "<svg/>");
`,
        );
      await writeHook('console.log("fresh");');
      const pkgPath = join(project, "package.json");
      const pkg = object(
        JSON.parse(await readFile(pkgPath, "utf8")) as unknown,
        "package",
      );
      await writeFile(
        pkgPath,
        JSON.stringify({
          ...pkg,
          scripts: {
            build: "ipab build",
            "ipab-prebuild": "node prebuild.mjs",
            "preipab-prebuild": "node missing-pre-hook.cjs",
            "postipab-prebuild": "node missing-post-hook.cjs",
          },
        }),
      );
      const first = await cli(work.stateDir, [
        "--json",
        "build",
        project,
        "--no-import",
      ]);
      expect(first.code, first.err).toBe(0);
      expect(first.err).toContain("prebuild diagnostic");
      expect(result(first.out).imported).toBe(false);
      const carPath = join(project, "dist", "app.car");
      const original = await readFile(carPath);
      const bundle = await loadCar(carPath);
      expect(
        await new Response(
          await bundle.readFile("resources/web/index.html"),
        ).text(),
      ).toContain("Fresh output");
      expect(
        await new Response(await bundle.readFile("resources/app.cjs")).text(),
      ).toBe('console.log("fresh");');
      for (const source of [
        'require("external-package");',
        "require(process.argv[2]);",
        'require("./web/other.cjs");',
        "export const invalid = ;",
        "export const valid = 1;",
        'import { basename } from "node:path"; console.log(basename("app"));',
      ]) {
        await writeHook(source);
        await expect(buildApp(project, { replace: true })).rejects.toThrow();
        expect(await readFile(carPath)).toEqual(original);
      }
      await writeFile(hook, "process.exitCode = 7;");
      await expect(buildApp(project, { replace: true })).rejects.toThrow(
        "ipab-prebuild failed",
      );
      expect(await readFile(carPath)).toEqual(original);
      await writeFile(hook, 'console.log("No output");');
      await expect(buildApp(project, { replace: true })).rejects.toThrow();
      expect(await readFile(carPath)).toEqual(original);
      await writeHook('console.log("fresh");');
      await writeFile(
        hook,
        `${await readFile(hook, "utf8")}\nawait writeFile(join(output, "app.cjs"), new Uint8Array([0xff]));`,
      );
      await expect(buildApp(project, { replace: true })).rejects.toThrow(
        "valid Node CommonJS",
      );
      expect(await readFile(carPath)).toEqual(original);
      expect(
        (await readdir(project)).filter((name) =>
          name.startsWith(".ipab-app-"),
        ),
      ).toEqual([]);
    },
  );
  it(
    "uses project source defaults and mutually exclusive CLI overrides without retaining source",
    { tags: ["release-e2e"], timeout: 60_000 },
    async () => {
      await initApp("hello", project);
      await projectTools(project);
      await writeFile(
        join(project, "ipab.yaml"),
        stringify({
          entry: "src/main.ts",
          resources: [],
          build: { includeSource: false },
        }),
      );
      const disabled = await cli(work.stateDir, [
        "--json",
        "build",
        project,
        "--no-import",
      ]);
      expect(disabled.code, disabled.err).toBe(0);
      expect(result(disabled.out)).not.toHaveProperty("source");
      const withoutBytes = await readFile(join(project, "dist", "app.car"));
      expect(await readdir(join(project, "dist"))).toEqual(["app.car"]);
      const included = await cli(work.stateDir, [
        "--json",
        "build",
        project,
        "--with-source",
        "--replace",
        "--no-import",
      ]);
      expect(included.code, included.err).toBe(0);
      const includedSource = object(result(included.out).source, "source");
      expect(includedSource).toMatchObject({
        output: join(project, "dist", "app.source.car"),
      });
      const sourceBytes = await readFile(String(includedSource.output));
      await writeFile(
        join(project, "ipab.yaml"),
        stringify({
          entry: "src/main.ts",
          resources: [],
          build: { includeSource: true },
        }),
      );
      const excluded = await cli(work.stateDir, [
        "--json",
        "build",
        project,
        "--without-source",
        "--replace",
        "--no-import",
      ]);
      expect(excluded.code, excluded.err).toBe(0);
      expect(result(excluded.out)).not.toHaveProperty("source");
      expect(await readFile(join(project, "dist", "app.car"))).toEqual(
        withoutBytes,
      );
      expect(await readFile(String(includedSource.output))).toEqual(
        sourceBytes,
      );
      await writeFile(join(project, ".gitignore"), "src/main.ts\n");
      await expect(buildApp(project, { replace: true })).rejects.toThrow(
        "excluded from source",
      );
      expect(await readFile(join(project, "dist", "app.car"))).toEqual(
        withoutBytes,
      );
    },
  );
  it(
    "strictly checks both backend and browser entries before running project compilation",
    { tags: ["release-e2e"], timeout: 60_000 },
    async () => {
      await initApp("hello", project);
      await projectTools(project);
      const serverConfigPath = join(project, "tsconfig.json");
      const serverConfig = object(
        JSON.parse(await readFile(serverConfigPath, "utf8")) as unknown,
        "tsconfig",
      );
      await writeFile(
        serverConfigPath,
        JSON.stringify({ ...serverConfig, include: ["src/main.ts"] }),
      );
      await writeFile(join(project, "src", "other.ts"), "export {};\n");
      await writeFile(
        join(project, "src", "browser.ts"),
        "document.body.textContent = 'browser';\nconst unchecked = (value) => value;\n",
      );
      const browserConfig = {
        compilerOptions: {
          target: "ES2022",
          lib: ["ES2022", "DOM"],
          types: [],
          strict: false,
          noCheck: true,
        },
        files: ["src/browser.ts"],
      };
      await writeFile(
        join(project, "tsconfig.browser.json"),
        JSON.stringify(browserConfig),
      );
      await writeFile(
        join(project, "ipab.yaml"),
        stringify({
          entry: "server/app.cjs",
          resources: ["web"],
          build: {
            strategy: "ipab-prebuild",
            typecheck: [
              { config: "tsconfig.json", entry: "src/main.ts" },
              { config: "tsconfig.browser.json", entry: "src/browser.ts" },
            ],
          },
        }),
      );
      const pkgPath = join(project, "package.json");
      const pkg = object(
        JSON.parse(await readFile(pkgPath, "utf8")) as unknown,
        "package",
      );
      await writeFile(
        pkgPath,
        JSON.stringify({
          ...pkg,
          scripts: {
            build: "node forbidden-build.cjs",
            "ipab-prebuild": "node compile.cjs",
          },
        }),
      );
      await writeFile(
        join(project, "compile.cjs"),
        `
const { mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const out = process.env.IPAB_BUILD_DIR;
writeFileSync("dist/hook-ran", "yes");
mkdirSync(join(out, "server"));
mkdirSync(join(out, "web"));
writeFileSync(join(out, "server/app.cjs"), '#!/usr/bin/env node\\nconsole.log("backend");');
writeFileSync(join(out, "web/index.html"), "browser output");
`,
      );
      await expect(buildApp(project)).rejects.toThrow(
        "implicitly has an 'any'",
      );
      await expect(
        readFile(join(project, "dist", "hook-ran")),
      ).rejects.toThrow();
      await writeFile(
        join(project, "src", "browser.ts"),
        "document.body.textContent = 'browser';\n",
      );
      await writeFile(
        join(project, "tsconfig.browser.json"),
        JSON.stringify({ ...browserConfig, files: ["src/other.ts"] }),
      );
      await expect(buildApp(project)).rejects.toThrow("not included");
      await expect(
        readFile(join(project, "dist", "hook-ran")),
      ).rejects.toThrow();
      await writeFile(
        join(project, "tsconfig.browser.json"),
        JSON.stringify(browserConfig),
      );
      await mkdir(join(project, "dist"));
      await buildApp(project);
      const bundle = await loadCar(join(project, "dist", "app.car"));
      expect(
        await new Response(await bundle.readFile("resources/app.cjs")).text(),
      ).toBe('#!/usr/bin/env node\nconsole.log("backend");');
      expect(
        await new Response(
          await bundle.readFile("resources/web/index.html"),
        ).text(),
      ).toBe("browser output");
      await expect(
        bundle.readFile("resources/server/app.cjs"),
      ).rejects.toThrow();
      const appBytes = await readFile(join(project, "dist", "app.car"));
      const sourceBytes = await readFile(
        join(project, "dist", "app.source.car"),
      );
      await writeFile(
        join(project, "compile.cjs"),
        `${await readFile(join(project, "compile.cjs"), "utf8")}\nwriteFileSync("src/main.ts", "console.log('changed during hook');");`,
      );
      await expect(buildApp(project, { replace: true })).rejects.toThrow(
        "source changed",
      );
      expect(await readFile(join(project, "dist", "app.car"))).toEqual(
        appBytes,
      );
      expect(await readFile(join(project, "dist", "app.source.car"))).toEqual(
        sourceBytes,
      );
    },
  );
  it("preserves stream failures and diagnostic failures while stopping the owned hook", async () => {
    await mkdir(project);
    const output = join(project, "output");
    await mkdir(output);
    const pkg = { scripts: { "ipab-prebuild": "node wait.cjs" } };
    await writeFile(join(project, "package.json"), JSON.stringify(pkg));
    await writeFile(
      join(project, "wait.cjs"),
      'console.log("HOOK_WAITING"); setInterval(() => {}, 1000);',
    );
    const failure = new Error("Diagnostic sink failed.");
    await expect(
      runPrebuild(project, output, pkg, [], {
        diagnostic(text) {
          if (text.includes("HOOK_WAITING")) throw failure;
        },
      }),
    ).rejects.toBe(failure);
    const original =
      await vi.importActual<typeof processes>("node:child_process");
    const streamFailure = new Error("Hook stdout failed.");
    let owned: ReturnType<typeof processes.spawn> | undefined;
    vi.mocked(processes.spawn).mockImplementation((...args) => {
      const child = original.spawn(...args);
      owned = child;
      return child;
    });
    await expect(
      runPrebuild(project, output, pkg, [], {
        diagnostic(text) {
          if (text.includes("HOOK_WAITING"))
            owned!.stdout!.emit("error", streamFailure);
        },
      }),
    ).rejects.toBe(streamFailure);
    expect(owned!.exitCode !== null || owned!.signalCode !== null).toBe(true);
  }, 30_000);
  it("reports compiler stream errors instead of accepting truncated validation output", async () => {
    await initApp("hello", project);
    await projectTools(project);
    const original =
      await vi.importActual<typeof processes>("node:child_process");
    const failure = new Error("Compiler stdout failed.");
    vi.mocked(processes.spawn).mockImplementation((...args) => {
      const child = original.spawn(...args);
      child.stdout!.once("data", () => {
        child.stdout!.emit("error", failure);
      });
      return child;
    });
    await expect(buildApp(project)).rejects.toBe(failure);
    expect(
      (await readdir(project)).filter((name) => name.startsWith(".ipab-app-")),
    ).toEqual([]);
  }, 30_000);
  it("decodes hook diagnostics across UTF-8 stream chunks", async () => {
    await mkdir(project);
    const output = join(project, "output");
    await mkdir(output);
    const pkg = { scripts: { "ipab-prebuild": "node print.cjs" } };
    await writeFile(join(project, "package.json"), JSON.stringify(pkg));
    await writeFile(
      join(project, "print.cjs"),
      `
process.stdout.write(Buffer.from([0xe2, 0x82]));
setTimeout(() => process.stdout.write(Buffer.from([0xac])), 50);
process.stderr.write(Buffer.from([0xe4, 0xb8]));
setTimeout(() => process.stderr.write(Buffer.from([0xad])), 50);
`,
    );
    let text = "";
    await runPrebuild(project, output, pkg, [], {
      diagnostic(chunk) {
        text += chunk;
      },
    });
    expect(text).toContain("€");
    expect(text).toContain("中");
    expect(text).not.toContain("\ufffd");
  }, 30_000);
  it("rejects missing hooks and unsupported package managers, and cancels only the spawned hook tree", async () => {
    await mkdir(project);
    const output = join(project, "output");
    await mkdir(output);
    for (const pkg of [
      { scripts: {} },
      { scripts: { "ipab-prebuild": "" } },
      {
        scripts: { "ipab-prebuild": "node foo" },
        packageManager: "yarn@4.0.0",
      },
      { scripts: { "ipab-prebuild": "node foo" }, packageManager: "npm@0.0.0" },
    ])
      await expect(runPrebuild(project, output, pkg, [], {})).rejects.toThrow();
    const pkg = { scripts: { "ipab-prebuild": "node wait.cjs" } };
    await writeFile(join(project, "package.json"), JSON.stringify(pkg));
    await writeFile(
      join(project, "wait.cjs"),
      'console.log("HOOK_WAITING"); setInterval(() => {}, 1000);',
    );
    const controller = new AbortController();
    await expect(
      runPrebuild(project, output, pkg, [], {
        signal: controller.signal,
        diagnostic(text) {
          if (text.includes("HOOK_WAITING"))
            controller.abort(new Error("Stop hook."));
        },
      }),
    ).rejects.toThrow("Stop hook.");
    const already = AbortSignal.abort(new Error("Already stopped."));
    await expect(
      runPrebuild(project, output, pkg, [], { signal: already }),
    ).rejects.toThrow("Already stopped.");
  }, 30_000);
  it("uses active pnpm with or without a declaration, without optional lifecycle hooks", async () => {
    await mkdir(project);
    const output = join(project, "output");
    await mkdir(output);
    const workspace = object(
      JSON.parse(
        await readFile(resolve("..", "..", "package.json"), "utf8"),
      ) as unknown,
      "workspace",
    );
    const pkg = {
      packageManager: workspace.packageManager,
      scripts: {
        "ipab-prebuild": "node write.cjs",
        "preipab-prebuild": "node missing.cjs",
        "postipab-prebuild": "node missing.cjs",
      },
    };
    await writeFile(
      join(project, "write.cjs"),
      'require("node:fs").writeFileSync(require("node:path").join(process.env.IPAB_BUILD_DIR,"marker"),"pnpm hook");',
    );
    for (const declaration of [undefined, workspace.packageManager]) {
      const current = { ...pkg, packageManager: declaration };
      await writeFile(join(project, "package.json"), JSON.stringify(current));
      await runPrebuild(project, output, current, [], {});
      expect(await readFile(join(output, "marker"), "utf8")).toBe("pnpm hook");
      expect(processes.spawn).toHaveBeenLastCalledWith(
        expect.any(String),
        expect.arrayContaining([
          "--config.manage-package-manager-versions=false",
          "--config.enable-pre-post-scripts=false",
        ]),
        expect.any(Object),
      );
      await unlink(join(output, "marker"));
    }
    await expect(
      runPrebuild(
        project,
        output,
        { ...pkg, packageManager: "pnpm@0.0.0" },
        [],
        {},
      ),
    ).rejects.toThrow("Project requires pnpm@0.0.0; active pnpm is");
    await expect(readFile(join(output, "marker"))).rejects.toThrow();
  }, 30_000);
  it("skips Corepack shims without executing them and finds an installed pnpm CLI", async () => {
    await mkdir(project);
    const output = join(project, "output");
    const corepack = join(project, "corepack");
    const installed = join(project, "installed");
    await mkdir(output);
    await mkdir(join(corepack, "dist"), { recursive: true });
    await mkdir(join(installed, "node_modules"), { recursive: true });
    await writeFile(
      join(corepack, "package.json"),
      JSON.stringify({ name: "corepack" }),
    );
    const shim = join(corepack, "dist", "pnpm.js");
    const marker = join(project, "corepack-ran");
    await writeFile(
      shim,
      `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "unexpected"); process.exit(1);`,
    );
    const runner = process.env.npm_execpath!;
    const workspace = object(
      JSON.parse(
        await readFile(resolve("..", "..", "package.json"), "utf8"),
      ) as unknown,
      "workspace",
    );
    const pkg = {
      scripts: { "ipab-prebuild": "node write.cjs" },
    };
    await writeFile(join(project, "package.json"), JSON.stringify(pkg));
    await writeFile(
      join(project, "write.cjs"),
      'require("node:fs").writeFileSync(require("node:path").join(process.env.IPAB_BUILD_DIR,"marker"),"pnpm hook");',
    );
    vi.stubEnv("npm_execpath", shim);
    vi.stubEnv("PATH", dirname(process.execPath));
    for (const packageManager of [undefined, workspace.packageManager]) {
      await expect(
        runPrebuild(project, output, { ...pkg, packageManager }, [], {}),
      ).rejects.toThrow("Corepack shims are not executed");
    }
    await expect(readFile(marker)).rejects.toThrow();
    if (runner.endsWith(".exe"))
      await symlink(
        await filesystem.realpath(runner),
        join(installed, "pnpm.exe"),
      );
    else
      await symlink(
        resolve(dirname(await filesystem.realpath(runner)), ".."),
        join(installed, "node_modules", "pnpm"),
        process.platform === "win32" ? "junction" : "dir",
      );
    if (process.platform !== "win32")
      await symlink("/bin/sh", join(installed, "sh"));
    vi.stubEnv("PATH", [installed, dirname(process.execPath)].join(delimiter));
    for (const packageManager of [undefined, workspace.packageManager]) {
      await runPrebuild(project, output, { ...pkg, packageManager }, [], {});
      expect(await readFile(join(output, "marker"), "utf8")).toBe("pnpm hook");
      await unlink(join(output, "marker"));
    }
    await expect(readFile(marker)).rejects.toThrow();
  }, 30_000);
});
