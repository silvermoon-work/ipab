import * as dagCbor from "@ipld/dag-cbor";
import { CID } from "multiformats/cid";
import { create as digest } from "multiformats/hashes/digest";
import {
  canonicalService,
  isCanonicalPublicKey,
  POINTER_ID_PATTERN,
  ServiceError,
} from "./protocol.js";
import {
  fromBase64Url,
  importPrivateKeyPkcs8,
  importPublicKeyRaw,
  randomBytes,
  sha256Hex,
  sha256,
  signEd25519,
  toBase64Url,
  utf8,
  verifyEd25519,
} from "./crypto.js";

export const MAX_VALUE_BYTES = 64 * 1024;
export const MAX_WIRE_BYTES = 128 * 1024;
export type Json =
  null | boolean | number | string | Json[] | { [key: string]: Json };
export interface Variable {
  value: Json;
  cid: string;
  status: "writable" | "frozen" | "deleted";
}
export interface ScopeCertificate {
  body: {
    v: 1;
    service: string;
    scopeId: string;
    subject: string;
    write: string[];
  };
  sig: string;
}
export interface ScopeProof {
  service: string;
  scopeId: string;
  variableId: string;
  method: string;
  path: string;
  bodySha256: string;
  ifMatch: string;
  idempotencyKey: string;
  timestamp: number;
  nonce: string;
  subject: string;
}
export const uniqueId = (): string => toBase64Url(randomBytes(32));
export function scopeSigningMessage(proof: ScopeProof): string {
  return JSON.stringify([
    "IPAB-SCOPE/1",
    proof.service,
    proof.scopeId,
    proof.variableId,
    proof.method.toUpperCase(),
    proof.path,
    proof.bodySha256,
    proof.ifMatch,
    proof.idempotencyKey,
    proof.timestamp,
    proof.nonce,
    proof.subject,
  ]);
}
export function scopeCertificateMessage(
  body: ScopeCertificate["body"],
): string {
  return JSON.stringify([
    "IPAB-SCOPE-CERT/1",
    body.service,
    body.scopeId,
    body.subject,
    body.write,
  ]);
}
export async function issueScopeCertificate(
  body: ScopeCertificate["body"],
  key: CryptoKey,
): Promise<ScopeCertificate> {
  return { body, sig: await signEd25519(key, scopeCertificateMessage(body)) };
}
export async function verifyScopeCertificate(
  certificate: unknown,
  owner: string,
  service: string,
  scopeId: string,
  variableId: string,
  subject: string,
): Promise<void> {
  const cert = parseScopeCertificate(certificate);
  const b = cert.body;
  if (
    b.service !== service ||
    b.scopeId !== scopeId ||
    b.subject !== subject ||
    !b.write.includes(variableId) ||
    !(await verifyEd25519(
      await importPublicKeyRaw(owner),
      cert.sig,
      scopeCertificateMessage(b),
    ))
  )
    throw new ServiceError(
      403,
      "cert_invalid",
      "invalid exact-ID owner certificate",
    );
}
export function parseScopeCertificate(certificate: unknown): ScopeCertificate {
  const invalid = () =>
    new ServiceError(403, "cert_invalid", "invalid exact-ID owner certificate");
  if (
    !certificate ||
    typeof certificate !== "object" ||
    Array.isArray(certificate)
  )
    throw invalid();
  const cert = certificate as Record<string, unknown>;
  if (!cert.body || typeof cert.body !== "object" || Array.isArray(cert.body))
    throw invalid();
  const b = cert.body as Record<string, unknown>;
  if (
    Object.keys(cert).sort().join() !== "body,sig" ||
    Object.keys(b).sort().join() !== "scopeId,service,subject,v,write" ||
    b.v !== 1 ||
    typeof b.service !== "string" ||
    typeof b.scopeId !== "string" ||
    !POINTER_ID_PATTERN.test(b.scopeId) ||
    !isCanonicalPublicKey(b.subject) ||
    !Array.isArray(b.write) ||
    b.write.length < 1 ||
    b.write.length > 32 ||
    typeof cert.sig !== "string" ||
    !/^[A-Za-z0-9_-]{86}$/.test(cert.sig)
  )
    throw invalid();
  const write: string[] = [];
  for (const id of b.write) {
    if (
      typeof id !== "string" ||
      !POINTER_ID_PATTERN.test(id) ||
      write.includes(id)
    )
      throw invalid();
    write.push(id);
  }
  return {
    body: {
      v: 1,
      service: b.service,
      scopeId: b.scopeId,
      subject: b.subject,
      write,
    },
    sig: cert.sig,
  };
}
export async function valueCid(value: unknown): Promise<string> {
  let entries = 0;
  const visit = (v: unknown, depth: number): void => {
    if (++entries > 8192 || depth > 32)
      throw new Error("JSON complexity limit exceeded");
    if (v === null || typeof v === "boolean") return;
    if (typeof v === "number") {
      if (
        !Number.isFinite(v) ||
        (Number.isInteger(v) && !Number.isSafeInteger(v))
      )
        throw new Error("JSON numbers must be finite; integers must be safe");
      return;
    }
    if (typeof v === "string") {
      for (let i = 0; i < v.length; i++) {
        const c = v.charCodeAt(i);
        if (c >= 0xd800 && c <= 0xdbff) {
          const next = v.charCodeAt(++i);
          if (!(next >= 0xdc00 && next <= 0xdfff))
            throw new Error("unpaired surrogate");
        } else if (c >= 0xdc00 && c <= 0xdfff)
          throw new Error("unpaired surrogate");
      }
      return;
    }
    if (Array.isArray(v)) {
      for (const item of v) visit(item, depth + 1);
      return;
    }
    if (
      !v ||
      typeof v !== "object" ||
      Object.getPrototypeOf(v) !== Object.prototype
    )
      throw new Error("value must be JSON-compatible");
    for (const [key, item] of Object.entries(v)) {
      visit(key, depth + 1);
      visit(item, depth + 1);
    }
  };
  try {
    visit(value, 0);
    const bytes = dagCbor.encode(value);
    if (
      bytes.length > MAX_VALUE_BYTES ||
      utf8(JSON.stringify(value)).length > MAX_VALUE_BYTES
    )
      throw new Error(
        "value exceeds 64 KiB canonical DAG-CBOR or compact JSON",
      );
    return CID.createV1(
      dagCbor.code,
      digest(0x12, await sha256(bytes)),
    ).toString();
  } catch (cause) {
    throw new ServiceError(
      400,
      "invalid_value",
      cause instanceof Error ? cause.message : "invalid JSON value",
    );
  }
}
export interface ScopeSigner {
  publicKey: string;
  privateKey: string;
  certificate?: ScopeCertificate;
}
export class ScopeApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly body: unknown,
  ) {
    super(message);
    this.name = "ScopeApiError";
  }
}
export class ScopeClient {
  readonly service: string;
  constructor(
    readonly options: {
      service: string;
      signer?: ScopeSigner;
      apiKey?: string;
      fetch?: typeof fetch;
      now?: () => number;
      nonce?: () => string;
    },
  ) {
    this.service = canonicalService(options.service);
  }
  async send<T>(
    method: string,
    scopeId = "",
    variableId = "",
    value?: unknown,
    options: {
      action?: "freeze";
      ifCid?: string;
      idempotencyKey?: string;
    } = {},
  ): Promise<T> {
    for (const id of [scopeId, variableId])
      if (id && !POINTER_ID_PATTERN.test(id))
        throw new Error("invalid Unique ID");
    const path = scopeId
      ? `/v1/${scopeId}${variableId ? `/${variableId}` : ""}${options.action ? `/${options.action}` : ""}`
      : "/v1/scopes";
    const body = value === undefined ? "" : JSON.stringify(value);
    const headers = new Headers({ accept: "application/json" });
    if (body) headers.set("content-type", "application/json");
    if (method !== "GET") {
      const signer = this.options.signer;
      if (!signer) throw new Error("write requires signer");
      const proof: ScopeProof = {
        service: this.service,
        scopeId,
        variableId,
        path,
        method,
        bodySha256: await sha256Hex(body),
        ifMatch: options.ifCid ? `"${options.ifCid}"` : "",
        idempotencyKey: options.idempotencyKey ?? "",
        timestamp: this.options.now?.() ?? Math.floor(Date.now() / 1000),
        nonce: this.options.nonce?.() ?? toBase64Url(randomBytes(24)),
        subject: signer.publicKey,
      };
      headers.set(
        "authorization",
        `Ed25519 ${await signEd25519(await importPrivateKeyPkcs8(signer.privateKey), scopeSigningMessage(proof))}`,
      );
      headers.set("x-ipab-subject", proof.subject);
      headers.set("x-ipab-timestamp", String(proof.timestamp));
      headers.set("x-ipab-nonce", proof.nonce);
      if (proof.ifMatch) headers.set("if-match", proof.ifMatch);
      if (proof.idempotencyKey)
        headers.set("idempotency-key", proof.idempotencyKey);
      if (signer.certificate)
        headers.set(
          "x-ipab-certificate",
          toBase64Url(utf8(JSON.stringify(signer.certificate))),
        );
      if (!scopeId && this.options.apiKey)
        headers.set("x-api-key", this.options.apiKey);
    }
    const response = await (this.options.fetch ?? fetch)(
      `${this.service}${path}`,
      {
        method,
        headers,
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(30_000),
        ...(body ? { body } : {}),
      },
    );
    const text = await boundedText(response);
    const parsed = JSON.parse(text) as T & {
      error?: { code: string; message: string };
    };
    if (!response.ok)
      throw new ScopeApiError(
        response.status,
        parsed.error?.code ?? "http_error",
        parsed.error?.message ?? `HTTP ${response.status}`,
        parsed,
      );
    return parsed;
  }
  createScope(key: string): Promise<{ id: string; owner: string }> {
    return this.send(
      "POST",
      "",
      "",
      { owner: this.options.signer?.publicKey },
      { idempotencyKey: key },
    );
  }
  async create(
    scope: string,
    value: unknown,
    key: string,
  ): Promise<Variable & { id: string }> {
    await valueCid(value);
    return this.send("POST", scope, "", { value }, { idempotencyKey: key });
  }
  read(scope: string, id: string): Promise<Variable> {
    return this.send("GET", scope, id);
  }
  async write(
    scope: string,
    id: string,
    value: unknown,
    cid: string,
    key: string,
  ): Promise<Variable> {
    await valueCid(value);
    return this.send(
      "PUT",
      scope,
      id,
      { value },
      { ifCid: cid, idempotencyKey: key },
    );
  }
  freeze(scope: string, id: string, key: string): Promise<Variable> {
    return this.send("POST", scope, id, undefined, {
      action: "freeze",
      idempotencyKey: key,
    });
  }
  delete(scope: string, id: string, key: string): Promise<Variable> {
    return this.send("DELETE", scope, id, undefined, { idempotencyKey: key });
  }
}
export async function boundedText(
  response: Response | Request,
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > MAX_WIRE_BYTES) {
        await reader.cancel();
        throw new ServiceError(413, "too_large", "wire body exceeds 128 KiB");
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ServiceError(400, "invalid_utf8", "body must be valid UTF-8");
  }
}
export function decodeScopeCertificate(encoded: string): ScopeCertificate {
  if (encoded.length > 8192)
    throw new ServiceError(413, "too_large", "certificate too large");
  return parseScopeCertificate(
    JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(fromBase64Url(encoded)),
    ) as unknown,
  );
}
