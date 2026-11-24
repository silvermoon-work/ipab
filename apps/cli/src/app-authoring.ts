import { spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { isBuiltin } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { compileFunction } from "node:vm";
import { stringify } from "yaml";
import { parseData } from "@ipab/bundle";
import { filesystemTree } from "@ipab/bundle-builder/node";
import { readBytes } from "@ipab/bundle-builder";
import {
  buildBundle,
  outputAvailable,
  scaffoldFiles,
  nodeError,
  type AuthoringOptions,
  type BuildResult,
} from "./authoring.js";
import { HostError, object } from "./errors.js";
import { relativePath } from "./space.js";
import {
  buildSupportedSchemas,
  supportedSchemasPath,
} from "./supported-schemas.js";
import {
  appDescription,
  appSchema,
  builtinAppSchema,
} from "./app-definition.js";
import { appTemplate } from "./app-templates.js";
import { buildChain, projectBuild, runPrebuild } from "./app-prebuild.js";

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

export async function initApp(
  name: string,
  directory = name,
  options: AuthoringOptions & {
    template?: string;
    parameters?: readonly string[];
  } = {},
) {
  if (
    !/^[a-z0-9][a-z0-9._-]*$/.test(name) ||
    name.length > 214 ||
    ["node_modules", "favicon.ico"].includes(name)
  )
    throw new HostError(
      "App NAME must be an unscoped lowercase npm package name.",
    );
  const { files, cid: templateCid } = await appTemplate(
    options.template ?? "node",
    name,
    options,
  );
  const schemaCid = (await builtinAppSchema()).cid.toString();
  const root = await scaffoldFiles(directory, files, options);
  return {
    kind: "app-init" as const,
    directory: root,
    name,
    template: options.template ?? "node",
    templateCid,
    schemaCid,
    files: [...files.keys()],
  };
}

function within(root: string, path: string): boolean {
  const part = relative(root, path);
  return !isAbsolute(part) && part !== ".." && !part.startsWith(`..${sep}`);
}

async function typecheck(
  root: string,
  entry: string,
  options: AuthoringOptions,
  config = "tsconfig.json",
) {
  const compiler = join(root, "node_modules", "typescript", "bin", "tsc");
  try {
    await lstat(compiler);
  } catch (cause) {
    if (!nodeError(cause, "ENOENT")) throw cause;
    const error = new HostError(
      "Project-local TypeScript is missing. Install this project's declared dependencies explicitly before ipab build.",
      1,
      "APP_BUILD_FAILED",
      "validation",
    );
    error.cause = cause;
    throw error;
  }
  await new Promise<void>((accept, reject) => {
    const child = spawn(
      process.execPath,
      [
        compiler,
        "--project",
        join(root, ...config.split("/")),
        "--noEmit",
        "--incremental",
        "false",
        "--composite",
        "false",
        "--strict",
        "--noCheck",
        "false",
        "--noImplicitAny",
        "--noImplicitThis",
        "--strictNullChecks",
        "--strictFunctionTypes",
        "--strictBindCallApply",
        "--strictPropertyInitialization",
        "--strictBuiltinIteratorReturn",
        "--alwaysStrict",
        "--useUnknownInCatchVariables",
        "--pretty",
        "false",
        "--listFiles",
      ],
      { cwd: root, signal: options.signal, stdio: ["ignore", "pipe", "pipe"] },
    );
    let diagnostic = "";
    let included = false;
    const selected = resolve(root, entry);
    const checkLine = (line: string) => {
      const path = resolve(root, line);
      if (
        process.platform === "win32"
          ? path.toLowerCase() === selected.toLowerCase()
          : path === selected
      )
        included = true;
    };
    let failure: Error | undefined;
    const fail = (error: unknown) => {
      failure ??=
        error instanceof Error
          ? error
          : new Error("App typecheck stream failed.", { cause: error });
      child.kill();
    };
    for (const stream of [child.stdout, child.stderr]) {
      const decoder = new StringDecoder("utf8");
      let pending = "";
      const collect = (text: string) => {
        diagnostic = (diagnostic + text).slice(-1024 * 1024);
        const lines = (pending + text).split(/\r?\n/);
        pending = lines.pop()!;
        for (const line of lines) checkLine(line);
      };
      stream.on("data", (chunk: Buffer) => {
        collect(decoder.write(chunk));
      });
      stream.once("end", () => {
        collect(decoder.end());
        checkLine(pending);
      });
      stream.once("error", fail);
    }
    child.once("error", fail);
    child.once("close", (code) => {
      if (failure) reject(failure);
      else if (options.signal?.aborted)
        reject(
          options.signal.reason instanceof Error
            ? options.signal.reason
            : new Error("App typecheck cancelled.", {
                cause: options.signal.reason as unknown,
              }),
        );
      else if (code === 0 && included) accept();
      else
        reject(
          new HostError(
            code === 0
              ? `App entry is not included in ${config}; include the selected source before building.`
              : `App typecheck failed (${String(code)}).\n${diagnostic
                  .split(/\r?\n/)
                  .filter(
                    (line) => line.includes("error TS") || !isAbsolute(line),
                  )
                  .join("\n")
                  .trim()}`,
          ),
        );
    });
  });
}

export async function buildApp(
  directory = ".",
  options: AuthoringOptions & {
    output?: string;
    outputDir?: string;
    replace?: boolean;
  } = {},
): Promise<Omit<BuildResult, "kind"> & { kind: "app-bundle" }> {
  await builtinAppSchema();
  const root = resolve(directory);
  const stat = await lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new HostError("App build requires a regular project directory.");
  const chain = await buildChain(root);
  const tree = await filesystemTree(root);
  const configurations = await Promise.all(
    ["ipab.yaml", "ipab.json"].map(async (name) => {
      try {
        await lstat(join(root, name));
        return name;
      } catch (cause) {
        if (nodeError(cause, "ENOENT")) return undefined;
        throw cause;
      }
    }),
  );
  const selected = configurations.filter((name) => name !== undefined);
  if (selected.length !== 1)
    throw new HostError(
      selected.length
        ? "Both ipab.yaml and legacy ipab.json exist. Keep exactly one App configuration file."
        : "App configuration is missing. Create ipab.yaml (or keep a legacy ipab.json).",
    );
  const configPath = selected[0]!;
  const config = object(
    parseData(
      await readBytes(tree, configPath, 64 * 1024, options),
      configPath === "ipab.yaml" ? "application/yaml" : "application/json",
    ),
    configPath,
  );
  if (
    typeof config.entry !== "string" ||
    !Array.isArray(config.resources) ||
    Object.keys(config).some(
      (key) =>
        !["entry", "resources", "supportedSchemas", "app", "build"].includes(
          key,
        ),
    ) ||
    (config.supportedSchemas !== undefined &&
      !Array.isArray(config.supportedSchemas))
  )
    throw new HostError(
      `${configPath} requires entry and an explicit resources array, with optional supportedSchemas array and app metadata overrides; unknown fields are not supported.`,
    );
  const prebuild = projectBuild(config.build);
  const entry = relativePath(config.entry);
  if (!prebuild && (!entry.startsWith("src/") || !entry.endsWith(".ts")))
    throw new HostError("App entry must be a .ts file under src/.");
  if (prebuild && !entry.endsWith(".cjs"))
    throw new HostError(
      "Prebuilt App entry must be a relative .cjs file in IPAB_BUILD_DIR.",
    );
  if (!prebuild) await readBytes(tree, entry, 16 * 1024 * 1024, options);
  const resources = new Set<string>();
  for (const item of config.resources) {
    if (typeof item !== "string")
      throw new HostError(
        "App resources must be explicit relative file paths.",
      );
    const path = relativePath(item);
    if (
      (!prebuild && !path.startsWith("assets/")) ||
      path.split("/").some((part) => part.startsWith(".")) ||
      path === entry ||
      (prebuild && (path === "app.cjs" || path.startsWith("app.cjs/"))) ||
      path.startsWith(`${entry}/`) ||
      entry.startsWith(`${path}/`) ||
      [...resources].some(
        (existing) =>
          path.startsWith(`${existing}/`) || existing.startsWith(`${path}/`),
      ) ||
      resources.has(path)
    )
      throw new HostError(
        prebuild
          ? "Prebuilt resources must be unique, non-overlapping paths separate from the entry."
          : "Resources must be unique non-hidden files under assets/ (no globs or directories).",
      );
    resources.add(path);
  }
  const schemas = new Set<string>();
  for (const item of (config.supportedSchemas ?? []) as unknown[]) {
    if (typeof item !== "string")
      throw new HostError(
        "Supported Schemas must be explicit relative file paths.",
      );
    const path = relativePath(item);
    if (
      !path.startsWith("schemas/") ||
      !path.endsWith(".json") ||
      path.split("/").some((part) => part.startsWith(".")) ||
      schemas.has(path)
    )
      throw new HostError(
        "Supported Schemas must be unique non-hidden .json files under schemas/ (no globs or directories).",
      );
    schemas.add(path);
  }
  const pkg = object(
    JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        await readBytes(tree, "package.json", 64 * 1024, options),
      ),
    ) as unknown,
    "package.json",
  );
  const defaults: Record<string, unknown> = {};
  for (const key of ["name", "version", "description", "author", "license"])
    if (pkg[key] !== undefined) defaults[key] = pkg[key];
  const overrides =
    config.app === undefined
      ? {}
      : object(config.app, "App metadata overrides");
  if (Object.hasOwn(overrides, "entry"))
    throw new HostError(
      "App metadata cannot override the compiled program entry.",
    );
  if (Object.hasOwn(overrides, "supportedSchemas"))
    throw new HostError(
      "App metadata cannot override the generated supportedSchemas declaration.",
    );
  const supportedSchemas = await buildSupportedSchemas(tree, schemas, options);
  const description = appDescription({
    ...defaults,
    ...overrides,
    entry: appSchema.entry.defaultValue.entry,
    ...(supportedSchemas ? { supportedSchemas: supportedSchemasPath } : {}),
  });
  if (description.icon !== undefined) {
    const icon = relativePath(description.icon);
    if (
      !icon.startsWith("resources/") ||
      ![...resources].some(
        (path) =>
          icon === `resources/${path}` ||
          (prebuild && icon.startsWith(`resources/${path}/`)),
      )
    )
      throw new HostError(
        prebuild
          ? "App icon must reference a selected prebuilt resource file."
          : "App icon must reference a selected resources/assets/ file.",
      );
  }
  const outputDirectory = resolve(root, options.outputDir ?? "dist");
  const output = options.output
    ? resolve(options.output)
    : join(outputDirectory, "app.car");
  if (
    !output.toLowerCase().endsWith(".car") ||
    (within(root, output) && !within(join(root, "dist"), output)) ||
    [...resources].some((path) => within(resolve(root, path), output))
  )
    throw new HostError(
      "App CAR output must end in .car and be inside project dist/ or outside the project; source files cannot be replaced.",
    );
  await outputAvailable(output, Boolean(options.replace));
  let parent = dirname(output);
  for (;;) {
    try {
      if ((await lstat(parent)).isSymbolicLink())
        throw new HostError("App output cannot traverse symbolic links.");
    } catch (cause) {
      if (!(
        cause instanceof Error &&
        "code" in cause &&
        cause.code === "ENOENT"
      ))
        throw cause;
    }
    const next = dirname(parent);
    if (next === parent) break;
    parent = next;
  }
  if (prebuild) {
    for (const check of prebuild.typecheck) {
      await readBytes(tree, check.config, 1024 * 1024, options);
      await readBytes(tree, check.entry, 16 * 1024 * 1024, options);
      await typecheck(root, check.entry, options, check.config);
    }
  } else await typecheck(root, entry, options);
  options.signal?.throwIfAborted();
  const stage = await mkdtemp(join(root, ".ipab-app-"));
  try {
    const { build } = await import("esbuild");
    const bundleStage = join(stage, "bundle");
    const input = prebuild ? join(stage, "input") : root;
    if (prebuild) {
      await mkdir(input);
      await runPrebuild(root, input, pkg, chain, options);
    }
    const inputTree = prebuild ? await filesystemTree(input) : tree;
    const prebuiltSource = prebuild
      ? await readBytes(inputTree, entry, 8 * 1024 * 1024, options)
      : undefined;
    if (prebuiltSource) {
      try {
        const source = new TextDecoder("utf-8", { fatal: true }).decode(
          prebuiltSource,
        );
        compileFunction(source.replace(/^#![^\r\n]*/, ""), [
          "exports",
          "require",
          "module",
          "__filename",
          "__dirname",
        ]);
      } catch (cause) {
        const error = new HostError(
          "Prebuilt App entry must be valid Node CommonJS; it is packaged without transformation.",
        );
        error.cause = cause;
        throw error;
      }
    }
    await mkdir(join(bundleStage, "resources"), { recursive: true });
    const program = await build({
      absWorkingDir: input,
      entryPoints: [entry],
      outfile: join(bundleStage, "resources", "app.cjs"),
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node22.15",
      packages: prebuild ? "external" : "bundle",
      metafile: true,
      write: false,
      logLevel: "silent",
      logOverride: {
        "unsupported-dynamic-import": "error",
        "unsupported-require-call": "error",
        "indirect-require": "error",
      },
    });
    if (
      program.outputFiles.length !== 1 ||
      program.outputFiles[0]!.contents.length > 8 * 1024 * 1024 ||
      (prebuild && Object.keys(program.metafile.inputs).length !== 1) ||
      Object.values(program.metafile.outputs).some((file) =>
        file.imports.some((item) => item.external && !isBuiltin(item.path)),
      )
    )
      throw new HostError(
        "App must bundle into one self-contained .cjs of at most 8 MiB; only Node builtins may remain external.",
      );
    options.signal?.throwIfAborted();
    const source = prebuiltSource ?? program.outputFiles[0]!.contents;
    await writeFile(join(bundleStage, "resources", "app.cjs"), source, {
      flag: "wx",
      signal: options.signal,
    });
    await writeFile(join(bundleStage, ".bundle.yaml"), stringify(appSchema), {
      flag: "wx",
      signal: options.signal,
    });
    await writeFile(join(bundleStage, "app.json"), json(description), {
      flag: "wx",
      signal: options.signal,
    });
    if (supportedSchemas)
      await writeFile(
        join(bundleStage, ...supportedSchemasPath.split("/")),
        supportedSchemas,
        { flag: "wx", signal: options.signal },
      );
    let resourceCount = 0;
    const copyFile = async (path: string) => {
      if (++resourceCount > 4096)
        throw new HostError("App resource file count exceeds 4096.");
      relativePath(path);
      if (path.split("/").some((part) => part.startsWith(".")))
        throw new HostError("Hidden prebuilt resources are not supported.");
      const bytes = await readBytes(inputTree, path, 16 * 1024 * 1024, options);
      const target = join(bundleStage, "resources", ...path.split("/"));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, bytes, { flag: "wx", signal: options.signal });
    };
    const copyDirectory = async (path: string): Promise<void> => {
      relativePath(path);
      if (++resourceCount > 4096)
        throw new HostError("App resource path count exceeds 4096.");
      if (path.split("/").some((part) => part.startsWith(".")))
        throw new HostError("Hidden prebuilt resources are not supported.");
      for (const item of await inputTree.list(path, options)) {
        const child = `${path}/${item.name}`;
        if (item.kind === "directory") await copyDirectory(child);
        else await copyFile(child);
      }
    };
    for (const path of resources) {
      if (
        prebuild &&
        (await lstat(join(input, ...path.split("/")))).isDirectory()
      )
        await copyDirectory(path);
      else await copyFile(path);
    }
    if (description.icon !== undefined)
      await readBytes(
        await filesystemTree(bundleStage),
        description.icon,
        16 * 1024 * 1024,
        options,
      );
    const result = await buildBundle(bundleStage, { ...options, output });
    return { ...result, kind: "app-bundle" };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
