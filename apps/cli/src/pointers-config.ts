import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { pointerOrigin } from "@ipab/bundle/pointer/pointers";
import { fromBase64Url, toBase64Url } from "@ipab/bundle/pointer/crypto";
import { protectedPath, secureNew } from "./identity.js";
import { HostError, object } from "./errors.js";
import { nodeError } from "./authoring.js";

export interface PointersConfig {
  service?: string;
  apiKey?: string;
  keyOrigin?: string;
}
function location(env: NodeJS.ProcessEnv) {
  return join(resolve(env.HOME ?? env.USERPROFILE ?? homedir()), ".ipab");
}
export async function pointersConfig(
  env: NodeJS.ProcessEnv,
): Promise<PointersConfig> {
  const parent = location(env),
    file = join(parent, "pointers.json");
  try {
    await lstat(file);
  } catch (cause) {
    if (nodeError(cause, "ENOENT")) return {};
    throw cause;
  }
  await protectedPath(parent, true);
  await protectedPath(file);
  let fields: Record<string, unknown>;
  try {
    fields = object(
      JSON.parse(await readFile(file, "utf8")) as unknown,
      "protected pointer cfg",
    );
  } catch {
    throw new HostError(
      "Invalid protected pointer cfg; credential values are not echoed.",
    );
  }
  if (
    Object.keys(fields).some(
      (key) => !["service", "apiKey", "keyOrigin"].includes(key),
    ) ||
    (fields.service !== undefined && typeof fields.service !== "string") ||
    (fields.apiKey !== undefined &&
      (typeof fields.apiKey !== "string" ||
        !/^[A-Za-z0-9_-]{43}$/.test(fields.apiKey) ||
        toBase64Url(fromBase64Url(fields.apiKey)) !== fields.apiKey ||
        typeof fields.service !== "string" ||
        fields.keyOrigin !== fields.service))
  )
    throw new HostError("Pointer cfg has an invalid key or origin binding.");
  const cfg = fields as PointersConfig;
  if (cfg.service) cfg.service = pointerOrigin(cfg.service);
  return cfg;
}
export async function setPointersConfig(
  env: NodeJS.ProcessEnv,
  key: "pointers.service" | "pointers.apiKey",
  value: string | null,
): Promise<void> {
  const cfg = await pointersConfig(env);
  if (key === "pointers.service") {
    const service = value === null ? undefined : pointerOrigin(value);
    if (cfg.apiKey && service !== cfg.service)
      throw new HostError(
        "Reset pointers.apiKey before changing its explicitly bound service.",
      );
    if (service === undefined) delete cfg.service;
    else cfg.service = service;
  } else if (value === null) {
    delete cfg.apiKey;
    delete cfg.keyOrigin;
  } else {
    if (
      !cfg.service ||
      !/^[A-Za-z0-9_-]{43}$/.test(value) ||
      toBase64Url(fromBase64Url(value)) !== value
    )
      throw new HostError(
        "Configure pointers.service first; API key must be 32 random bytes encoded as unpadded base64url.",
      );
    cfg.apiKey = value;
    cfg.keyOrigin = cfg.service;
  }
  const parent = location(env);
  const created = await mkdir(parent, { recursive: true, mode: 0o700 });
  if (created) await secureNew(parent, true);
  else await protectedPath(parent, true);
  const temporary = join(parent, `.pointers-${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await secureNew(temporary);
    await handle.writeFile(JSON.stringify(cfg));
    await handle.sync();
    await handle.close();
    await rename(temporary, join(parent, "pointers.json"));
  } finally {
    await handle.close();
    await unlink(temporary).catch((cause: unknown) => {
      if (!nodeError(cause, "ENOENT"))
        return Promise.reject(
          cause instanceof Error
            ? cause
            : new HostError("Owned credential temporary-file cleanup failed."),
        );
      return undefined;
    });
  }
}
