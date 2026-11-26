import {
  AUTH_SCHEME,
  CLOCK_SKEW_SECONDS,
  type DelegatedScope,
  ERROR_CODES,
  HEADER_CERT,
  HEADER_SCOPE,
  HEADER_SUBJECT,
  HEADER_TIMESTAMP,
  HEADER_AUDIENCE,
  type RequestProof,
  requestSigningMessage,
} from "./protocol.ts";
import {
  fromBase64Url,
  importPublicKeyRaw,
  keyId as keyIdOf,
  loadTrustAnchor,
  sha256Hex,
  verifyEd25519,
} from "./crypto.ts";
import { narrowScope, verifyCertificateChain } from "./certificates.ts";

export interface AuthEnv {
  POINTER_ROOT_PUBLIC_KEY: string;
  REQUIRE_AUDIENCE?: boolean;
}

export interface AuthContext {
  /** base64url id of the key that signed the request. For a chain, the leaf's kid. */
  keyId: string;
  /** Leaf certificate id, or null for direct anchor signing. */
  certId: string | null;
  subject: string;
  scope: DelegatedScope;
  timestamp: number;
  nonce: string;
  /** Raw If-Match header, echoed so the DO can enforce the optimistic lock. */
  ifMatch: string | null;
  /** True when the pinned anchor key signed directly (no certificate). */
  direct: boolean;
}

export type AuthResult =
  | { ok: true; auth: AuthContext; requestBody: string }
  | {
      ok: false;
      status: 400 | 401 | 403;
      code: string;
      message: string;
      details?: unknown;
    };

const b64u = (value: string): Uint8Array | null => {
  try {
    return fromBase64Url(value);
  } catch {
    return null;
  }
};

const bad = (
  status: 400 | 401 | 403,
  code: string,
  message: string,
  details?: unknown,
): AuthResult => ({
  ok: false,
  status,
  code,
  message,
  ...(details === undefined ? {} : { details }),
});

function certHeaders(request: Request): string[] {
  // Undici / the Workers runtime merge repeated headers with ", ". A base64url
  // certificate never contains a comma, so splitting is lossless.
  return (request.headers.get(HEADER_CERT) ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseRequestedScope(
  raw: string | null,
): DelegatedScope | null | "invalid" {
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return "invalid";
    }
    const scope = value as Record<string, unknown>;
    for (const key of Object.keys(scope)) {
      if (key !== "read" && key !== "write") return "invalid";
    }
    const read = scope.read;
    const write = scope.write;
    if (typeof read !== "boolean" || typeof write !== "boolean") {
      return "invalid";
    }
    // Identity comes from the signed subject header, never from a client-supplied
    // pattern, so `sub` is not accepted here.
    return { read, write };
  } catch {
    return "invalid";
  }
}

/**
 * Full request authentication. This runs before the Durable Object is touched,
 * so garbage never reaches state. Replay protection (nonce bookkeeping) is the
 * one check that must be serialized, so the DO performs it.
 */
export async function authenticate(
  request: Request,
  env: AuthEnv,
  nowSeconds: number,
): Promise<AuthResult> {
  const url = new URL(request.url);
  const path = url.pathname;
  const audience = request.headers.get(HEADER_AUDIENCE);
  if (audience !== null && audience !== url.origin)
    return bad(
      401,
      ERROR_CODES.unauthorized,
      "request audience differs from service",
    );
  if (env.REQUIRE_AUDIENCE && audience === null)
    return bad(
      401,
      ERROR_CODES.unauthorized,
      "origin-bound request proof is required",
    );

  const authorization = request.headers.get("authorization");
  if (!authorization) {
    return bad(
      401,
      ERROR_CODES.missingAuth,
      "an Authorization header is required",
    );
  }
  const [scheme, signature, ...extra] = authorization.trim().split(/\s+/);
  if (scheme !== AUTH_SCHEME || !signature || extra.length > 0) {
    return bad(
      401,
      ERROR_CODES.unauthorized,
      `expected "Authorization: ${AUTH_SCHEME} <signature>"`,
    );
  }
  const signatureBytes = b64u(signature);
  if (!signatureBytes || signatureBytes.byteLength !== 64) {
    return bad(
      401,
      ERROR_CODES.unauthorized,
      "signature must be 64 base64url bytes",
    );
  }

  const timestampRaw = request.headers.get(HEADER_TIMESTAMP);
  const timestamp = Number(timestampRaw);
  if (!timestampRaw || !Number.isInteger(timestamp)) {
    return bad(
      400,
      ERROR_CODES.badRequest,
      `${HEADER_TIMESTAMP} must be unix seconds`,
    );
  }
  if (Math.abs(nowSeconds - timestamp) > CLOCK_SKEW_SECONDS) {
    return bad(
      401,
      ERROR_CODES.unauthorized,
      `clock skew exceeds ${CLOCK_SKEW_SECONDS}s; check the signer's clock`,
    );
  }

  const nonce = request.headers.get("x-pointer-nonce") ?? "";
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(nonce)) {
    return bad(
      400,
      ERROR_CODES.badRequest,
      "x-pointer-nonce must be 16..128 URL-safe characters",
    );
  }

  // Hash exactly the bytes on the wire, before any interpretation.
  const bodyBytes = new Uint8Array(await request.arrayBuffer());
  const bodySha256 = await sha256Hex(bodyBytes);
  const bodyText = new TextDecoder().decode(bodyBytes);

  let anchor: { publicKey: CryptoKey; publicRaw: string };
  try {
    anchor = await loadTrustAnchor(env.POINTER_ROOT_PUBLIC_KEY);
  } catch (err) {
    console.error("POINTER_ROOT_PUBLIC_KEY is unusable:", err);
    return bad(401, ERROR_CODES.internal, "signing key is not configured");
  }

  const chain = certHeaders(request);
  const claimedSubject = request.headers.get(HEADER_SUBJECT) ?? "";
  if (!/^[\x20-\x7e]{1,128}$/.test(claimedSubject)) {
    return bad(
      400,
      ERROR_CODES.badRequest,
      `${HEADER_SUBJECT} (1..128 printable chars) is required`,
    );
  }

  let signerKey: CryptoKey;
  let keyId: string;
  let certId: string | null;
  let subject: string;
  let scope: DelegatedScope;
  let direct = false;

  if (chain.length === 0) {
    // Direct mode: the anchor key itself signs. No certificate, no expiry.
    signerKey = anchor.publicKey;
    keyId = anchor.publicRaw;
    certId = null;
    subject = claimedSubject;
    scope = { read: true, write: true };
    direct = true;
  } else {
    const verified = await verifyCertificateChain(
      chain,
      anchor.publicKey,
      nowSeconds,
      CLOCK_SKEW_SECONDS,
    );
    if (!verified.ok) {
      return bad(
        403,
        verified.code,
        verified.message,
        verified.index === undefined ? undefined : { index: verified.index },
      );
    }
    if (verified.leaf.sub !== claimedSubject) {
      // The key is bound to the certificate, but the certificate names somebody
      // else: the signer must not act under an identity it was not given.
      return bad(
        403,
        ERROR_CODES.forbidden,
        `${HEADER_SUBJECT} does not match the certificate subject`,
      );
    }
    if (
      (env.REQUIRE_AUDIENCE || verified.leaf.aud !== undefined) &&
      (audience === null ||
        verified.leaf.aud !== `${url.origin}/${path.split("/")[1]}`)
    )
      return bad(
        403,
        ERROR_CODES.forbidden,
        "certificate belongs to another service or variable",
      );
    signerKey = await importPublicKeyRaw(verified.leaf.pub);
    keyId = await keyIdOf(verified.leaf.pub);
    certId = verified.leaf.cid;
    subject = verified.leaf.sub;
    scope = verified.scope;
  }

  const requestedScope = parseRequestedScope(request.headers.get(HEADER_SCOPE));
  if (requestedScope === "invalid") {
    return bad(
      400,
      ERROR_CODES.badRequest,
      `${HEADER_SCOPE} must be a JSON object with boolean read/write`,
    );
  }
  const effectiveScope = narrowScope(scope, requestedScope);
  if (!effectiveScope) {
    return bad(
      403,
      ERROR_CODES.forbidden,
      "requested scope exceeds the signer's authorization",
    );
  }

  const proof: RequestProof = {
    ...(audience === null ? {} : { audience }),
    method: request.method,
    path,
    timestamp,
    nonce,
    bodySha256,
    ifMatch: request.headers.get("if-match") ?? "",
    subject,
  };

  const ok = await verifyEd25519(
    signerKey,
    signature,
    requestSigningMessage(proof),
  );
  if (!ok) {
    return bad(
      401,
      ERROR_CODES.unauthorized,
      "signature does not match the request",
    );
  }

  return {
    ok: true,
    requestBody: bodyText,
    auth: {
      keyId,
      certId,
      subject,
      scope: effectiveScope,
      timestamp,
      nonce,
      ifMatch: request.headers.get("if-match"),
      direct,
    },
  };
}

export { subjectPatternIsNarrower } from "./protocol.ts";
