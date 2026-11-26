/**
 * Wire protocol shared by the Worker, the Durable Object and any client.
 *
 * Everything that is signed is defined *once* in this file, so a client written
 * against these helpers is guaranteed to produce the exact bytes the Worker
 * verifies.
 */

export const PROTOCOL_VERSION = 1;
export const ALGORITHM = "Ed25519";

/** Maximum length of the pointer value, in UTF-8 bytes. */
export const MAX_VALUE_BYTES = 256;

/** Maximum number of certificates a client may send (leaf first). */
export const MAX_CHAIN_DEPTH = 5;

/** Accepted clock skew between signer and Worker, in seconds. */
export const CLOCK_SKEW_SECONDS = 60;

/** A nonce stays remembered for this long (twice the skew window). */
export const NONCE_TTL_SECONDS = CLOCK_SKEW_SECONDS * 2 + 10;

/** Safety valve so a compromised key cannot grow DO storage without bound. */
export const MAX_NONCES = 5000;

/** Lower-case hex SHA-256 of the empty string, used for bodyless requests. */
export const EMPTY_BODY_SHA256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

// --------------------------------------------------------------------------
// Headers
// --------------------------------------------------------------------------

export const HEADER_AUTHORIZATION = "authorization";
export const HEADER_CERT = "x-pointer-cert"; // one base64url certificate per header, leaf first
export const HEADER_SCOPE = "x-pointer-scope"; // optional JSON DelegatedScope narrowing the leaf scope
export const HEADER_SUBJECT = "x-pointer-subject"; // identity; required only for direct (cert-less) signing
export const HEADER_TIMESTAMP = "x-pointer-timestamp"; // unix seconds
export const HEADER_AUDIENCE = "x-pointer-audience";
export const HEADER_NONCE = "x-pointer-nonce"; // 16..128 chars, URL-safe
export const HEADER_IDEMPOTENCY = "idempotency-key"; // optional, not signed; lets a retry be replayed

/** `Authorization: Ed25519 <base64url signature>` */
export const AUTH_SCHEME = "Ed25519";

// --------------------------------------------------------------------------
// Authorization model
// --------------------------------------------------------------------------

export interface DelegatedScope {
  /** May read the pointer. Defaults to false. */
  read: boolean;
  /** May write the pointer. Defaults to false. */
  write: boolean;
  /**
   * Optional glob restricting which identities (`sub`) this certificate's holder
   * may write about / issue certificates for. `*` and `?` wildcards.
   */
  sub?: string;
}

export interface CertificateBody {
  /** Optional signed exact service/variable URL; required by IPAB swarm clients. */
  aud?: string;
  /** Envelope version. */
  v: 1;
  /** Free-form identity of the key holder, e.g. "alice" or "alice/agent-3". */
  sub: string;
  /** base64url raw Ed25519 public key (32 bytes). */
  pub: string;
  /** Capabilities granted to this key. */
  scope: DelegatedScope;
  /** Identity of the signer of this certificate. Empty string for a root cert. */
  iss: string;
  /** base64url raw public key of the issuer. Empty string for a root cert. */
  iss_pub: string;
  /** base64url SHA-256 of `pub`: stable id of the holder's key, used for audit/revocation. */
  kid: string;
  /** Unique certificate id, base64url, 16 bytes. */
  cid: string;
  /** Issued at, unix seconds. */
  iat: number;
  /** Expires at, unix seconds. */
  exp: number;
  /** Whether this certificate may sign other certificates. */
  ca: boolean;
  /** Free-form metadata, not interpreted by the Worker. */
  meta?: Record<string, string>;
}

export interface Certificate {
  body: CertificateBody;
  /** base64url Ed25519 signature by the issuer over the certificate message. */
  sig: string;
}

// --------------------------------------------------------------------------
// Canonical signed messages
// --------------------------------------------------------------------------

export interface RequestProof {
  /** Signed service origin. Legacy clients omit it. */
  audience?: string;
  method: string;
  /** Request path as seen by the Worker, e.g. "/v1/value". No query string. */
  path: string;
  /** Unix seconds at signing time. */
  timestamp: number;
  /** Random unique value, 16..128 URL-safe characters. */
  nonce: string;
  /** Lower-case hex SHA-256 of the request body (empty body has a known hash). */
  bodySha256: string;
  /** Raw `If-Match` header value, or "" when absent. */
  ifMatch: string;
  /**
   * Identity of the signer. When a certificate chain is presented it must equal
   * the leaf certificate's `sub`; for direct anchor signing it is the only
   * identity assertion and is therefore covered by the signature.
   */
  subject: string;
}

/**
 * The exact bytes a client signs for a request:
 *
 *   DSH-POINTER/1\n
 *   <METHOD>\n
 *   <PATH>\n
 *   <UNIX SECONDS>\n
 *   <NONCE>\n
 *   <BODY SHA-256 HEX>\n
 *   <IF-MATCH>\n
 *   <SUBJECT>
 *
 * Binding method+path prevents using a signature captured on one endpoint
 * against another; binding the body hash prevents swapping the payload;
 * binding `If-Match` makes the optimistic-lock precondition non-repudiable;
 * binding the subject stops a direct signer from impersonating another id.
 */
export function requestSigningMessage(p: RequestProof): string {
  return [
    p.audience ? "DSH-POINTER/2" : `DSH-POINTER/${PROTOCOL_VERSION}`,
    ...(p.audience ? [p.audience] : []),
    p.method.toUpperCase(),
    p.path,
    String(p.timestamp),
    p.nonce,
    p.bodySha256,
    p.ifMatch,
    p.subject,
  ].join("\n");
}

/**
 * The exact bytes an issuer signs for a certificate. Covers every field,
 * with the issuer's own identity and key pinned at the end.
 */
export function certificateSigningMessage(body: CertificateBody): string {
  return [
    body.aud ? "DSH-POINTER-CERT/2" : `DSH-POINTER-CERT/${PROTOCOL_VERSION}`,
    ...(body.aud ? [body.aud] : []),
    body.sub,
    body.pub,
    scopeToString(body.scope),
    body.iss,
    body.iss_pub,
    body.kid,
    body.cid,
    String(body.iat),
    String(body.exp),
    body.ca ? "ca" : "leaf",
  ].join("\n");
}

/** Deterministic, unambiguous serialization of a scope. */
export function scopeToString(scope: DelegatedScope): string {
  return [
    scope.read ? "read" : "-",
    scope.write ? "write" : "-",
    scope.sub ?? "*",
  ].join(":");
}

export function normalizeScope(
  scope: Partial<DelegatedScope> | undefined,
): DelegatedScope {
  return {
    read: scope?.read === true,
    write: scope?.write === true,
    ...(scope?.sub ? { sub: scope.sub } : {}),
  };
}

/** True when every capability in `inner` is also present in `outer`. */
export function scopeIsSubset(
  inner: DelegatedScope,
  outer: DelegatedScope,
): boolean {
  if (inner.read && !outer.read) return false;
  if (inner.write && !outer.write) return false;
  if (!subjectPatternIsNarrower(inner.sub, outer.sub)) return false;
  return true;
}

/**
 * True when `inner` cannot match anything outside `outer`.
 *
 * Supported patterns: an optional single trailing `*` (prefix match) or a
 * literal. `?` and interior `*` still work for *matching* a subject, but two
 * such patterns are only comparable when they are identical — refusing to
 * guess is the safe default.
 */
export function subjectPatternIsNarrower(
  inner: string | undefined,
  outer: string | undefined,
): boolean {
  const i = inner ?? "*";
  const o = outer ?? "*";
  if (o === "*") return true;
  if (i === "*") return false;
  if (i === o) return true;

  const iPrefix = trailingStarPrefix(i);
  const oPrefix = trailingStarPrefix(o);
  if (iPrefix !== null && oPrefix !== null) {
    return iPrefix.startsWith(oPrefix);
  }
  // A literal identity is narrower than a prefix pattern when it starts with it.
  if (iPrefix === null && oPrefix !== null) return i.startsWith(oPrefix);
  return false;
}

/** Returns the literal prefix of `p...` / `p*`, or null for literal/complex patterns. */
function trailingStarPrefix(pattern: string): string | null {
  if (
    pattern.endsWith("*") &&
    !pattern.slice(0, -1).includes("*") &&
    !pattern.includes("?")
  ) {
    return pattern.slice(0, -1);
  }
  return null;
}

/** Glob match supporting `*` (any run) and `?` (one char). Case-sensitive. */
export function subjectMatches(
  pattern: string | undefined,
  subject: string,
): boolean {
  if (pattern === undefined || pattern === "*") return true;
  const source = pattern
    .split("")
    .map((ch) => {
      if (ch === "*") return ".*";
      if (ch === "?") return ".";
      return ch.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
    })
    .join("");
  return new RegExp(`^${source}$`, "u").test(subject);
}

// --------------------------------------------------------------------------
// Resource shapes
// --------------------------------------------------------------------------

export interface PointerConfig {
  /** New IPAB swarms require origin-bound requests and service/variable-bound certificates. */
  requireAudience?: boolean;
  /** Path segment under the service, e.g. "test-ptr". */
  name: string;
  /** Pinned Ed25519 anchor for this variable (base64url raw). */
  pubkey: string;
  /** Unix seconds at creation. */
  createdAt: number;
}

export const VARIABLE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,40}$/;
export const RESERVED_VARIABLE_NAMES = new Set(["admin", "v1", "health"]);

export function isValidVariableName(name: string): boolean {
  return VARIABLE_NAME_PATTERN.test(name) && !RESERVED_VARIABLE_NAMES.has(name);
}

export interface PointerState {
  value: string;
  /** Monotonic optimistic-lock version; 0 means "never written". */
  version: number;
  updatedAt: number | null;
  updatedBy: string | null;
}

export interface ErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export const ERROR_CODES = {
  missingAuth: "missing_auth",
  badRequest: "bad_request",
  unauthorized: "unauthorized",
  forbidden: "forbidden",
  replayed: "replayed",
  preconditionRequired: "precondition_required",
  preconditionFailed: "precondition_failed",
  alreadyExists: "already_exists",
  tooLarge: "value_too_large",
  notFound: "not_found",
  methodNotAllowed: "method_not_allowed",
  idempotencyConflict: "idempotency_conflict",
  conflict: "conflict",
  unknownPointer: "unknown_pointer",
  internal: "internal",
} as const;
