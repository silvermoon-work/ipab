import { spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { isBuiltin } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

export async function initApp(
  name: string,
  directory = name,
  options: AuthoringOptions = {},
) {
  if (
    !/^[a-z0-9][a-z0-9._-]*$/.test(name) ||
    name.length > 214 ||
    ["node_modules", "favicon.ico"].includes(name)
  )
    throw new HostError(
      "App NAME must be an unscoped lowercase npm package name.",
    );
  const files = new Map([
    [
      "package.json",
      json({
        name,
        version: "0.0.0",
        private: true,
        type: "module",
        engines: { node: ">=22.15.0" },
        scripts: { typecheck: "tsc --noEmit", build: "ipab build" },
        devDependencies: {
          "@types/node": "26.6.6",
          typescript: "6.0.3",
        },
      }),
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
      "ipab.yaml",
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

# Metadata overrides package.json; remove an override to inherit its package value.
app:
  name: ${name}
  version: "0.0.0" # Exact SemVer, not a range.
  description: ""
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
# entry and supportedSchemas inside app are generated; do not override them.
`,
    ],
    ["src/main.ts", 'console.log("Hello from your IPAB App.");\n'],
    [".gitignore", "node_modules/\ndist/\n.ipab-app-*/\n"],
  ]);
  const schemaCid = (await builtinAppSchema()).cid.toString();
  const root = await scaffoldFiles(directory, files, options);
  return {
    kind: "app-init" as const,
    directory: root,
    name,
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
        join(root, "tsconfig.json"),
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
    const collect = (chunk: Buffer) => {
      diagnostic = (diagnostic + chunk.toString()).slice(-1024 * 1024);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.once("error", reject);
    child.once("close", (code) => {
      if (
        code === 0 &&
        diagnostic
          .split(/\r?\n/)
          .some((path) =>
            process.platform === "win32"
              ? resolve(path).toLowerCase() ===
                resolve(root, entry).toLowerCase()
              : resolve(path) === resolve(root, entry),
          )
      )
        accept();
      else
        reject(
          new HostError(
            code === 0
              ? "App entry is not included in tsconfig.json; include the selected source before building."
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
      (key) => !["entry", "resources", "supportedSchemas", "app"].includes(key),
    ) ||
    (config.supportedSchemas !== undefined &&
      !Array.isArray(config.supportedSchemas))
  )
    throw new HostError(
      `${configPath} requires entry and an explicit resources array, with optional supportedSchemas array and app metadata overrides; unknown fields are not supported.`,
    );
  const entry = relativePath(config.entry);
  if (!entry.startsWith("src/") || !entry.endsWith(".ts"))
    throw new HostError("App entry must be a .ts file under src/.");
  await readBytes(tree, entry, 16 * 1024 * 1024, options);
  const resources = new Set<string>();
  for (const item of config.resources) {
    if (typeof item !== "string")
      throw new HostError(
        "App resources must be explicit relative file paths.",
      );
    const path = relativePath(item);
    if (
      !path.startsWith("assets/") ||
      path.split("/").some((part) => part.startsWith(".")) ||
      resources.has(path)
    )
      throw new HostError(
        "Resources must be unique non-hidden files under assets/ (no globs or directories).",
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
      !icon.startsWith("resources/assets/") ||
      !resources.has(icon.slice("resources/".length))
    )
      throw new HostError(
        "App icon must reference a selected resources/assets/ file.",
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
  await typecheck(root, entry, options);
  options.signal?.throwIfAborted();
  const stage = await mkdtemp(join(root, ".ipab-app-"));
  try {
    const { build } = await import("esbuild");
    await mkdir(join(stage, "resources"));
    const program = await build({
      absWorkingDir: root,
      entryPoints: [entry],
      outfile: join(stage, "resources", "app.cjs"),
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node22.15",
      packages: "bundle",
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
      Object.values(program.metafile.outputs).some((file) =>
        file.imports.some((item) => item.external && !isBuiltin(item.path)),
      )
    )
      throw new HostError(
        "App must bundle into one self-contained .cjs of at most 8 MiB; only Node builtins may remain external.",
      );
    options.signal?.throwIfAborted();
    await writeFile(
      join(stage, "resources", "app.cjs"),
      program.outputFiles[0]!.contents,
      { flag: "wx", signal: options.signal },
    );
    await writeFile(join(stage, ".bundle.yaml"), stringify(appSchema), {
      flag: "wx",
      signal: options.signal,
    });
    await writeFile(join(stage, "app.json"), json(description), {
      flag: "wx",
      signal: options.signal,
    });
    if (supportedSchemas)
      await writeFile(
        join(stage, ...supportedSchemasPath.split("/")),
        supportedSchemas,
        { flag: "wx", signal: options.signal },
      );
    for (const path of resources) {
      const bytes = await readBytes(tree, path, 16 * 1024 * 1024, options);
      const target = join(stage, "resources", ...path.split("/"));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, bytes, { flag: "wx", signal: options.signal });
    }
    const result = await buildBundle(stage, { ...options, output });
    return { ...result, kind: "app-bundle" };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
