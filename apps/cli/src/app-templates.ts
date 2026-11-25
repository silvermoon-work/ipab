import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { lstat } from "node:fs/promises";
import { stringify } from "yaml";
import { Liquid, type Template } from "liquidjs";
import {
  encodeBundleCar,
  listTree,
  memoryTree,
  readBytes,
  type ReadonlyFileTree,
} from "@ipab/bundle-builder";
import { filesystemTree } from "@ipab/bundle-builder/node";
import { HostError, object } from "./errors.js";
import type { AuthoringOptions } from "./authoring.js";
import { relativePath } from "./space.js";
import {
  templateDefinition,
  templateParameters,
  templateSchema,
} from "./template-definition.js";
import { templateSource } from "./template-source.js";
import { nodeError, selectedTree } from "./authoring.js";
import { sourceSchema } from "./source-bundle.js";

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

export const builtinTemplateNames = new Map([
  ["builtin:template.node", "node"],
  ["builtin:template.web-app", "web-app"],
] as const);

export async function builtinTemplateTree(
  selector: "node" | "web-app",
  options: AuthoringOptions = {},
): Promise<ReadonlyFileTree> {
  if (selector === "web-app") {
    const directory = fileURLToPath(
      new URL("../../../templates/web-app/", import.meta.url),
    );
    return selectedTree(
      directory,
      undefined,
      resolve(directory, "dist"),
      options,
    );
  }
  const encoder = new TextEncoder();
  return memoryTree(
    new Map([
      [".bundle.yaml", encoder.encode(stringify(templateSchema))],
      [
        "template.yaml",
        encoder.encode(stringify(templateSchema.entry.defaultValue)),
      ],
      ...[...nodeTemplate()].map(
        ([path, bytes]) =>
          [
            `project/${path}`,
            typeof bytes === "string" ? encoder.encode(bytes) : bytes,
          ] as const,
      ),
    ]),
  );
}

function nodeTemplate(): Map<string, string | Uint8Array> {
  return new Map([
    [".bundle.yaml", stringify(sourceSchema)],
    [
      "package.json.liquid",
      `{
  "name": {{ name | json }},
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "description": {{ description | json }},
  "engines": { "node": ">=22.15.0" },
  "scripts": { "typecheck": "tsc --noEmit", "build": "ipab build" },
  "devDependencies": { "@types/node": "26.6.6", "typescript": "6.0.3" }
}
`,
    ],
    [
      "tsconfig.json",
      json({
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          noEmit: true,
          types: ["node"],
          skipLibCheck: false,
        },
        include: ["src/**/*.ts"],
      }),
    ],
    [
      "ipab.yaml.liquid",
      `# IPAB App build configuration (data only; no hooks or JS configuration).
entry: src/main.ts

# Explicit non-hidden files under assets/; no directories, globs or symlinks.
resources: []
# To add an icon, replace [] above with the following list and create the file:
#   - assets/icon.png

# Explicit JSON complete Bundle definitions under schemas/, NOT bare JSON Schema.
# No declaration means no supported types for open; direct exec still works.
supportedSchemas: []
# To support your own type, replace [] above with this list and create the definition:
#   - schemas/note.json

# Separate source CAR; App stores only a weak source.cid, never source blocks.
# CLI --with-source / --without-source overrides this default.
build:
  includeSource: true

# Metadata overrides package.json; remove an override to inherit its package value.
app:
  name: {{ name | json }}
  version: "0.0.0" # Exact SemVer, not a range.
  description: {{ description | json }}
  # author:
  #   name: Your name
  #   email: you@example.com
  # license: MIT # Declaration only; does not restrict execution or copying.
  # icon: resources/assets/icon.png # Also select assets/icon.png in resources.
  # i18n:
  #   zh-CN:
  #     name: 你好应用
  #     description: 应用描述
  #   en:
  #     name: Hello App
  #     description: An example description
# Translations override name/description separately; missing fields fall back.
# entry, supportedSchemas and source inside app are generated; do not override them.
`,
    ],
    ["src/main.ts", 'console.log("Hello from your IPAB App.");\n'],
    [".gitignore", "node_modules/\ndist/\n.ipab-app-*/\n.env\n.env.*\n"],
  ]);
}

async function legacyTemplate(
  selector: string,
  name: string,
  options: AuthoringOptions,
): Promise<Map<string, string | Uint8Array>> {
  const directory = resolve(selector);
  const tree = await filesystemTree(directory);
  const definition = object(
    JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        await readBytes(tree, "ipab-template.json", 64 * 1024, options),
      ),
    ) as unknown,
    "App template",
  );
  if (
    definition.version !== 1 ||
    !Array.isArray(definition.files) ||
    !definition.files.length ||
    definition.files.length > 256 ||
    Object.keys(definition).some((key) => !["version", "files"].includes(key))
  )
    throw new HostError(
      "Template requires version 1 and 1..256 explicit files.",
    );
  const variables: Record<string, string> = { name };
  const files = new Map<string, string | Uint8Array>();
  let total = 0;
  for (const value of definition.files) {
    const item = object(value, "Template file");
    if (
      typeof item.source !== "string" ||
      typeof item.target !== "string" ||
      (item.render !== undefined && typeof item.render !== "boolean") ||
      Object.keys(item).some(
        (key) => !["source", "target", "render"].includes(key),
      )
    )
      throw new HostError(
        "Template file requires source, target and optional render.",
      );
    const source = relativePath(item.source);
    const target = relativePath(item.target);
    const forbidden = (path: string) =>
      path
        .split("/")
        .some((part) => ["node_modules", ".git", "dist"].includes(part));
    if (
      forbidden(source) ||
      forbidden(target) ||
      [...files.keys()].some(
        (existing) =>
          existing.toLowerCase() === target.toLowerCase() ||
          existing.toLowerCase().startsWith(`${target.toLowerCase()}/`) ||
          target.toLowerCase().startsWith(`${existing.toLowerCase()}/`),
      )
    )
      throw new HostError("Unsafe, duplicate or overlapping template paths.");
    const bytes = await readBytes(tree, source, 1024 * 1024, options);
    total += bytes.length;
    if (total > 8 * 1024 * 1024)
      throw new HostError("Template exceeds the 8 MiB total byte limit.");
    files.set(
      target,
      item.render
        ? new TextDecoder("utf-8", { fatal: true })
            .decode(bytes)
            .replace(
              /\{\{([A-Za-z][A-Za-z0-9]*)\}\}/g,
              (_match: string, key: string) => {
                const value = variables[key];
                if (value === undefined)
                  throw new HostError(`Unknown template variable ${key}.`);
                return value;
              },
            )
        : bytes,
    );
  }
  if (!files.has("package.json") || !files.has("ipab.json"))
    throw new HostError(
      "App template must produce package.json and ipab.json.",
    );
  return files;
}

function templateEngine() {
  const engine = new Liquid({
    strictVariables: true,
    strictFilters: true,
    ownPropertyOnly: true,
    templates: {},
    parseLimit: 1024 * 1024,
    renderLimit: 1000,
    memoryLimit: 1024 * 1024,
  });
  const tags = new Set([
    "assign",
    "capture",
    "if",
    "unless",
    "case",
    "for",
    "break",
    "continue",
    "cycle",
    "increment",
    "decrement",
    "comment",
    "#",
    "raw",
    "liquid",
    "echo",
  ]);
  for (const name of Object.keys(engine.tags))
    if (!tags.has(name)) delete engine.tags[name];
  const filters = new Set([
    "default",
    "append",
    "prepend",
    "capitalize",
    "downcase",
    "upcase",
    "strip",
    "lstrip",
    "rstrip",
    "replace",
    "replace_first",
    "remove",
    "remove_first",
    "split",
    "join",
    "size",
    "first",
    "last",
    "reverse",
    "sort",
    "uniq",
    "concat",
    "slice",
    "plus",
    "minus",
    "times",
    "divided_by",
    "modulo",
    "round",
    "ceil",
    "floor",
    "abs",
    "at_least",
    "at_most",
    "json",
  ]);
  for (const name of Object.keys(engine.filters))
    if (!filters.has(name)) engine.unregisterFilter(name);
  return engine;
}
async function liquidText(
  text: string,
  values: Record<string, unknown>,
  options: AuthoringOptions,
): Promise<string> {
  const engine = templateEngine();
  const render = engine.renderer.renderTemplates.bind(engine.renderer);
  let steps = 0,
    emittedBytes = 0;
  engine.renderer.renderTemplates = function* (templates, context, emitter) {
    const bounded: Template[] = templates.map((template) => ({
      token: template.token,
      *render(ctx, output): Generator<unknown, unknown, unknown> {
        if (++steps > 10_000)
          throw new HostError("Liquid exceeds 10000 rendering steps.");
        if (steps % 100 === 0)
          yield new Promise<void>((resolve) => setImmediate(resolve));
        options.signal?.throwIfAborted();
        const guarded = {
          get buffer() {
            return output.buffer;
          },
          set buffer(value: string) {
            output.buffer = value;
          },
          write(value: unknown) {
            emittedBytes += Buffer.byteLength(
              typeof value === "string"
                ? value
                : value === undefined
                  ? ""
                  : JSON.stringify(value),
            );
            if (emittedBytes > 1024 * 1024)
              throw new HostError(
                "Rendered template file exceeds 1 MiB emission budget.",
              );
            output.write(value);
          },
        };
        return yield template.render(ctx, guarded) as unknown;
      },
    }));
    return yield* render(bounded, context, emitter) as Generator<
      unknown,
      unknown,
      unknown
    >;
  };
  return (await engine.parseAndRender(text, values)) as string;
}
export async function renderTemplate(
  tree: ReadonlyFileTree,
  name: string,
  options: AuthoringOptions & { parameters?: readonly string[] },
) {
  const definition = templateDefinition(
    await readBytes(tree, "template.yaml", 64 * 1024, options),
  );
  const values = templateParameters(definition, name, options.parameters);
  const files = new Map<string, string | Uint8Array>();
  const paths = new Map<string, string>();
  let count = 0,
    total = 0;
  const collect = async (directory: string, depth: number): Promise<void> => {
    if (depth > 32)
      throw new HostError("Template project tree exceeds depth 32.");
    for (const entry of await listTree(tree, directory, options)) {
      if (++count > 256)
        throw new HostError("Template exceeds 256 project paths.");
      const source = `${directory}/${entry.name}`;
      relativePath(source);
      const original = source.slice("project/".length);
      const rendered = entry.kind === "file" && original.endsWith(".liquid");
      const target = relativePath(
        rendered ? original.slice(0, -".liquid".length) : original,
      );
      if (
        target
          .split("/")
          .some(
            (part) =>
              ["node_modules", ".git", "dist"].includes(part.toLowerCase()) ||
              /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part),
          )
      )
        throw new HostError(`Unsafe template output path: ${target}.`);
      const key = target.toLowerCase();
      if (
        paths.has(key) ||
        [...paths].some(
          ([existing, kind]) =>
            (kind === "file" && key.startsWith(`${existing}/`)) ||
            (entry.kind === "file" && existing.startsWith(`${key}/`)),
        )
      )
        throw new HostError(
          `Duplicate or overlapping template output path: ${target}.`,
        );
      paths.set(key, entry.kind);
      if (entry.kind === "directory") {
        await collect(source, depth + 1);
        continue;
      }
      const input = await readBytes(tree, source, 1024 * 1024, options);
      total += input.length;
      let output: string | Uint8Array = input;
      if (rendered) {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(input);
        options.signal?.throwIfAborted();
        output = await liquidText(text, values, options);
        options.signal?.throwIfAborted();
        if (Buffer.byteLength(output) > 1024 * 1024)
          throw new HostError("Rendered template file exceeds 1 MiB.");
        total += Buffer.byteLength(output);
      }
      if (total > 8 * 1024 * 1024)
        throw new HostError(
          "Template exceeds the 8 MiB input/output byte limit.",
        );
      files.set(target, output);
    }
  };
  await collect("project", 0);
  if (!files.size)
    throw new HostError("Template project tree must contain files.");
  return files;
}
export async function appTemplate(
  selector: string,
  name: string,
  options: AuthoringOptions & { parameters?: readonly string[] },
): Promise<{ files: Map<string, string | Uint8Array>; cid: string | null }> {
  options.signal?.throwIfAborted();
  for (const [alias, name] of builtinTemplateNames)
    if (selector === alias) selector = name;
  if (selector === "node") {
    const tree = await builtinTemplateTree("node", options);
    const encoded = await encodeBundleCar(tree, options);
    try {
      return {
        files: await renderTemplate(tree, name, options),
        cid: encoded.cid.toString(),
      };
    } finally {
      await encoded.close();
    }
  }
  if (selector === "web-app") {
    const directory = fileURLToPath(
      new URL("../../../templates/web-app/", import.meta.url),
    );
    const entry = fileURLToPath(import.meta.resolve("@ipab/web-app"));
    const parameters = [...(options.parameters ?? [])];
    if (!parameters.some((value) => value.startsWith("webAppDependency=")))
      parameters.push(
        `webAppDependency=file:${dirname(dirname(entry)).replaceAll("\\", "/")}`,
      );
    const loaded = await templateSource(directory, options);
    return {
      files: await renderTemplate(loaded.tree, name, {
        ...options,
        parameters,
      }),
      cid: loaded.cid,
    };
  }
  let legacy = false;
  try {
    await lstat(resolve(selector, ".bundle.yaml"));
  } catch (error) {
    if (!nodeError(error, "ENOENT") && !nodeError(error, "ENOTDIR"))
      throw error;
    try {
      legacy = (await lstat(resolve(selector, "ipab-template.json"))).isFile();
    } catch (error) {
      if (!nodeError(error, "ENOENT") && !nodeError(error, "ENOTDIR"))
        throw error;
    }
  }
  if (legacy) {
    if (options.parameters?.length)
      throw new HostError(
        "--param requires a Template Bundle, not a legacy mapping.",
      );
    return { files: await legacyTemplate(selector, name, options), cid: null };
  }
  try {
    const loaded = await templateSource(selector, options);
    return {
      files: await renderTemplate(loaded.tree, name, options),
      cid: loaded.cid,
    };
  } catch (error) {
    if (nodeError(error, "ENOENT"))
      throw new HostError(
        `Unknown template "${selector}". Use node, web-app, a valid Bundle directory, single-root CAR, exact CID or named pin.`,
      );
    throw error;
  }
}
