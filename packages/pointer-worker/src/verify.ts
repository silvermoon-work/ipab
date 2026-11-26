import {
  canonicalService,
  CLOCK_SKEW_SECONDS,
  HEADER_CERT,
  HEADER_IDEMPOTENCY,
  HEADER_NONCE,
  HEADER_SUBJECT,
  HEADER_TIMESTAMP,
  isCanonicalPublicKey,
  MAX_BODY_BYTES,
  MAX_CERT_BYTES,
  MAX_HEADERS_BYTES,
  requestSigningMessage,
  ServiceError,
} from "./protocol.ts";
import { importPublicKeyRaw, sha256Hex, verifyEd25519 } from "./crypto.ts";
import { verifyMemberCertificate } from "./certificates.ts";

export interface WireRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
  bodySha256: string;
}
export interface AuthContext {
  signer: string;
  nonce: string;
  ifMatch: string;
  idempotencyKey: string;
  fingerprint: string;
}
export async function boundedRequest(request: Request): Promise<WireRequest> {
  const url = new URL(request.url);
  if (url.search)
    throw new ServiceError(
      400,
      "bad_request",
      "query parameters are not supported",
    );
  const cert = request.headers.get(HEADER_CERT) ?? "";
  if (cert.length > MAX_CERT_BYTES)
    throw new ServiceError(413, "too_large", "certificate too large");
  let headerBytes = 0;
  for (const [name, value] of request.headers) {
    if (name.length + value.length > MAX_HEADERS_BYTES)
      throw new ServiceError(413, "too_large", "headers too large");
    headerBytes += new TextEncoder().encode(name + value).length;
    if (headerBytes > MAX_HEADERS_BYTES)
      throw new ServiceError(413, "too_large", "headers too large");
  }
  const length = request.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) {
    throw new ServiceError(413, "too_large", "body too large");
  }
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.length;
        if (size > MAX_BODY_BYTES) {
          await reader.cancel();
          throw new ServiceError(413, "too_large", "body too large");
        }
        chunks.push(chunk.value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  let body: string;
  try {
    body = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch {
    throw new ServiceError(400, "bad_request", "body must be UTF-8");
  }
  return {
    method: request.method,
    path: url.pathname,
    headers: Object.fromEntries(request.headers),
    body,
    bodySha256: await sha256Hex(bytes),
  };
}
export async function authenticate(
  request: WireRequest,
  owner: string,
  configuredService: string,
  pointerId: string,
  now: number,
): Promise<AuthContext> {
  const service = canonicalService(configuredService);
  const h = request.headers;
  const match = /^Ed25519 ([A-Za-z0-9_-]{86})$/.exec(h.authorization ?? "");
  if (!match)
    throw new ServiceError(
      401,
      "unauthorized",
      "valid Ed25519 Authorization required",
    );
  const timestampRaw = h[HEADER_TIMESTAMP] ?? "";
  const timestamp = Number(timestampRaw);
  if (!/^(0|[1-9]\d*)$/.test(timestampRaw) || !Number.isSafeInteger(timestamp))
    throw new ServiceError(
      400,
      "bad_request",
      "timestamp must be canonical integer Unix seconds",
    );
  if (Math.abs(timestamp - now) > CLOCK_SKEW_SECONDS) {
    throw new ServiceError(
      401,
      "unauthorized",
      "timestamp must be within 60 seconds",
    );
  }
  const nonce = h[HEADER_NONCE] ?? "";
  if (!/^[A-Za-z0-9_-]{22,128}$/.test(nonce))
    throw new ServiceError(
      400,
      "bad_request",
      "nonce requires at least 128 random bits encoded base64url",
    );
  const idempotencyKey = h[HEADER_IDEMPOTENCY] ?? "";
  if (idempotencyKey && !/^[\x21-\x7e]{1,200}$/.test(idempotencyKey))
    throw new ServiceError(400, "bad_request", "invalid Idempotency-Key");
  const subject = h[HEADER_SUBJECT] ?? "";
  if (!isCanonicalPublicKey(subject))
    throw new ServiceError(
      400,
      "bad_request",
      "subject must be the full canonical signing public key",
    );
  const anchor = await importPublicKeyRaw(owner);
  const encoded = h[HEADER_CERT];
  if (h["x-pointer-scope"])
    throw new ServiceError(400, "bad_request", "scopes are not supported");
  if (encoded) {
    if (!pointerId)
      throw new ServiceError(
        403,
        "forbidden",
        "creation requires direct owner proof",
      );
    const cert = await verifyMemberCertificate(
      encoded,
      anchor,
      owner,
      service,
      pointerId,
      now,
    );
    if (cert.member !== subject)
      throw new ServiceError(
        403,
        "forbidden",
        "certificate member does not match signer",
      );
  } else if (subject !== owner) {
    throw new ServiceError(
      403,
      "forbidden",
      "owner proof or owner-issued member certificate required",
    );
  }
  const bodySha256 = request.bodySha256;
  const ifMatch = h["if-match"] ?? "";
  if (
    !(await verifyEd25519(
      encoded ? await importPublicKeyRaw(subject) : anchor,
      match[1]!,
      requestSigningMessage({
        service,
        pointerId,
        method: request.method,
        path: request.path,
        bodySha256,
        ifMatch,
        idempotencyKey,
        timestamp,
        nonce,
        subject,
      }),
    ))
  )
    throw new ServiceError(401, "unauthorized", "invalid request signature");
  const fingerprint = await sha256Hex(
    JSON.stringify([
      service,
      pointerId,
      request.method,
      request.path,
      subject,
      bodySha256,
      ifMatch,
    ]),
  );
  return { signer: subject, nonce, ifMatch, idempotencyKey, fingerprint };
}
