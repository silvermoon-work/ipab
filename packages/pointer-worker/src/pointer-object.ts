import { DurableObject } from "cloudflare:workers";
import {
  apiFailure,
  IDEMPOTENCY_TTL_SECONDS,
  MAX_IDEMPOTENCY_RECORDS,
  parseBody,
  parseRevision,
  ServiceError,
  type ApiFailure,
  type PointerConfig,
  type PointerState,
} from "./protocol.ts";
import { authenticate, type WireRequest } from "./verify.ts";
import { compareAndSwap, consumeNonce, type OpResult } from "./state.ts";
import { sha256Hex } from "./crypto.ts";

interface StoredPointer {
  config: PointerConfig;
  state: PointerState;
  nonces: Record<string, number>;
}
interface Retry {
  fingerprint: string;
  result: OpResult;
  expiresAt?: number;
}

export class PointerObject extends DurableObject<Env> {
  async configure(config: PointerConfig): Promise<void> {
    await this.ctx.storage.transaction(async (txn) => {
      const existing = await txn.get<StoredPointer>("pointer");
      if (existing) {
        if (
          existing.config.id !== config.id ||
          existing.config.owner !== config.owner ||
          existing.config.root !== config.root
        )
          throw new Error("configuration conflict");
        return;
      }
      await txn.put("pointer", {
        config,
        state: { root: config.root, revision: "1" },
        nonces: {},
      });
    });
  }

  async handle(request: WireRequest): Promise<OpResult | ApiFailure> {
    try {
      return await this.#handle(request);
    } catch (err) {
      if (err instanceof ServiceError) return apiFailure(err);
      throw err;
    }
  }
  async #handle(request: WireRequest): Promise<OpResult> {
    const stored = await this.ctx.storage.get<StoredPointer>("pointer");
    if (!stored)
      throw new ServiceError(404, "not_found", "pointer does not exist");
    // The owner is immutable. Authorization is anchored here, never in a router cache.
    const auth = await authenticate(
      request,
      stored.config.owner,
      this.env.POINTER_SERVICE,
      stored.config.id,
      Math.floor(Date.now() / 1000),
    );
    if (request.method === "GET" && request.body !== "")
      throw new ServiceError(400, "bad_request", "GET must not have a body");
    let root: string | undefined,
      revision: string | null = null;
    if (request.method === "PUT") {
      try {
        root = parseBody(request.body).root as string;
      } catch (err) {
        if (err instanceof ServiceError) throw err;
        throw new ServiceError(400, "bad_request", String(err));
      }
      revision = parseRevision(auth.ifMatch);
      if (!auth.ifMatch)
        throw new ServiceError(
          428,
          "precondition_required",
          'requires If-Match: "<revision>"',
        );
      if (revision === null)
        throw new ServiceError(
          400,
          "bad_request",
          "If-Match must be a single positive strong revision ETag",
        );
    }
    const retryKey =
      auth.idempotencyKey && request.method === "PUT"
        ? `retry:${await sha256Hex(JSON.stringify([auth.signer, auth.idempotencyKey]))}`
        : "";
    return this.ctx.storage.transaction(async (txn) => {
      const now = Math.floor(Date.now() / 1000);
      const current = (await txn.get<StoredPointer>("pointer"))!;
      const nonces = consumeNonce(current.nonces, auth.nonce, now);
      const records = await txn.list<Retry>({ prefix: "retry:" });
      for (const [key, record] of records) {
        const expiresAt = record.expiresAt ?? now + IDEMPOTENCY_TTL_SECONDS;
        if (record.expiresAt === undefined)
          await txn.put(key, { ...record, expiresAt });
        if (expiresAt <= now) {
          await txn.delete(key);
          records.delete(key);
        }
      }
      const prior = retryKey ? records.get(retryKey) : undefined;
      if (prior) {
        await txn.put("pointer", { ...current, nonces });
        if (prior.fingerprint !== auth.fingerprint)
          return { status: 409, state: current.state };
        return prior.result;
      }
      if (retryKey && records.size >= MAX_IDEMPOTENCY_RECORDS) {
        throw new ServiceError(
          429,
          "idempotency_capacity",
          "write idempotency capacity exhausted; wait for records to expire",
        );
      }
      const result =
        root === undefined
          ? { status: 200, state: current.state }
          : compareAndSwap(current.state, root, revision!);
      await txn.put("pointer", { ...current, nonces, state: result.state });
      if (retryKey)
        await txn.put(retryKey, {
          fingerprint: auth.fingerprint,
          result,
          expiresAt: now + IDEMPOTENCY_TTL_SECONDS,
        });
      return result;
    });
  }
}
