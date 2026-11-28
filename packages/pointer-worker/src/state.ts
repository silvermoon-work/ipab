import { MAX_NONCES, NONCE_TTL_SECONDS, ServiceError } from "./protocol.ts";

export function consumeNonce(
  nonces: Record<string, number>,
  nonce: string,
  now: number,
): Record<string, number> {
  const next = Object.fromEntries(
    Object.entries(nonces).filter(([, expiry]) => expiry > now),
  );
  if (Object.hasOwn(next, nonce))
    throw new ServiceError(401, "replayed", "nonce already used");
  if (Object.keys(next).length >= MAX_NONCES)
    throw new ServiceError(
      429,
      "nonce_capacity",
      "nonce capacity exhausted; retry after expiry with a fresh proof",
    );
  next[nonce] = now + NONCE_TTL_SECONDS;
  return next;
}
