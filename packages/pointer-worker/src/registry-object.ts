import { DurableObject } from "cloudflare:workers";
import { randomBytes, sha256Hex, toBase64Url } from "./crypto.ts";
import {
  apiFailure,
  IDEMPOTENCY_TTL_SECONDS,
  MAX_IDEMPOTENCY_RECORDS,
  ServiceError,
  type ApiFailure,
  type PointerConfig,
} from "./protocol.ts";
import type { AuthContext } from "./verify.ts";
import { consumeNonce } from "./state.ts";

interface Creation {
  fingerprint: string;
  config: PointerConfig;
  retryKey: string;
  /** Incomplete configurations never expire automatically. */
  expiresAt: number | null;
}
export class RegistryObject extends DurableObject<Env> {
  async reserve(
    owner: string,
    root: string,
    auth: AuthContext,
  ): Promise<PointerConfig | ApiFailure> {
    try {
      return await this.#reserve(owner, root, auth);
    } catch (err) {
      if (err instanceof ServiceError) return apiFailure(err);
      throw err;
    }
  }
  async #reserve(
    owner: string,
    root: string,
    auth: AuthContext,
  ): Promise<PointerConfig> {
    const retryKey = auth.idempotencyKey
      ? `create:${await sha256Hex(JSON.stringify([auth.signer, auth.idempotencyKey]))}`
      : "";
    const result = await this.ctx.storage.transaction(async (txn) => {
      const now = Math.floor(Date.now() / 1000);
      const nonces = consumeNonce(
        (await txn.get<Record<string, number>>("nonces")) ?? {},
        auth.nonce,
        now,
      );
      const records = await txn.list<Creation | PointerConfig>({
        prefix: "allocation:",
      });
      for (const [key, record] of records) {
        if (
          "config" in record &&
          record.expiresAt !== null &&
          record.expiresAt <= now
        ) {
          await txn.delete(key);
          if (record.retryKey) await txn.delete(record.retryKey);
          records.delete(key);
        }
      }
      const prior = retryKey ? await txn.get<Creation>(retryKey) : undefined;
      await txn.put("nonces", nonces);
      if (prior) {
        if (prior.fingerprint !== auth.fingerprint) return null;
        // Provisional v2 records without completion metadata stay pending until
        // configuration is reconfirmed; never guess that an old allocation committed.
        const recovered: Creation = {
          ...prior,
          retryKey,
          expiresAt: prior.expiresAt ?? null,
        };
        await txn.put(`allocation:${prior.config.id}`, recovered);
        await txn.put(retryKey, recovered);
        return prior.config;
      }
      if (records.size >= MAX_IDEMPOTENCY_RECORDS) {
        throw new ServiceError(
          429,
          "idempotency_capacity",
          "creation capacity exhausted; recover pending operations or wait for completed records to expire",
        );
      }
      const config: PointerConfig = {
        id: toBase64Url(randomBytes(32)),
        owner,
        root,
      };
      const record: Creation = {
        fingerprint: auth.fingerprint,
        config,
        retryKey,
        expiresAt: null,
      };
      await txn.put(`allocation:${config.id}`, record);
      if (retryKey) await txn.put(retryKey, record);
      return config;
    });
    if (!result)
      throw new ServiceError(
        409,
        "idempotency_conflict",
        "Idempotency-Key was used with a different creation body",
      );
    return result;
  }

  /** Called only after Pointer.configure has confirmed durable persistence. */
  async complete(config: PointerConfig): Promise<void> {
    await this.ctx.storage.transaction(async (txn) => {
      const key = `allocation:${config.id}`;
      const stored = await txn.get<Creation | PointerConfig>(key);
      if (!stored) return;
      let record: Creation;
      if ("config" in stored) record = stored;
      else {
        const prior = [
          ...(await txn.list<Creation>({ prefix: "create:" })),
        ].find(([, entry]) => entry.config.id === config.id);
        record = {
          config: stored,
          fingerprint: prior?.[1].fingerprint ?? "",
          retryKey: prior?.[0] ?? "",
          expiresAt: null,
        };
      }
      if (
        record.config.owner !== config.owner ||
        record.config.root !== config.root
      )
        throw new Error("creation completion conflict");
      if (record.expiresAt !== null) return;
      if (!record.retryKey) {
        await txn.delete(key);
        return;
      }
      const completed: Creation = {
        ...record,
        expiresAt: Math.floor(Date.now() / 1000) + IDEMPOTENCY_TTL_SECONDS,
      };
      await txn.put(key, completed);
      await txn.put(record.retryKey, completed);
    });
  }
}
