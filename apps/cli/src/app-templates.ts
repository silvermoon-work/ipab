import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { readBytes } from "@ipab/bundle-builder";
import { filesystemTree } from "@ipab/bundle-builder/node";
import { HostError, object } from "./errors.js";
import type { AuthoringOptions } from "./authoring.js";
import { relativePath } from "./space.js";

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

function nodeTemplate(name: string): Map<string, string | Uint8Array> {
  return new Map([
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
    ["ipab.json", json({ entry: "src/main.ts", resources: [], app: {} })],
    ["src/main.ts", 'console.log("Hello from your IPAB App.");\n'],
    [".gitignore", "node_modules/\ndist/\n.ipab-app-*/\n"],
  ]);
}

export async function appTemplate(
  selector: string,
  name: string,
  options: AuthoringOptions,
): Promise<Map<string, string | Uint8Array>> {
  if (selector === "node") return nodeTemplate(name);
  const builtin = selector === "web-app";
  if (
    !builtin &&
    !selector.includes("/") &&
    !selector.includes("\\") &&
    !selector.startsWith(".")
  )
    throw new HostError(
      `Unknown template "${selector}". Built-ins: node, web-app. Use an explicit local directory for custom templates.`,
    );
  const directory = builtin
    ? fileURLToPath(new URL("../templates/web-app/", import.meta.url))
    : resolve(selector);
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
  if (builtin) {
    const entry = fileURLToPath(import.meta.resolve("@ipab/web-app"));
    variables.webAppDependency = `file:${dirname(dirname(entry)).replaceAll("\\", "/")}`;
  }
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
