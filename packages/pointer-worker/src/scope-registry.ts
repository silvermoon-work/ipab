import { DurableObject } from "cloudflare:workers";
import { uniqueId } from "@ipab/bundle/pointer/scope";
import { sha256Hex } from "./crypto.ts";
import { consumeNonce } from "./state.ts";
import { apiFailure, ServiceError, type ApiFailure } from "./protocol.ts";
import type { ScopeAuth } from "./scope-object.ts";

export class ScopeRegistry extends DurableObject<Env> {
  async reserve(
    owner: string,
    auth: ScopeAuth,
  ): Promise<{ id: string; owner: string } | ApiFailure> {
    const key = `creation:${await sha256Hex(auth.key)}`;
    try {
      return await this.ctx.storage.transaction(async (txn) => {
        const nonces = consumeNonce(
          (await txn.get<Record<string, number>>("nonces")) ?? {},
          auth.nonce,
          Math.floor(Date.now() / 1000),
        );
        await txn.put("nonces", nonces);
        try {
          const prior = await txn.get<{
            fingerprint: string;
            id: string;
            owner: string;
          }>(key);
          if (prior) {
            if (prior.fingerprint !== auth.fingerprint || prior.owner !== owner)
              throw new ServiceError(
                409,
                "idempotency_conflict",
                "scope creation key reused",
              );
            return { id: prior.id, owner };
          }
          const count = (await txn.get<number>("count")) ?? 0;
          if (count >= 4096)
            throw new ServiceError(
              429,
              "owner_capacity",
              "owner scope allocation limit reached",
            );
          const id = uniqueId();
          await txn.put(key, { fingerprint: auth.fingerprint, id, owner });
          await txn.put("count", count + 1);
          return { id, owner };
        } catch (cause) {
          if (cause instanceof ServiceError) return apiFailure(cause);
          throw cause;
        }
      });
    } catch (cause) {
      if (cause instanceof ServiceError) return apiFailure(cause);
      throw cause;
    }
  }
}
