import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { protectedPath, secureNew } from "./identity.js";
import { nodeError } from "./authoring.js";
import { HostError } from "./errors.js";

export async function privateDirectory(
  parent: string,
  name: string,
): Promise<string> {
  const path = join(parent, name);
  try {
    await lstat(path);
  } catch (cause) {
    if (!nodeError(cause, "ENOENT")) throw cause;
    await mkdir(path, { mode: 0o700 });
    await secureNew(path, true);
  }
  await protectedPath(path, true);
  return path;
}
export async function readPrivate<T>(
  directory: string,
  name: string,
): Promise<T | undefined> {
  const path = join(directory, name);
  try {
    await protectedPath(path);
  } catch (cause) {
    if (nodeError(cause, "ENOENT")) return undefined;
    throw cause;
  }
  if ((await lstat(path)).size > 2 * 1024 * 1024)
    throw new HostError("Protected state is oversized.");
  return JSON.parse(await readFile(path, "utf8")) as T;
}
export async function writePrivate(
  directory: string,
  name: string,
  value: unknown,
): Promise<void> {
  const target = join(directory, name);
  const temporary = join(directory, `.write-${randomUUID()}`);
  const file = await open(temporary, "wx", 0o600);
  try {
    await secureNew(temporary);
    await file.writeFile(JSON.stringify(value));
    await file.sync();
    await file.close();
    await rename(temporary, target);
  } finally {
    await file.close();
    await unlink(temporary).catch((cause: unknown) => {
      if (!nodeError(cause, "ENOENT")) throw cause;
    });
  }
}
export async function withPrivateLock<T>(
  directory: string,
  operation: () => Promise<T>,
): Promise<T> {
  const path = join(directory, "operation.sqlite");
  try {
    const handle = await open(path, "wx", 0o600);
    await handle.close();
    await secureNew(path);
  } catch (cause) {
    if (!nodeError(cause, "EEXIST")) throw cause;
  }
  await protectedPath(path);
  const db = new DatabaseSync(path);
  let locked = false;
  try {
    db.exec("PRAGMA busy_timeout=0");
    for (let attempt = 0; attempt < 300; attempt++) {
      try {
        db.exec("BEGIN IMMEDIATE");
        locked = true;
        break;
      } catch (cause) {
        if (
          !(cause instanceof Error) ||
          !cause.message.includes("database is locked")
        )
          throw cause;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    if (!locked)
      throw new HostError(
        "Another local Swarm operation is still running; retry later.",
      );
    return await operation();
  } finally {
    if (locked) db.exec("ROLLBACK");
    db.close();
  }
}
