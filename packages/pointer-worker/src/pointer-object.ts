import { DurableObject } from "cloudflare:workers";
import {
  ERROR_CODES,
  MAX_NONCES,
  NONCE_TTL_SECONDS,
  type PointerConfig,
  type PointerState,
} from "./protocol.ts";
import {
  EMPTY_POINTER,
  execute,
  type ExecuteResult,
  type OpRequest,
  type OpResult,
} from "./state.ts";

interface IdempotencyRecord {
  fingerprint: string;
  response: OpResult;
  expiresAt: number;
}

const KEY_CONFIG = "config";
const KEY_STATE = "state";
const KEY_NONCES = "nonces";
const KEY_IDEMPOTENCY = "idempotency";
const MAX_IDEMPOTENCY_RECORDS = 200;

/**
 * Single Durable Object instance holding the one global pointer.
 *
 * All reads and writes are serialized by the runtime, which is what makes the
 * compare-and-swap (optimistic lock) exact: no two writers can both observe
 * version N and commit version N+1.
 */
export class PointerObject extends DurableObject {
  #config: PointerConfig | null = null;
  #state: PointerState = EMPTY_POINTER;
  #nonces = new Map<string, number>();
  #idempotency = new Map<string, IdempotencyRecord>();
  #ready: Promise<void>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#ready = ctx.blockConcurrencyWhile(async () => {
      const [config, state, nonces, idempotency] = await Promise.all([
        this.ctx.storage.get<PointerConfig>(KEY_CONFIG),
        this.ctx.storage.get<PointerState>(KEY_STATE),
        this.ctx.storage.get<Record<string, number>>(KEY_NONCES),
        this.ctx.storage.get<Record<string, IdempotencyRecord>>(
          KEY_IDEMPOTENCY,
        ),
      ]);
      if (config) this.#config = config;
      if (state) this.#state = state;
      this.#nonces = new Map(Object.entries(nonces ?? {}));
      this.#idempotency = new Map(Object.entries(idempotency ?? {}));
    });
  }

  /** Configuration set by the admin API, or null for an unprovisioned instance. */
  async getConfig(): Promise<PointerConfig | null> {
    await this.#ready;
    return this.#config;
  }

  /** First-time provisioning. Returns false if the instance is already configured. */
  async configure(config: PointerConfig): Promise<boolean> {
    await this.#ready;
    if (this.#config) return false;
    this.#config = config;
    await this.ctx.storage.put(KEY_CONFIG, config);
    return true;
  }

  /** Changes the pinned anchor while keeping the value and version. */
  async rotate(pubkey: string): Promise<PointerConfig | null> {
    await this.#ready;
    if (!this.#config) return null;
    this.#config = { ...this.#config, pubkey };
    await this.ctx.storage.put(KEY_CONFIG, this.#config);
    return this.#config;
  }

  /** Deletes configuration, value, nonces and idempotency records. */
  async destroy(): Promise<void> {
    await this.#ready;
    await this.ctx.storage.deleteAll();
    this.#config = null;
    this.#state = EMPTY_POINTER;
    this.#nonces.clear();
    this.#idempotency.clear();
  }

  /** Current pointer state. Only exposed through the admin API. */
  async status(): Promise<PointerState> {
    await this.#ready;
    return this.#state;
  }

  /**
   * Authenticated read or write. Called only by the Worker, after signature and
   * scope verification. Nonce consumption, the optimistic-lock check and the
   * state write happen in one serialized turn.
   */
  async execute(request: OpRequest, nowSeconds: number): Promise<OpResult> {
    await this.#ready;
    if (!this.#config) {
      return {
        ok: false,
        code: ERROR_CODES.unknownPointer,
        message: "pointer is not configured",
      };
    }

    // Idempotent retry: same key + same request fingerprint -> cached result.
    // Checked before the nonce so a retry does not need a new nonce.
    if (request.idempotencyKey) {
      const prior = this.#idempotency.get(request.idempotencyKey);
      if (prior) {
        if (
          prior.expiresAt > nowSeconds &&
          prior.fingerprint === request.fingerprint
        ) {
          if (!prior.response.ok) return prior.response;
          return { ...prior.response, idempotent: true, replayed: false };
        }
        if (prior.expiresAt > nowSeconds) {
          return {
            ok: false,
            code: "idempotency_conflict",
            message: "this Idempotency-Key was used for a different request",
          };
        }
      }
    }

    const outcome: ExecuteResult = execute(
      this.#state,
      this.#nonces,
      request,
      nowSeconds,
    );

    // Commit: state change + nonce + idempotency record in one storage write.
    const writes: Promise<void>[] = [];
    if (outcome.result.ok) {
      this.#state = outcome.result.state;
      writes.push(this.ctx.storage.put(KEY_STATE, this.#state));
    }

    this.#rememberNonce(outcome.nonce);
    // Persist the whole nonce set (bounded, ~120 entries in steady state).
    writes.push(
      this.ctx.storage.put(KEY_NONCES, Object.fromEntries(this.#nonces)),
    );

    if (outcome.idempotency) {
      this.#idempotency.set(outcome.idempotency.key, {
        fingerprint: outcome.idempotency.fingerprint,
        response: outcome.idempotency.response,
        expiresAt: outcome.idempotency.expiresAt,
      });
      this.#pruneIdempotency(nowSeconds);
      writes.push(
        this.ctx.storage.put(
          KEY_IDEMPOTENCY,
          Object.fromEntries(this.#idempotency),
        ),
      );
    }

    await Promise.all(writes);
    return outcome.result;
  }

  #rememberNonce(entry: { value: string; expiresAt: number }): void {
    // Drop expired entries so the map stays around the size of the live window.
    for (const [nonce, expiresAt] of this.#nonces) {
      if (expiresAt <= entry.expiresAt - NONCE_TTL_SECONDS)
        this.#nonces.delete(nonce);
    }
    this.#nonces.set(entry.value, entry.expiresAt);
    if (this.#nonces.size <= MAX_NONCES) return;
    // Safety valve only: drop the soonest-to-expire entries first.
    const sorted = [...this.#nonces.entries()].sort((a, b) => a[1] - b[1]);
    for (let i = 0; i < sorted.length - MAX_NONCES; i++)
      this.#nonces.delete(sorted[i]![0]);
  }

  #pruneIdempotency(nowSeconds: number): void {
    for (const [key, record] of this.#idempotency) {
      if (record.expiresAt <= nowSeconds) this.#idempotency.delete(key);
    }
    if (this.#idempotency.size > MAX_IDEMPOTENCY_RECORDS) {
      const oldest = [...this.#idempotency.entries()].sort(
        (a, b) => a[1].expiresAt - b[1].expiresAt,
      );
      for (let i = 0; i < oldest.length - MAX_IDEMPOTENCY_RECORDS; i++) {
        this.#idempotency.delete(oldest[i]![0]);
      }
    }
  }
}
