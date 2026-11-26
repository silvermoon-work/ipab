import { expect, it } from "vitest";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  accountIdentity,
  readIdentityFile,
  secureNew,
} from "../src/identity.js";
import { generateKeyPair } from "@ipab/bundle/pointer/crypto";

it(
  "reuses one HOME identity across state directories and never replaces missing or corrupt keys",
  { tags: ["release-e2e"], timeout: 60_000 },
  async () => {
    const base = resolve(".test-work");
    await mkdir(base, { recursive: true });
    const home = await mkdtemp(join(base, "identity-"));
    const env = { ...process.env, HOME: home, USERPROFILE: home };
    try {
      await expect(accountIdentity(env)).rejects.toThrow("No account identity");
      const first = await accountIdentity(env, true);
      const second = await accountIdentity(
        { ...env, IPAB_STATE_DIR: join(home, "other-state") },
        true,
      );
      expect(
        first.publicKey === second.publicKey &&
          first.privateKey === second.privateKey,
      ).toBe(true);
      const file = join(home, ".ipab", "identity", "key.json");
      const backup = `${file}.backup`;
      await rename(file, backup);
      await expect(accountIdentity(env, true)).rejects.toMatchObject({
        code: "ENOENT",
      });
      await writeFile(file, "invalid credential data", { mode: 0o600 });
      await secureNew(file);
      await expect(readIdentityFile(file)).rejects.toThrow(
        "Invalid credential encoding",
      );
      const other = await generateKeyPair();
      await writeFile(
        file,
        JSON.stringify({
          publicKey: other.publicRaw,
          privateKey: first.privateKey,
        }),
      );
      await expect(readIdentityFile(file)).rejects.toThrow("do not match");
      await rm(file);
      await rename(backup, file);
      expect((await accountIdentity(env)).publicKey === first.publicKey).toBe(
        true,
      );
      await expect(
        readIdentityFile(join(home, ".ipab", "identity")),
      ).rejects.toThrow("regular");
    } finally {
      await rm(home, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    }
  },
);
