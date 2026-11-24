import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { readContentConfiguration } from "@ipab/ipfs-store/node";
import type { StoreConfiguration } from "@ipab/ipfs-store";
import { HostError, object, syntax } from "./errors.js";

export type ConfigKey =
  | "store.rpc"
  | "history.enabled"
  | "history.limit"
  | "output.retention"
  | "bundle.outputDir";
export type ConfigValue = string | boolean | number | null;
export type Source = "flag" | "env" | "user" | "default";
export interface GlobalOptions {
  stateDir?: string;
  storeRpc?: string;
  json: boolean;
}
export interface ConfigItem {
  key: ConfigKey | "state-dir";
  value: ConfigValue;
  source: Source;
}
export const defaults: Record<ConfigKey, ConfigValue> = {
  "store.rpc": null,
  "history.enabled": true,
  "history.limit": 20,
  "output.retention": "history",
  "bundle.outputDir": "dist",
};
const environments: Record<ConfigKey, string> = {
  "store.rpc": "IPAB_STORE_RPC",
  "history.enabled": "IPAB_HISTORY_ENABLED",
  "history.limit": "IPAB_HISTORY_LIMIT",
  "output.retention": "IPAB_OUTPUT_RETENTION",
  "bundle.outputDir": "IPAB_BUNDLE_OUTPUT_DIR",
};

export function configKey(key: string): ConfigKey {
  if (!Object.hasOwn(defaults, key))
    syntax(`Unknown configuration key "${key}".`);
  return key as ConfigKey;
}

export function publicUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    syntax(
      "Store URL must be an HTTP(S) URL without credentials, query or fragment.",
    );
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    syntax(
      "Store URL must be an HTTP(S) URL without credentials, query or fragment.",
    );
  return url.toString();
}

export function parseValue(
  key: ConfigKey,
  value: unknown,
  text = false,
): ConfigValue {
  if (text && typeof value === "string") {
    if (key === "history.enabled") {
      if (value === "true") return true;
      if (value === "false") return false;
    }
    if (key === "history.limit" && /^[1-9]\d*$/.test(value))
      value = Number(value);
    if (key === "store.rpc" && value === "default") return null;
  }
  if (key === "store.rpc" && value === null) return null;
  if (
    key === "bundle.outputDir" &&
    typeof value === "string" &&
    value.trim() &&
    !value.includes("\0")
  )
    return value;
  if (key === "store.rpc" && typeof value === "string") return publicUrl(value);
  if (key === "history.enabled" && typeof value === "boolean") return value;
  if (
    key === "history.limit" &&
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0
  )
    return value;
  if (key === "output.retention" && (value === "history" || value === "none"))
    return value;
  syntax(
    `Invalid value for ${key}; expected ${
      key === "history.enabled"
        ? "true or false"
        : key === "history.limit"
          ? "a positive safe integer"
          : key === "output.retention"
            ? "history or none"
            : key === "bundle.outputDir"
              ? "a nonempty directory path"
              : "a public HTTP(S) URL or default"
    }.`,
  );
}

export function validateUserConfig(
  value: unknown,
): Partial<Record<ConfigKey, ConfigValue>> {
  const record = object(value, "user configuration");
  const result: Partial<Record<ConfigKey, ConfigValue>> = {};
  try {
    for (const [key, value] of Object.entries(record))
      result[configKey(key)] = parseValue(configKey(key), value);
  } catch {
    throw new HostError(
      "Malformed user configuration; inspect the state database configuration.",
    );
  }
  return result;
}

export function stateLocation(
  flags: GlobalOptions,
  env: NodeJS.ProcessEnv = process.env,
): { path: string; source: Source } {
  const value = flags.stateDir ?? env.IPAB_STATE_DIR;
  if (value !== undefined && !value.trim())
    syntax("State directory must be nonempty.");
  return {
    path: resolve(
      value ??
        (process.platform === "win32"
          ? join(
              env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"),
              "ipab",
            )
          : join(
              env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"),
              "ipab",
            )),
    ),
    source:
      flags.stateDir !== undefined
        ? "flag"
        : env.IPAB_STATE_DIR !== undefined
          ? "env"
          : "default",
  };
}

export function effectiveConfig(
  user: Partial<Record<ConfigKey, ConfigValue>>,
  flags: GlobalOptions,
  env: NodeJS.ProcessEnv = process.env,
): ConfigItem[] {
  const result = (Object.keys(defaults) as ConfigKey[]).map(
    (key): ConfigItem => {
      const variable = env[environments[key]];
      const flag = key === "store.rpc" ? flags.storeRpc : undefined;
      // Invalid lower layers are not hidden by a higher-priority override.
      const environmental =
        variable === undefined ? undefined : parseValue(key, variable, true);
      return {
        key,
        value:
          flag !== undefined
            ? parseValue(key, flag, true)
            : variable !== undefined
              ? environmental!
              : Object.hasOwn(user, key)
                ? user[key]!
                : defaults[key],
        source:
          flag !== undefined
            ? "flag"
            : variable !== undefined
              ? "env"
              : Object.hasOwn(user, key)
                ? "user"
                : "default",
      };
    },
  );
  const location = stateLocation(flags, env);
  result.push({
    key: "state-dir",
    value: location.path,
    source: location.source,
  });
  return result;
}

export async function storeConfiguration(
  rpc: ConfigValue,
): Promise<StoreConfiguration> {
  const config =
    rpc === null
      ? await readContentConfiguration()
      : { backend: "kubo" as const, apiUrl: publicUrl(String(rpc)) };
  const urls =
    config.backend === "kubo"
      ? [config.apiUrl]
      : config.gateway
        ? typeof config.gateway === "string"
          ? [config.gateway]
          : config.gateway
        : [];
  for (const url of urls) publicUrl(url);
  return config;
}
