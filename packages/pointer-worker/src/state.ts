import {
  ERROR_CODES,
  MAX_VALUE_BYTES,
  NONCE_TTL_SECONDS,
  type PointerState,
} from "./protocol.ts";
import type { AuthContext } from "./verify.ts";

export type PointerOp = "read" | "write";

export interface OpRequest {
  op: PointerOp;
  auth: AuthContext;
  /** For writes: the value to store. */
  value?: string;
  /** For writes: version the writer believes is current; 0 means "unset". */
  expectedVersion?: number;
  /** Optional idempotency key and a fingerprint of the signed request. */
  idempotencyKey?: string | null;
  fingerprint?: string;
}

export type OpResult =
  | {
      ok: true;
      state: PointerState;
      replayed: boolean;
      idempotent: boolean;
    }
  | {
      ok: false;
      code: string;
      message: string;
      state?: PointerState;
    };

export interface ExecuteResult {
  result: OpResult;
  /** Nonce that must be persisted together with the result. */
  nonce: { value: string; expiresAt: number };
  idempotency?: {
    key: string;
    fingerprint: string;
    response: OpResult;
    expiresAt: number;
  };
}

const EMPTY: PointerState = {
  value: "",
  version: 0,
  updatedAt: null,
  updatedBy: null,
};

const utf8Length = (s: string): number =>
  new TextEncoder().encode(s).byteLength;

const failure = (
  code: string,
  message: string,
  state?: PointerState,
): OpResult => ({
  ok: false,
  code,
  message,
  ...(state ? { state } : {}),
});

/**
 * Pure state-machine core for the Durable Object. Kept separate from the DO
 * class so it can be exercised directly in tests.
 *
 * `nonces` maps nonce -> expiry (unix seconds).
 */
export function execute(
  current: PointerState,
  nonces: Map<string, number>,
  request: OpRequest,
  nowSeconds: number,
): ExecuteResult {
  const { auth } = request;
  const nonceEntry = {
    value: auth.nonce,
    expiresAt: nowSeconds + NONCE_TTL_SECONDS,
  };

  // Replay protection first: a captured signature must never mutate anything.
  // (Idempotent replays are handled by the caller, before this function.)
  if (nonces.has(auth.nonce)) {
    return {
      result: failure(
        ERROR_CODES.replayed,
        "this request signature has already been used",
      ),
      nonce: nonceEntry,
    };
  }

  if (request.op === "read") {
    if (!auth.scope.read) {
      return {
        result: failure(
          ERROR_CODES.forbidden,
          "signer may not read the pointer",
        ),
        nonce: nonceEntry,
      };
    }
    return {
      result: { ok: true, state: current, replayed: false, idempotent: false },
      nonce: nonceEntry,
    };
  }

  if (!auth.scope.write) {
    return {
      result: failure(
        ERROR_CODES.forbidden,
        "signer may not write the pointer",
      ),
      nonce: nonceEntry,
    };
  }
  if (typeof request.value !== "string") {
    return {
      result: failure(ERROR_CODES.badRequest, "body.value must be a string"),
      nonce: nonceEntry,
    };
  }
  if (utf8Length(request.value) > MAX_VALUE_BYTES) {
    return {
      result: failure(
        ERROR_CODES.tooLarge,
        `value exceeds ${MAX_VALUE_BYTES} UTF-8 bytes`,
      ),
      nonce: nonceEntry,
    };
  }

  const expected = request.expectedVersion ?? 0;
  if (!Number.isInteger(expected) || expected < 0) {
    return {
      result: failure(
        ERROR_CODES.badRequest,
        "expectedVersion must be a non-negative integer",
      ),
      nonce: nonceEntry,
    };
  }
  if (expected !== current.version) {
    return {
      result: failure(
        ERROR_CODES.preconditionFailed,
        `optimistic lock conflict: current version is ${current.version}, your If-Match was ${expected}`,
        current,
      ),
      nonce: nonceEntry,
    };
  }

  const next: PointerState = {
    value: request.value,
    version: current.version + 1,
    updatedAt: nowSeconds,
    updatedBy: auth.subject,
  };

  const result: OpResult = {
    ok: true,
    state: next,
    replayed: false,
    idempotent: false,
  };
  const idempotency =
    request.idempotencyKey && request.fingerprint
      ? {
          key: request.idempotencyKey,
          fingerprint: request.fingerprint,
          response: result,
          // 10 minutes: long enough for a client retry storm, short enough to bound storage.
          expiresAt: nowSeconds + 600,
        }
      : undefined;

  return { result, nonce: nonceEntry, ...(idempotency ? { idempotency } : {}) };
}

export { EMPTY as EMPTY_POINTER };
