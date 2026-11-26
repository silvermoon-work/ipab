import {
  canonicalService,
  HEADER_CERT,
  HEADER_IDEMPOTENCY,
  HEADER_NONCE,
  HEADER_SUBJECT,
  HEADER_TIMESTAMP,
  isCanonicalPublicKey,
  POINTER_ID_PATTERN,
  requestSigningMessage,
  type Certificate,
  type PointerState,
} from "./protocol.ts";
import {
  fromBase64Url,
  importPrivateKeyPkcs8,
  randomBytes,
  sha256Hex,
  signEd25519,
  toBase64Url,
  utf8,
} from "./crypto.ts";
import { encodeCertificate } from "./certificates.ts";

export interface Signer {
  privateKey: string;
  publicKey: string;
  certificate?: Certificate;
}
export interface PointerClientOptions {
  service: string;
  apiKey?: string;
  signer: Signer;
  fetch?: typeof fetch;
  now?: () => number;
  nonce?: () => string;
}
export interface ReadResult extends PointerState {
  etag: string;
}
export interface WriteOptions {
  ifRevision: string;
  idempotencyKey?: string;
}
export class PointerApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly body: unknown,
    readonly current?: PointerState,
  ) {
    super(message);
    this.name = "PointerApiError";
  }
}
export class PointerClient {
  readonly service: string;
  readonly #options: PointerClientOptions;
  readonly #privateKey: Promise<CryptoKey>;
  constructor(options: PointerClientOptions) {
    this.service = canonicalService(options.service);
    if (options.apiKey !== undefined && !isCanonicalPublicKey(options.apiKey)) {
      throw new Error(
        "API key must be the canonical base64url encoding of 32 bytes",
      );
    }
    if (
      !options.signer.privateKey ||
      !isCanonicalPublicKey(options.signer.publicKey)
    ) {
      throw new Error(
        "signer requires a private key and full canonical public key",
      );
    }
    this.#options = options;
    this.#privateKey = importPrivateKeyPkcs8(options.signer.privateKey);
  }
  async create(
    root: string,
    options: { idempotencyKey?: string } = {},
  ): Promise<{ id: string }> {
    if (!this.#options.apiKey)
      throw new Error("service API key required for creation");
    if (this.#options.signer.certificate)
      throw new Error("creation requires direct owner signing");
    return (
      await this.#send(
        "POST",
        "",
        JSON.stringify({ owner: this.#options.signer.publicKey, root }),
        "",
        options.idempotencyKey,
      )
    ).body as { id: string };
  }
  async read(id: string): Promise<ReadResult> {
    const result = await this.#send("GET", id);
    return { ...(result.body as PointerState), etag: result.etag! };
  }
  async write(
    id: string,
    root: string,
    options: WriteOptions,
  ): Promise<ReadResult> {
    if (!/^[1-9]\d*$/.test(options.ifRevision))
      throw new Error(
        "ifRevision must be a positive canonical revision string",
      );
    const result = await this.#send(
      "PUT",
      id,
      JSON.stringify({ root }),
      `"${options.ifRevision}"`,
      options.idempotencyKey,
    );
    return { ...(result.body as PointerState), etag: result.etag! };
  }
  async #send(
    method: string,
    id: string,
    body = "",
    ifMatch = "",
    idempotencyKey = "",
  ): Promise<{ body: unknown; etag: string | null }> {
    if (id && !POINTER_ID_PATTERN.test(id))
      throw new Error("invalid pointer ID");
    const path = `/v1/pointers/${id}`;
    const timestamp = this.#options.now?.() ?? Math.floor(Date.now() / 1000);
    const nonce = this.#options.nonce?.() ?? toBase64Url(randomBytes(24));
    const subject = this.#options.signer.publicKey;
    const signature = await signEd25519(
      await this.#privateKey,
      requestSigningMessage({
        service: this.service,
        pointerId: id,
        method,
        path,
        timestamp,
        nonce,
        bodySha256: await sha256Hex(body),
        ifMatch,
        idempotencyKey,
        subject,
      }),
    );
    const headers = new Headers({
      authorization: `Ed25519 ${signature}`,
      [HEADER_SUBJECT]: subject,
      [HEADER_TIMESTAMP]: String(timestamp),
      [HEADER_NONCE]: nonce,
      accept: "application/json",
    });
    if (body) headers.set("content-type", "application/json");
    if (ifMatch) headers.set("if-match", ifMatch);
    if (idempotencyKey) headers.set(HEADER_IDEMPOTENCY, idempotencyKey);
    if (method === "POST") headers.set("x-api-key", this.#options.apiKey!);
    if (this.#options.signer.certificate)
      headers.set(
        HEADER_CERT,
        encodeCertificate(this.#options.signer.certificate),
      );
    const response = await (this.#options.fetch ?? fetch)(
      `${this.service}${path}`,
      { method, headers, redirect: "error", ...(body ? { body } : {}) },
    );
    const parsed: unknown = await response.json();
    if (!response.ok) {
      const error = (
        parsed as {
          error?: { code?: string; message?: string; details?: PointerState };
        }
      ).error;
      throw new PointerApiError(
        response.status,
        error?.code ?? "http_error",
        error?.message ?? `HTTP ${response.status}`,
        parsed,
        response.status === 412 ? error?.details : undefined,
      );
    }
    return { body: parsed, etag: response.headers.get("etag") };
  }
}
export function rawPublicKeyBytes(publicKey: string): Uint8Array {
  const text = publicKey.trim();
  if (text.includes("BEGIN PUBLIC KEY")) {
    const der = fromBase64Url(
      text
        .replace(/-----[^-]+-----/g, "")
        .replace(/\s+/g, "")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, ""),
    );
    return der.slice(der.length - 32);
  }
  return fromBase64Url(text);
}
export function utf8Bytes(value: string): Uint8Array {
  return utf8(value);
}
