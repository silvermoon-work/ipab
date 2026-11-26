import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
import { CID } from "multiformats/cid";
import { CarWriter } from "@ipld/car/writer";
import { encodeBundleCar, memoryTree } from "@ipab/bundle-builder";
import { encodeSchema } from "@ipab/bundle";
import { initApp } from "../src/app-authoring.js";
import { appTemplate, renderTemplate } from "../src/app-templates.js";
import {
  buildBundle,
  inspectBundle,
  readCar,
  scaffoldFiles,
} from "../src/authoring.js";
import {
  builtinTemplateSchema,
  templateDefinition,
  templateParameters,
  templateSchema,
  templateBuiltinAlias,
} from "../src/template-definition.js";
import {
  builtinTemplateSource,
  templateSource,
} from "../src/template-source.js";
import { object } from "../src/errors.js";
import { State } from "../src/state.js";
import { builtinContent } from "../src/builtins.js";
import { pinDetails } from "../src/pins.js";
import { cli, fixture } from "./helpers.js";

const encode = (value: string) => new TextEncoder().encode(value);
const definition = {
  version: 1,
  root: "project",
  render: { suffix: ".liquid" },
  parameters: {
    name: { type: "string", required: true },
    description: { type: "string", default: "" },
  },
};
const tree = (
  files: readonly (readonly [string, string | Uint8Array])[],
  entry: unknown = definition,
) =>
  memoryTree(
    new Map([
      ["template.yaml", encode(stringify(entry))],
      ...files.map(
        ([path, bytes]) =>
          [
            `project/${path}`,
            typeof bytes === "string" ? encode(bytes) : bytes,
          ] as const,
      ),
    ]),
  );

describe("Data-only Template Bundles", () => {
  let work: Awaited<ReturnType<typeof fixture>>;
  beforeEach(async () => {
    work = await fixture();
    const configuration = join(work.root, "store.json");
    await writeFile(configuration, JSON.stringify(work.store.configuration));
    vi.stubEnv("TASK_CONTENT_CONFIG", configuration);
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await work.cleanup();
  });
  it("delivers the official Web App as the same extensible Bundle through builtin, CAR and CID", async () => {
    const source = fileURLToPath(
      new URL("../../../templates/web-app/", import.meta.url),
    );
    const entry = fileURLToPath(import.meta.resolve("@ipab/web-app"));
    const parameters = [
      `webAppDependency=file:${dirname(dirname(entry)).replaceAll("\\", "/")}`,
      'description=Plain <text> with "quotes"',
    ];
    const built = await buildBundle(source, {
      output: join(work.root, "web-template.car"),
    });
    const expected = await appTemplate("web-app", "web-demo", { parameters });
    expect(expected.cid).toBe(built.cid);
    const local = await appTemplate(source, "web-demo", { parameters });
    const car = await appTemplate(built.output, "web-demo", { parameters });
    const loaded = await readCar(built.output, {});
    const remote = await appTemplate(built.cid, "web-demo", {
      parameters,
      resolveCid: loaded.resolveCid,
    });
    expect(local).toEqual(expected);
    expect(car).toEqual(expected);
    expect(remote).toEqual(expected);
    expect(
      JSON.parse(String(expected.files.get("package.json"))),
    ).toMatchObject({
      description: 'Plain <text> with "quotes"',
      scripts: {
        build: "ipab build",
        "ipab-prebuild": "node scripts/ipab-prebuild.mjs",
      },
    });
    await expect(appTemplate(built.output, "web-demo", {})).rejects.toThrow(
      "webAppDependency",
    );
    const framework = object(
      JSON.parse(
        await readFile(
          fileURLToPath(import.meta.resolve("@ipab/web-app/package.json")),
          "utf8",
        ),
      ) as unknown,
      "Framework package",
    );
    const builtin = await appTemplate("web-app", "web-demo", {});
    expect(
      JSON.parse(String(builtin.files.get("package.json"))) as unknown,
    ).toMatchObject({
      dependencies: { "@ipab/web-app": framework.version },
    });
    expect(expected.files.has("ipab.yaml")).toBe(true);
    expect(expected.files.has("template.yaml")).toBe(false);
    expect(expected.files.has(".bundle.yaml")).toBe(true);
  });
  it("ships both templates as deterministic CARs identical to their source directories", async () => {
    for (const selector of ["node", "web-app"] as const) {
      const source = fileURLToPath(
        new URL(`../../../templates/${selector}/`, import.meta.url),
      );
      const bundled = await builtinTemplateSource(selector);
      const local = await templateSource(source, {});
      const rebuilt = await encodeBundleCar(local.tree);
      try {
        expect(bundled.cid).toBe(local.cid);
        const bytes = new Uint8Array(
          await new Response(rebuilt.stream).arrayBuffer(),
        );
        expect(
          await readFile(
            new URL(
              `../dist/builtins/template.${selector}.car`,
              import.meta.url,
            ),
          ),
        ).toEqual(Buffer.from(bytes));
        const parameters =
          selector === "web-app" ? ["webAppDependency=0.1.0-rc.0"] : [];
        expect(
          await renderTemplate(bundled.tree, "offline-demo", { parameters }),
        ).toEqual(
          await renderTemplate(local.tree, "offline-demo", { parameters }),
        );
      } finally {
        await rebuilt.close();
      }
    }
  });
  async function bundle(
    entry: unknown = definition,
    file = "{{ name | json }}\n",
  ) {
    const root = join(work.root, "template");
    await mkdir(join(root, "project", "src"), { recursive: true });
    await writeFile(join(root, ".bundle.yaml"), stringify(templateSchema));
    await writeFile(join(root, "template.yaml"), stringify(entry));
    await writeFile(join(root, "project", "package.json.liquid"), file);
    await writeFile(
      join(root, "project", "src", "main.ts"),
      "console.log('unchanged');\r\n",
    );
    await writeFile(
      join(root, "project", ".hidden"),
      new Uint8Array([0, 255, 128]),
    );
    return root;
  }
  it("has one dedicated complete schema identity and creates the default Node project offline", async () => {
    expect(
      (await builtinTemplateSchema()).cid.equals(
        (await encodeSchema(templateSchema)).cid,
      ),
    ).toBe(true);
    const project = join(work.root, "node");
    const created = await initApp("demo", project, {
      parameters: ['description=<tag> "quoted"'],
    });
    expect(CID.parse(created.templateCid!).version).toBe(1);
    expect(
      JSON.parse(await readFile(join(project, "package.json"), "utf8")),
    ).toMatchObject({
      name: "demo",
      description: '<tag> "quoted"',
      private: true,
    });
    expect(await readFile(join(project, "ipab.yaml"), "utf8")).toContain(
      "src/main.ts",
    );
    expect(created.files).not.toContain("template.yaml");
    expect(created.kind).toBe("project-init");
    expect(created).not.toHaveProperty("schemaCid");
    expect((await inspectBundle(templateBuiltinAlias)).entry.path).toBe(
      "template.yaml",
    );
  });
  it("exposes complete read-only builtin pins and resolves their content without a Store", async () => {
    const builtins = await builtinContent();
    const names = [
      "builtin:node-app.v1",
      "builtin:project-template.v1",
      "builtin:template.node",
      "builtin:template.web-app",
    ];
    expect(builtins.pins.map((pin) => pin.name)).toEqual(names);
    const offline = ["--store-gateway", "http://127.0.0.1:1", "--json"];
    const listed = await cli(work.stateDir, [...offline, "pin", "list"]);
    expect(listed.code, listed.err).toBe(0);
    expect(JSON.parse(listed.out) as unknown).toEqual({
      items: builtins.pins.map(pinDetails),
      pending: [],
    });
    const state = new State(work.stateDir, builtins.pins);
    try {
      for (const pin of builtins.pins) {
        expect(state.resolve(pin.name)).toBe(pin.cid);
        const shown = await cli(work.stateDir, [
          ...offline,
          "pin",
          "show",
          pin.name,
        ]);
        expect(shown.code, shown.err).toBe(0);
        expect(JSON.parse(shown.out) as unknown).toMatchObject({
          name: pin.name,
          cid: pin.cid,
          builtin: true,
        });
        const inspected = await cli(work.stateDir, [
          ...offline,
          "bundle",
          "inspect",
          pin.cid,
        ]);
        expect(inspected.code, inspected.err).toBe(0);
        expect(JSON.parse(inspected.out) as unknown).toMatchObject({
          cid: pin.cid,
          schemaCid: pin.metadata!.schemaCid,
        });
        expect(() => {
          state.savePin(pin);
        }).toThrow("read-only");
        expect(() => {
          state.deletePin(pin.name);
        }).toThrow("read-only");
        for (const args of [
          ["pin", "add", pin.name, pin.cid],
          ["pin", "delete", pin.name],
          ["pin", "rename", pin.name, "new-name"],
          ["pin", "rename", "user-pin", pin.name],
        ]) {
          const result = await cli(work.stateDir, args);
          expect(result.code).toBe(2);
          expect(result.err).toContain("read-only");
        }
      }
    } finally {
      state.close();
    }
    const filtered = await cli(work.stateDir, [
      ...offline,
      "pin",
      "list",
      "--kind",
      "bundle",
      "--type",
      templateBuiltinAlias,
    ]);
    expect(JSON.parse(filtered.out) as unknown).toMatchObject({
      items: [
        { name: "builtin:template.node", builtin: true },
        { name: "builtin:template.web-app", builtin: true },
      ],
    });
    const inspected = await cli(work.stateDir, [
      ...offline,
      "bundle",
      "inspect",
      "builtin:template.web-app",
    ]);
    expect(inspected.code, inspected.err).toBe(0);
    const project = join(work.root, "builtin-web");
    const created = await cli(work.stateDir, [
      ...offline,
      "init",
      "builtin-web",
      project,
      "--template",
      "builtin:template.web-app",
    ]);
    expect(created.code, created.err).toBe(0);
    expect(await readFile(join(project, "package.json"), "utf8")).not.toContain(
      "file:",
    );
    const reopened = new State(work.stateDir);
    expect(reopened.pins()).toEqual([]);
    expect(reopened.holds()).toEqual([]);
    reopened.close();
  });
  it("loads identical local, single-root CAR and CID templates with binary and dotfile preservation", async () => {
    const source = await bundle();
    const built = await buildBundle(source);
    const car = await readCar(built.output, {});
    const loaded = await templateSource(source, {});
    expect(loaded.cid).toBe(built.cid);
    for (const selector of [source, built.output, built.cid]) {
      const selected = await appTemplate(selector, "demo", {
        resolveCid: car.resolveCid,
      });
      expect(selected.cid).toBe(built.cid);
      expect(selected.files.get("package.json")).toBe('"demo"\n');
      expect(selected.files.get(".hidden")).toEqual(
        new Uint8Array([0, 255, 128]),
      );
      expect(selected.files.get("src/main.ts")).toEqual(
        encode("console.log('unchanged');\r\n"),
      );
    }
    const created = await initApp("demo", join(work.root, "rendered"), {
      template: built.output,
    });
    expect(created.templateCid).toBe(built.cid);
    expect(await readFile(join(created.directory, ".hidden"))).toEqual(
      Buffer.from([0, 255, 128]),
    );
  });
  it("initializes non-App content through directories, CARs, CIDs and named pins without npm name semantics", async () => {
    const source = join(work.root, "markdown-template");
    await scaffoldFiles(
      source,
      new Map([
        [".bundle.yaml", stringify(templateSchema)],
        ["template.yaml", stringify(definition)],
        [
          "project/.bundle.yaml",
          stringify({
            name: "Markdown document",
            entry: { path: "README.md", contentType: "text/markdown" },
          }),
        ],
        ["project/README.md.liquid", "# {{ name }}\n{{ description }}\n"],
      ]),
    );
    const built = await buildBundle(source);
    const imported = await cli(work.stateDir, [
      "bundle",
      "import",
      built.output,
    ]);
    expect(imported.code, imported.err).toBe(0);
    const pinned = await cli(work.stateDir, [
      "pin",
      "add",
      "document-template",
      built.cid,
    ]);
    expect(pinned.code, pinned.err).toBe(0);
    for (const [index, selector] of [
      source,
      built.output,
      built.cid,
      "document-template",
    ].entries()) {
      const target = join(work.root, `document-${index}`);
      const created = await cli(work.stateDir, [
        "--json",
        "init",
        "My Document",
        target,
        "--template",
        selector,
        "--param",
        "description=Plain content",
      ]);
      expect(created.code, created.err).toBe(0);
      expect(JSON.parse(created.out) as unknown).toMatchObject({
        kind: "project-init",
        name: "My Document",
        directory: target,
        templateCid: built.cid,
        files: [".bundle.yaml", "README.md"],
      });
      expect(JSON.parse(created.out) as unknown).not.toHaveProperty(
        "schemaCid",
      );
      expect(await readFile(join(target, "README.md"), "utf8")).toBe(
        "# My Document\nPlain content\n",
      );
      expect(created.err).toContain("Next: ipab bundle build");
      expect(created.err).not.toContain("install");
      const content = await cli(work.stateDir, [
        "bundle",
        "build",
        target,
        "--no-import",
      ]);
      expect(content.code, content.err).toBe(0);
      const inspected = await inspectBundle(target);
      expect(inspected.validation.entry).toEqual({
        status: "schema-absent",
        contentType: "text/markdown",
      });
    }
    const human = await cli(work.stateDir, [
      "init",
      "Other Document",
      join(work.root, "human-document"),
      "--template",
      source,
    ]);
    expect(human.code, human.err).toBe(0);
    expect(human.out).toContain(`Template CID: ${built.cid}`);
    expect(human.out).not.toContain("App");
    expect(human.out).not.toContain("Schema CID");
  });
  it("renders real Liquid conditions, loops, filters and JSON without HTML escaping", async () => {
    const entry = {
      ...definition,
      parameters: {
        ...definition.parameters,
        enabled: { type: "boolean", required: true },
        items: { type: "json", default: ["a", "b"] },
        count: { type: "number", default: 2 },
      },
    };
    const files = await renderTemplate(
      tree(
        [
          [
            "readme.liquid",
            "{% assign title = name | upcase %}{% if enabled %}{{ title }}<tag>{% for item in items %}[{{ item }}]{% endfor %}{{ count | plus: 1 }}{% endif %}{{ description | json }}",
          ],
        ],
        entry,
      ),
      "demo",
      { parameters: ["enabled=true", 'description=a"b'] },
    );
    expect(files.get("readme")).toBe('DEMO<tag>[a][b]3"a\\"b"');
    expect(
      templateParameters(templateDefinition(encode(stringify(entry))), "demo", [
        "enabled=false",
        "items=[1,2]",
        "count=4",
      ]),
    ).toMatchObject({ enabled: false, items: [1, 2], count: 4 });
  });
  it("rejects invalid definitions, unknown, duplicate, missing and wrong-typed parameters", () => {
    const parse = (value: unknown) =>
      templateDefinition(encode(stringify(value)));
    for (const entry of [
      { ...definition, version: 2 },
      { ...definition, root: "../project" },
      { ...definition, hooks: {} },
      { ...definition, render: { suffix: ".liquid", escape: true } },
      {
        ...definition,
        parameters: {
          name: { type: "string" },
          description: definition.parameters.description,
        },
      },
      {
        ...definition,
        parameters: { ...definition.parameters, bad: { type: "function" } },
      },
      {
        ...definition,
        parameters: {
          ...definition.parameters,
          bad: { type: "number", default: "no" },
        },
      },
      {
        ...definition,
        parameters: {
          ...definition.parameters,
          constructor: { type: "string" },
        },
      },
    ])
      expect(() => parse(entry)).toThrow();
    const parsed = parse({
      ...definition,
      parameters: {
        ...definition.parameters,
        flag: { type: "boolean", required: true },
      },
    });
    for (const inputs of [
      [],
      ["unknown=x"],
      ["name=x"],
      ["flag=x"],
      ["flag=1"],
      ["flag=true", "flag=false"],
      ["bad"],
      ["flag=true", `description=${"a".repeat(65536)}`],
      ["flag=true", "description=x", "description=y"],
    ])
      expect(() => templateParameters(parsed, "demo", inputs)).toThrow();
    const json = parse({
      ...definition,
      parameters: { ...definition.parameters, data: { type: "json" } },
    });
    expect(() =>
      templateParameters(json, "demo", ['data={"__proto__":{}}']),
    ).toThrow("Unsafe");
    expect(() =>
      templateParameters(json, "demo", [
        `data=${"[".repeat(34)}0${"]".repeat(34)}`,
      ]),
    ).toThrow("deep");
    expect(templateParameters(json, "demo")).toMatchObject({ data: null });
  });
  it("rejects IO tags, unsupported filters, unknown variables, malformed Liquid and invalid UTF8", async () => {
    for (const text of [
      "{% include '../secret' %}",
      "{% render 'other' %}",
      "{% layout 'page' %}",
      "{{ name | unknown }}",
      "{{ unknown }}",
      "{% if name %}",
      "{% tablerow x in (1..2) %}{% endtablerow %}",
      "{% liquid\ninclude 'other'\n%}",
    ])
      await expect(
        renderTemplate(tree([["file.liquid", text]]), "demo", {}),
      ).rejects.toThrow();
    await expect(
      renderTemplate(
        tree([["file.liquid", new Uint8Array([255])]]),
        "demo",
        {},
      ),
    ).rejects.toThrow();
  });
  it("validates output paths and case-insensitive suffix/ancestor collisions before writing", async () => {
    for (const files of [
      [
        ["file", ""],
        ["FILE.liquid", ""],
      ],
      [
        ["dir.liquid", ""],
        ["dir/child", ""],
      ],
      [[".git/config", ""]],
      [["dist/file", ""]],
      [["node_modules/file", ""]],
      [["CON.txt", ""]],
      [[".liquid", ""]],
      [["file. .liquid", ""]],
    ] as const)
      await expect(renderTemplate(tree(files), "demo", {})).rejects.toThrow();
    await expect(renderTemplate(tree([]), "demo", {})).rejects.toThrow();
  });
  it("bounds input, path, rendering and parameter resource use and honours cancellation", async () => {
    await expect(
      renderTemplate(
        tree([["big", new Uint8Array(1024 * 1024 + 1)]]),
        "demo",
        {},
      ),
    ).rejects.toThrow();
    await expect(
      renderTemplate(
        tree(Array.from({ length: 257 }, (_, i) => [`file${i}`, ""] as const)),
        "demo",
        {},
      ),
    ).rejects.toThrow("256");
    await expect(
      renderTemplate(
        tree([
          ["file.liquid", "{% for x in (1..100000) %}{{ x }}{% endfor %}"],
        ]),
        "demo",
        {},
      ),
    ).rejects.toThrow();
    await expect(
      renderTemplate(
        tree(
          Array.from(
            { length: 9 },
            (_, i) => [`file${i}`, new Uint8Array(1024 * 1024)] as const,
          ),
        ),
        "demo",
        {},
      ),
    ).rejects.toThrow("8 MiB");
    await expect(
      renderTemplate(tree([[`${"dir/".repeat(34)}file`, ""]]), "demo", {}),
    ).rejects.toThrow("depth");
    await expect(
      renderTemplate(
        tree([
          [
            "file.liquid",
            "{% for x in (1..100) %}{{ description }}{% endfor %}",
          ],
        ]),
        "demo",
        { parameters: [`description=${"a".repeat(64000)}`] },
      ),
    ).rejects.toThrow("1 MiB");
    expect(() =>
      templateParameters(
        templateDefinition(encode(stringify(definition))),
        "a".repeat(65537),
      ),
    ).toThrow("64 KiB");
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(
      appTemplate("node", "demo", { signal: controller.signal }),
    ).rejects.toThrow("cancelled");
    const active = new AbortController();
    setImmediate(() => {
      active.abort(new Error("cancelled during rendering"));
    });
    await expect(
      renderTemplate(
        tree([
          ["file.liquid", "{% for x in (1..100000) %}{{ x }}{% endfor %}"],
        ]),
        "demo",
        { signal: active.signal },
      ),
    ).rejects.toThrow("cancelled during rendering");
  });
  it("resolves CLI named pins and provides repeatable parameters with clean JSON output", async () => {
    const source = await bundle();
    const built = await buildBundle(source);
    expect(
      (await cli(work.stateDir, ["bundle", "import", built.output])).code,
    ).toBe(0);
    expect(
      (await cli(work.stateDir, ["pin", "add", "project-template", built.cid]))
        .code,
    ).toBe(0);
    const selected = await cli(work.stateDir, [
      "--json",
      "init",
      "demo",
      join(work.root, "cli"),
      "--template",
      "project-template",
      "--param",
      "description=hello",
    ]);
    expect(selected.code, selected.err).toBe(0);
    expect(JSON.parse(selected.out)).toMatchObject({ templateCid: built.cid });
    const state = new State(work.stateDir);
    state.savePin({
      name: "pending-template",
      cid: built.cid,
      owner: "pending-test",
      status: "pending",
      metadata: null,
    });
    state.close();
    const pending = await cli(work.stateDir, [
      "init",
      "demo",
      join(work.root, "pending"),
      "--template",
      "pending-template",
    ]);
    expect(pending.code).toBe(1);
    expect(pending.err).toContain("pending");
    expect(
      (await cli(work.stateDir, ["init", "demo", "--param", "invalid"])).code,
    ).toBe(2);
    expect((await cli(work.stateDir, ["init", "--help"])).out).toContain(
      "--param",
    );
  });
  it("rejects wrong Bundle types, missing Store and incomplete CAR without writing output", async () => {
    const source = await bundle();
    await writeFile(
      join(source, ".bundle.yaml"),
      stringify({ ...templateSchema, name: "Other type" }),
    );
    await expect(appTemplate(source, "demo", {})).rejects.toThrow(
      "exact builtin",
    );
    const built = await buildBundle(source);
    await expect(appTemplate(built.output, "demo", {})).rejects.toThrow(
      "exact builtin",
    );
    const incomplete = join(work.root, "incomplete.car");
    const { writer, out } = CarWriter.create([CID.parse(built.cid)]);
    const drained = (async () => {
      const chunks: Uint8Array[] = [];
      for await (const bytes of out) chunks.push(bytes);
      return Buffer.concat(chunks);
    })();
    await writer.close();
    await writeFile(incomplete, await drained);
    await expect(appTemplate(incomplete, "demo", {})).rejects.toThrow();
    await expect(templateSource(built.cid, {})).rejects.toThrow(
      "configured Store",
    );
    await expect(
      templateSource(join(work.root, "file.txt"), {}),
    ).rejects.toThrow();
    await expect(appTemplate("unknown", "demo", {})).rejects.toThrow(
      "Unknown template",
    );
  });
});
