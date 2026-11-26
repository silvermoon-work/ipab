import { CID } from "multiformats/cid";
import { fromBase64Url, toBase64Url } from "./crypto.js";

export const PROTOCOL_VERSION = 2;
export const ALGORITHM = "Ed25519";
export const AUTH_SCHEME = ALGORITHM;
export const CLOCK_SKEW_SECONDS = 60;
export const NONCE_TTL_SECONDS = 130;
export const MAX_NONCES = 5000;
export const IDEMPOTENCY_TTL_SECONDS = 600;
export const MAX_IDEMPOTENCY_RECORDS = 200;
export const MAX_BODY_BYTES = 4096;
export const MAX_ROOT_BYTES = 256;
export const MAX_CERT_BYTES = 4096;
export const MAX_HEADERS_BYTES = 16384;
export const EMPTY_BODY_SHA256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
export const HEADER_CERT = "x-pointer-cert";
export const HEADER_SUBJECT = "x-pointer-subject";
export const HEADER_TIMESTAMP = "x-pointer-timestamp";
export const HEADER_NONCE = "x-pointer-nonce";
export const HEADER_IDEMPOTENCY = "idempotency-key";

export interface RequestProof {
  service: string;
  pointerId: string;
  method: string;
  path: string;
  timestamp: number;
  nonce: string;
  bodySha256: string;
  ifMatch: string;
  idempotencyKey: string;
  subject: string;
}

export function requestSigningMessage(p: RequestProof): string {
  return JSON.stringify([
    `IPAB-POINTER/${PROTOCOL_VERSION}`,
    p.service,
    p.pointerId,
    p.method.toUpperCase(),
    p.path,
    p.bodySha256,
    p.ifMatch,
    p.idempotencyKey,
    p.timestamp,
    p.nonce,
    p.subject,
  ]);
}

export interface CertificateBody {
  v: 2;
  service: string;
  pointerId: string;
  owner: string;
  member: string;
  cid: string;
  iat: number;
  exp: number;
}
export interface Certificate {
  body: CertificateBody;
  sig: string;
}
export function certificateSigningMessage(body: CertificateBody): string {
  return JSON.stringify([
    `IPAB-POINTER-CERT/${PROTOCOL_VERSION}`,
    body.service,
    body.pointerId,
    body.owner,
    body.member,
    body.cid,
    body.iat,
    body.exp,
  ]);
}

export interface PointerConfig {
  id: string;
  owner: string;
  root: string;
}
export interface PointerState {
  root: string;
  revision: string;
}
export const POINTER_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export function isCanonicalPublicKey(value: unknown): value is string {
  if (typeof value !== "string" || !POINTER_ID_PATTERN.test(value))
    return false;
  try {
    const bytes = fromBase64Url(value);
    return bytes.length === 32 && toBase64Url(bytes) === value;
  } catch {
    return false;
  }
}
export function isCanonicalCid(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    new TextEncoder().encode(value).length > MAX_ROOT_BYTES
  )
    return false;
  try {
    return CID.parse(value).toString() === value;
  } catch {
    return false;
  }
}
export function canonicalService(value: string): string {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      )) ||
    value !== url.origin
  )
    throw new Error(
      "service must be a canonical HTTPS origin (HTTP loopback allowed)",
    );
  return url.origin;
}
export function parseBody(
  text: string,
  creation = false,
): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("body must be a valid JSON object");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("body must be a JSON object");
  }
  const body = value as Record<string, unknown>;
  if (
    typeof body.root === "string" &&
    new TextEncoder().encode(body.root).length > MAX_ROOT_BYTES
  ) {
    throw new ServiceError(413, "too_large", "root exceeds 256 UTF-8 bytes");
  }
  const allowed = creation ? ["root", "owner"] : ["root"];
  if (
    Object.keys(body).some((key) => !allowed.includes(key)) ||
    !isCanonicalCid(body.root) ||
    (creation && !isCanonicalPublicKey(body.owner))
  ) {
    throw new Error(
      "body requires a canonical CID root and creation requires a full canonical Ed25519 owner key",
    );
  }
  return body;
}
export function parseRevision(value: string | null): string | null {
  if (!value || !/^"([1-9]\d*)"$/.test(value) || value.length > 80) return null;
  return value.slice(1, -1);
}
export interface ErrorBody {
  error: { code: string; message: string; details?: PointerState };
}
export interface ApiFailure {
  error: { status: number; code: string; message: string };
}
export function apiFailure(error: ServiceError): ApiFailure {
  return {
    error: { status: error.status, code: error.code, message: error.message },
  };
}
export class ServiceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

// Retained pure scope utilities; certificate authorization does not use scopes or CAs.
export interface DelegatedScope {
  read: boolean;
  write: boolean;
  sub?: string;
}
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
export function scopeIsSubset(
  inner: DelegatedScope,
  outer: DelegatedScope,
): boolean {
  return (
    !(inner.read && !outer.read) &&
    !(inner.write && !outer.write) &&
    subjectPatternIsNarrower(inner.sub, outer.sub)
  );
}
export function subjectPatternIsNarrower(
  inner: string | undefined,
  outer: string | undefined,
): boolean {
  const i = inner ?? "*",
    o = outer ?? "*";
  if (o === "*") return true;
  if (i === "*") return false;
  if (i === o) return true;
  const prefix = (p: string): string | null =>
    p.endsWith("*") && !p.slice(0, -1).includes("*") && !p.includes("?")
      ? p.slice(0, -1)
      : null;
  const ip = prefix(i),
    op = prefix(o);
  if (ip !== null && op !== null) return ip.startsWith(op);
  return ip === null && op !== null && i.startsWith(op);
}
export function subjectMatches(
  pattern: string | undefined,
  subject: string,
): boolean {
  if (pattern === undefined || pattern === "*") return true;
  const source = pattern
    .split("")
    .map((ch) =>
      ch === "*"
        ? ".*"
        : ch === "?"
          ? "."
          : ch.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&"),
    )
    .join("");
  return new RegExp(`^${source}$`, "u").test(subject);
}
