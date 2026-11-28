import { lstat, mkdir } from "node:fs/promises";
import { accountIdentity, secureNew } from "./identity.js";
import { kuboBinary, KUBO_VERSION } from "./kubo.js";
import { keyId } from "@ipab/bundle/pointer/crypto";
import { HostError } from "./errors.js";

export async function setupDevice(stateDir: string, env: NodeJS.ProcessEnv) {
  const created = await mkdir(stateDir, { recursive: true, mode: 0o700 });
  if (created) await secureNew(stateDir, true);
  const directory = await lstat(stateDir);
  if (!directory.isDirectory() || directory.isSymbolicLink())
    throw new HostError("Setup state directory must be a regular directory.");
  const binary = await kuboBinary(stateDir);
  const identity = await accountIdentity(env, true);
  return {
    kuboVersion: KUBO_VERSION,
    binary,
    publicKey: identity.publicKey,
    fingerprint: await keyId(identity.publicKey),
  };
}
