import { CID } from "multiformats/cid";
import {
  importPrivateKeyPkcs8,
  randomBytes,
  sha256Hex,
  signEd25519,
  toBase64Url,
} from "./crypto.js";
import { encodeCertificate } from "./certificates.js";
import type { Certificate } from "./protocol.js";

export interface PointerProof {
  origin: string;
  id: string;
  method: string;
  path: string;
  bodySha256: string;
  ifMatch: string;
  idempotencyKey: string;
  timestamp: number;
  nonce: string;
  subject: string;
}
/** Proposed shared encoding for the confirmed /v1/pointers API; service must use these same bytes. */
export function pointerSigningMessage(proof: PointerProof): string {
  return JSON.stringify([
    "IPAB-POINTERS/1",
    proof.origin,
    proof.id,
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
export interface RootPointerState {
  root: string;
  revision: string;
}
export class RootPointerError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly current?: RootPointerState,
  ) {
    super(`Pointer request rejected (${status}, ${code}).`);
  }
}
export function pointerOrigin(input: string): string {
  const url = new URL(input);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
      ))
  )
    throw new Error(
      "Pointer service must be a fixed HTTPS origin (HTTP loopback for development).",
    );
  return url.origin;
}
export function pointerId(input: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(input))
    throw new Error("Invalid opaque pointer ID.");
  return input;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Malformed pointer service response.");
  return value as Record<string, unknown>;
}
function state(value: unknown): RootPointerState {
  const fields = record(value);
  if (
    Object.keys(fields).some((key) => !["root", "revision"].includes(key)) ||
    typeof fields.root !== "string" ||
    typeof fields.revision !== "string" ||
    !/^[1-9]\d{0,127}$/.test(fields.revision) ||
    CID.parse(fields.root).toV1().toString() !== fields.root
  )
    throw new Error("Invalid root/revision response.");
  return { root: fields.root, revision: fields.revision };
}
export interface RootPointerOptions {
  origin: string;
  id?: string;
  privateKey: string;
  publicKey: string;
  certificate?: Certificate;
  fetch?: typeof fetch;
  now?: () => number;
  nonce?: () => string;
}
export class RootPointerClient {
  readonly origin: string;
  readonly id: string;
  constructor(private readonly options: RootPointerOptions) {
    this.origin = pointerOrigin(options.origin);
    this.id = options.id ? pointerId(options.id) : "";
  }
  async create(
    root: string,
    authorization: { origin: string; apiKey: string },
    idempotencyKey: string,
  ): Promise<string> {
    if (
      authorization.origin !== this.origin ||
      this.id ||
      this.options.certificate
    )
      throw new Error(
        "Creation authorization is not bound to this configured origin and owner.",
      );
    const result = record(
      await this.send(
        "POST",
        JSON.stringify({
          owner: this.options.publicKey,
          root: CID.parse(root).toV1().toString(),
        }),
        "",
        idempotencyKey,
        authorization.apiKey,
      ),
    );
    if (
      Object.keys(result).some((key) => key !== "id") ||
      typeof result.id !== "string"
    )
      throw new Error("Invalid pointer creation response.");
    if (result.id.includes(authorization.apiKey))
      throw new Error(
        "Creation response must not contain credential material.",
      );
    return pointerId(result.id);
  }
  async read(): Promise<RootPointerState> {
    if (!this.id) throw new Error("Read requires a pointer ID.");
    return state(await this.send("GET", "", "", ""));
  }
  async write(
    root: string,
    revision: string,
    idempotencyKey: string,
  ): Promise<RootPointerState> {
    if (!this.id || !/^[1-9]\d{0,127}$/.test(revision))
      throw new Error("CAS requires a pointer ID and strong revision.");
    return state(
      await this.send(
        "PUT",
        JSON.stringify({ root: CID.parse(root).toV1().toString() }),
        `"${revision}"`,
        idempotencyKey,
      ),
    );
  }
  private async send(
    method: "POST" | "GET" | "PUT",
    body: string,
    ifMatch: string,
    idempotencyKey: string,
    apiKey?: string,
  ): Promise<unknown> {
    if (method !== "GET" && !/^[A-Za-z0-9_-]{16,128}$/.test(idempotencyKey))
      throw new Error("Mutations require a random operation idempotency key.");
    const path = this.id ? `/v1/pointers/${this.id}` : "/v1/pointers/";
    const signer = await importPrivateKeyPkcs8(this.options.privateKey);
    for (let attempt = 0; attempt < 3; attempt++) {
      const proof: PointerProof = {
        origin: this.origin,
        id: this.id,
        method,
        path,
        bodySha256: await sha256Hex(body),
        ifMatch,
        idempotencyKey,
        timestamp: this.options.now?.() ?? Math.floor(Date.now() / 1000),
        nonce: this.options.nonce?.() ?? toBase64Url(randomBytes(18)),
        subject: this.options.publicKey,
      };
      const headers = new Headers({
        authorization: `Ed25519 ${await signEd25519(signer, pointerSigningMessage(proof))}`,
        "x-pointer-timestamp": String(proof.timestamp),
        "x-pointer-nonce": proof.nonce,
        "x-pointer-subject": proof.subject,
        accept: "application/json",
      });
      if (body) headers.set("content-type", "application/json");
      if (ifMatch) headers.set("if-match", ifMatch);
      if (idempotencyKey) headers.set("idempotency-key", idempotencyKey);
      if (apiKey && method === "POST") headers.set("x-api-key", apiKey);
      if (this.options.certificate)
        headers.set(
          "x-pointer-cert",
          encodeCertificate(this.options.certificate),
        );
      let response: Response;
      try {
        response = await (this.options.fetch ?? fetch)(
          `${this.origin}${path}`,
          {
            method,
            headers,
            ...(body ? { body } : {}),
            redirect: "error",
            cache: "no-store",
            signal: AbortSignal.timeout(30_000),
          },
        );
      } catch (cause) {
        if (attempt < 2) continue;
        throw new Error(
          "Pointer network result is unknown; recover the same saved operation, not a new creation.",
          { cause },
        );
      }
      if (!response.body) throw new Error("Pointer response body is missing.");
      const reader = response.body.getReader();
      const parts: Uint8Array[] = [];
      let length = 0;
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          length += part.value.length;
          if (length > 64 * 1024) {
            await reader.cancel();
            throw new Error("Pointer response exceeds its byte limit.");
          }
          parts.push(part.value);
        }
      } finally {
        reader.releaseLock();
      }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const part of parts) {
        bytes.set(part, offset);
        offset += part.length;
      }
      let value: unknown;
      try {
        value = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        ) as unknown;
      } catch {
        throw new Error(
          "Malformed pointer response; no credential material is echoed.",
        );
      }
      if (!response.ok) {
        const error = record(record(value).error);
        const known = new Set([
          "bad_request",
          "unauthorized",
          "forbidden",
          "not_found",
          "method_not_allowed",
          "idempotency_conflict",
          "precondition_failed",
          "precondition_required",
          "value_too_large",
          "rate_limited",
          "capacity_exceeded",
          "internal",
          "invalid_api_key",
          "invalid_signature",
          "replayed",
          "cert_invalid",
          "cert_expired",
        ]);
        const code =
          typeof error.code === "string" && known.has(error.code)
            ? error.code
            : "http_error";
        const current =
          response.status === 412 ? state(error.details) : undefined;
        if (current && response.headers.get("etag") !== `"${current.revision}"`)
          throw new Error(
            "CAS response must include its matching strong ETag.",
          );
        throw new RootPointerError(response.status, code, current);
      }
      if (method !== "POST") {
        const result = state(value);
        if (response.headers.get("etag") !== `"${result.revision}"`)
          throw new Error(
            "Pointer response must include its matching strong ETag.",
          );
      }
      return value;
    }
    throw new Error("Pointer operation could not be confirmed.");
  }
}
