import { CID } from "multiformats/cid";
import { fromBase64Url, toBase64Url } from "./crypto.js";

export const NONCE_TTL_SECONDS = 130;
export const MAX_NONCES = 5000;
export const MAX_ROOT_BYTES = 256;
export const EMPTY_BODY_SHA256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
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
