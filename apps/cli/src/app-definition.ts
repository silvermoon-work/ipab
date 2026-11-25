import { CID } from "multiformats/cid";
import { encodeSchema } from "@ipab/bundle";
import { HostError, object } from "./errors.js";
import {
  templateBuiltinAlias,
  templateSchemaCid,
} from "./template-definition.js";

export const appBuiltinAlias = "builtin:node-app.v1";
export const appSchema = {
  name: "IPAB Node App",
  description:
    "Self-contained Node CommonJS application and declarative metadata.",
  entry: {
    path: "app.json",
    contentType: "application/json",
    defaultValue: {
      name: "Untitled App",
      version: "0.0.0",
      description: "",
      entry: "resources/app.cjs",
    },
    schema: {
      $id: "urn:ipab:node-app.v1",
      type: "object",
      additionalProperties: false,
      required: ["name", "version", "entry"],
      properties: {
        name: { type: "string" },
        version: { type: "string" },
        description: { type: "string" },
        entry: { type: "string" },
        source: {
          type: "object",
          additionalProperties: false,
          required: ["cid"],
          properties: { cid: { type: "string" } },
        },
        supportedSchemas: { type: "string" },
        author: {
          type: "object",
          additionalProperties: false,
          required: ["name"],
          properties: { name: { type: "string" }, email: { type: "string" } },
        },
        license: { type: "string" },
        icon: { type: "string" },
        i18n: {
          type: "object",
          additionalProperties: {
            type: "object",
            additionalProperties: false,
            properties: {
              name: { type: "string" },
              description: { type: "string" },
            },
          },
        },
      },
    },
  },
} as const;

// This is the canonical full definition, not a separate identity for the alias.
export const appSchemaCid = CID.parse(
  "bafyreif6sc6dlltoddzfwdqcfgfaaquhrmjccu7wsmkqf6m62ruoxy43pq",
);
export const builtinTypes: ReadonlyMap<string, string> = new Map([
  [appBuiltinAlias, appSchemaCid.toString()],
  [templateBuiltinAlias, templateSchemaCid.toString()],
]);
export async function builtinAppSchema() {
  const block = await encodeSchema(appSchema);
  if (!block.cid.equals(appSchemaCid))
    throw new HostError(
      "Builtin App definition does not match its canonical CID.",
    );
  return block;
}
export function schemaAlias(source: string): string {
  if (!source.startsWith("builtin:")) return source;
  const cid = builtinTypes.get(source);
  if (!cid) throw new HostError(`Unknown builtin type alias: ${source}.`);
  return cid;
}

export interface AppDescription {
  name: string;
  version: string;
  description: string;
  entry: string;
  source?: { cid: string };
  supportedSchemas?: string;
  author?: { name: string; email?: string };
  license?: string;
  icon?: string;
  i18n?: Record<string, { name?: string; description?: string }>;
}
function nonblank(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > 1024)
    throw new HostError(
      `${label} must be a nonblank string of at most 1024 characters.`,
    );
}
function version(value: string): boolean {
  const match =
    /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/.exec(
      value,
    );
  return Boolean(
    match &&
    match.slice(1, 4).every((part) => part === "0" || !part.startsWith("0")) &&
    (!match[4] ||
      match[4]
        .split(".")
        .every(
          (part) =>
            part &&
            (!/^\d+$/.test(part) || part === "0" || !part.startsWith("0")),
        )) &&
    (!match[5] || match[5].split(".").every(Boolean)),
  );
}
export function appDescription(value: unknown): AppDescription {
  const item = object(value, "App metadata");
  if (
    Object.keys(item).some(
      (key) =>
        ![
          "name",
          "version",
          "description",
          "entry",
          "source",
          "supportedSchemas",
          "author",
          "license",
          "icon",
          "i18n",
        ].includes(key),
    ) ||
    typeof item.entry !== "string" ||
    (item.description !== undefined && typeof item.description !== "string")
  )
    throw new HostError("Invalid App metadata fields.");
  nonblank(item.name, "App name");
  nonblank(item.version, "App version");
  if (!version(item.version))
    throw new HostError(
      "App version must be a SemVer 2.0 version, not a range.",
    );
  let author: AppDescription["author"];
  if (item.author !== undefined) {
    const value = object(item.author, "App author");
    nonblank(value.name, "Author name");
    if (Object.keys(value).some((key) => !["name", "email"].includes(key)))
      throw new HostError("Unknown App author field.");
    if (value.email !== undefined) {
      nonblank(value.email, "Author email");
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.email))
        throw new HostError(
          "Author email must be a simple name@domain address.",
        );
    }
    author = {
      name: value.name,
      ...(value.email !== undefined ? { email: value.email } : {}),
    };
  }
  if (item.license !== undefined) nonblank(item.license, "App license");
  if (item.icon !== undefined) nonblank(item.icon, "App icon");
  if (item.supportedSchemas !== undefined)
    nonblank(item.supportedSchemas, "App supportedSchemas");
  let source: AppDescription["source"];
  if (item.source !== undefined) {
    const value = object(item.source, "App source");
    if (
      typeof value.cid !== "string" ||
      Object.keys(value).some((key) => key !== "cid")
    )
      throw new HostError("App source requires only an exact Bundle CID.");
    let cid: CID;
    try {
      cid = CID.parse(value.cid);
    } catch (cause) {
      const error = new HostError(
        "App source.cid must be an exact Bundle CID.",
      );
      error.cause = cause;
      throw error;
    }
    if (
      cid.version !== 1 ||
      ![0x55, 0x70].includes(cid.code) ||
      cid.multihash.code !== 0x12 ||
      cid.multihash.size !== 32 ||
      cid.toString() !== value.cid
    )
      throw new HostError(
        "App source.cid must be a canonical CIDv1 UnixFS SHA-256 CID.",
      );
    source = { cid: value.cid };
  }
  let i18n: AppDescription["i18n"];
  if (item.i18n !== undefined) {
    const translations = object(item.i18n, "App i18n");
    i18n = {};
    const languages = new Set<string>();
    for (const [language, value] of Object.entries(translations)) {
      let canonical: string;
      try {
        canonical = Intl.getCanonicalLocales(language)[0]!;
      } catch (cause) {
        const error = new HostError(`Invalid i18n language tag: ${language}.`);
        error.cause = cause;
        throw error;
      }
      if (languages.has(canonical))
        throw new HostError(`Duplicate i18n language tag: ${language}.`);
      languages.add(canonical);
      const translation = object(value, "App translation");
      if (
        Object.keys(translation).some(
          (key) => !["name", "description"].includes(key),
        ) ||
        (translation.description !== undefined &&
          typeof translation.description !== "string")
      )
        throw new HostError(
          "Translations may contain only name and description strings.",
        );
      if (translation.name !== undefined)
        nonblank(translation.name, "Translated name");
      i18n[language] = {
        ...(translation.name !== undefined ? { name: translation.name } : {}),
        ...(translation.description !== undefined
          ? { description: translation.description }
          : {}),
      };
    }
  }
  return {
    name: item.name,
    version: item.version,
    entry: item.entry,
    description: item.description ?? "",
    ...(source !== undefined ? { source } : {}),
    ...(author !== undefined ? { author } : {}),
    ...(item.license !== undefined ? { license: item.license } : {}),
    ...(item.icon !== undefined ? { icon: item.icon } : {}),
    ...(item.supportedSchemas !== undefined
      ? { supportedSchemas: item.supportedSchemas }
      : {}),
    ...(i18n !== undefined ? { i18n } : {}),
  };
}
