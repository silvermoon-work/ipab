import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { lstat, readFile } from "node:fs/promises";
import { Liquid, type Template } from "liquidjs";
import {
  listTree,
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
} from "./template-definition.js";
import { builtinTemplateSource, templateSource } from "./template-source.js";
import { nodeError } from "./authoring.js";

export const builtinTemplateNames = new Map([
  ["builtin:template.node", "node"],
  ["builtin:template.web-app", "web-app"],
] as const);

function appName(name: string) {
  if (
    !/^[a-z0-9][a-z0-9._-]*$/.test(name) ||
    name.length > 214 ||
    ["node_modules", "favicon.ico"].includes(name)
  )
    throw new HostError(
      "App NAME must be an unscoped lowercase npm package name.",
    );
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
  if (selector === "node" || selector === "web-app") {
    appName(name);
    const loaded = await builtinTemplateSource(selector, options);
    const parameters = [...(options.parameters ?? [])];
    if (
      selector === "web-app" &&
      !parameters.some((value) => value.startsWith("webAppDependency="))
    ) {
      const framework = object(
        JSON.parse(
          await readFile(
            fileURLToPath(import.meta.resolve("@ipab/web-app/package.json")),
            "utf8",
          ),
        ) as unknown,
        "Web App framework package",
      );
      if (typeof framework.version !== "string" || !framework.version.trim())
        throw new HostError(
          "Web App framework package is missing its version.",
        );
      parameters.push(`webAppDependency=${framework.version}`);
    }
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
    appName(name);
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
