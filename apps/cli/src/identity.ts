import { lstat, mkdir, open, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  protectAccountOnly,
  requireAccountOnly,
  requireAccountOnlyMany,
} from "@ipab/bundle/pointer/protected-files";
import {
  generateKeyPair,
  importPrivateKeyPkcs8,
  importPublicKeyRaw,
  signEd25519,
  verifyEd25519,
} from "@ipab/bundle/pointer/crypto";
import { HostError, object } from "./errors.js";
import { nodeError } from "./authoring.js";

export interface Identity {
  publicKey: string;
  privateKey: string;
}

export async function protectedPath(
  path: string,
  directory = false,
): Promise<void> {
  await regularPath(path, directory);
  await requireAccountOnly(path);
}

async function regularPath(path: string, directory: boolean): Promise<void> {
  const stat = await lstat(path);
  if (
    stat.isSymbolicLink() ||
    (directory ? !stat.isDirectory() : !stat.isFile())
  )
    throw new HostError(
      "Credential path is not a regular account-owned file/directory.",
    );
}

export async function secureNew(
  path: string,
  directory = false,
): Promise<void> {
  await regularPath(path, directory);
  await protectAccountOnly(path);
}

export async function readIdentityFile(path: string): Promise<Identity> {
  await protectedPath(path);
  return decodeIdentityFile(path);
}
async function decodeIdentityFile(path: string): Promise<Identity> {
  let value: Record<string, unknown>;
  try {
    const stat = await lstat(path);
    if (stat.size > 16 * 1024) throw new Error("oversized");
    value = object(
      JSON.parse(await readFile(path, "utf8")) as unknown,
      "identity",
    );
  } catch {
    throw new HostError(
      "Invalid credential encoding. Restore the existing protected key file.",
    );
  }
  if (
    typeof value.publicKey !== "string" ||
    typeof value.privateKey !== "string"
  )
    throw new HostError(
      "Invalid identity. Restore the existing key; do not initialize a replacement.",
    );
  const key = await importPrivateKeyPkcs8(value.privateKey);
  const proof = await signEd25519(key, "IPAB identity consistency");
  if (
    !(await verifyEd25519(
      await importPublicKeyRaw(value.publicKey),
      proof,
      "IPAB identity consistency",
    ))
  )
    throw new HostError("Identity public and private keys do not match.");
  return { publicKey: value.publicKey, privateKey: value.privateKey };
}

export async function accountIdentity(
  env: NodeJS.ProcessEnv,
  initialize = false,
): Promise<Identity> {
  const home = resolve(env.HOME ?? env.USERPROFILE ?? homedir());
  const parent = join(home, ".ipab");
  const directory = join(parent, "identity");
  try {
    await lstat(directory);
  } catch (cause) {
    if (!nodeError(cause, "ENOENT")) throw cause;
    if (!initialize)
      throw new HostError(
        "No account identity. Start with swarm create or swarm request.",
      );
    const created = await mkdir(parent, { recursive: true, mode: 0o700 });
    if (created) await secureNew(parent, true);
    else await protectedPath(parent, true);
    if ((await lstat(parent)).isSymbolicLink())
      throw new HostError("Identity parent must not be a symbolic link.");
    await mkdir(directory, { mode: 0o700 });
    await secureNew(directory, true);
    const pair = await generateKeyPair();
    const file = join(directory, "key.json");
    const handle = await open(file, "wx", 0o600);
    try {
      await handle.writeFile(
        JSON.stringify({
          publicKey: pair.publicRaw,
          privateKey: pair.privatePkcs8,
        }),
      );
      await handle.sync();
    } finally {
      await handle.close();
    }
    await secureNew(file);
  }
  const file = join(directory, "key.json");
  await regularPath(parent, true);
  await regularPath(directory, true);
  await regularPath(file, false);
  await requireAccountOnlyMany([parent, directory, file]);
  return decodeIdentityFile(file);
}
