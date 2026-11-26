/**
 * Small dependency-free client for the signed-pointer Worker.
 *
 * Runs unchanged in Cloudflare Workers, Node >= 20 and browsers (all it needs is
 * `fetch`, WebCrypto and `btoa`/`atob`).
 *
 *   PointerClient  -> data plane: /<name>/v1/value
 *   AdminClient    -> control plane: /_admin/v1/variables
 */

import {
  ALGORITHM,
  EMPTY_BODY_SHA256,
  HEADER_CERT,
  HEADER_SCOPE,
  HEADER_SUBJECT,
  HEADER_TIMESTAMP,
  HEADER_AUDIENCE,
  type DelegatedScope,
  type PointerState,
  type RequestProof,
  requestSigningMessage,
} from "./protocol.js";
import {
  fromBase64Url,
  importPrivateKeyPkcs8,
  randomBytes,
  sha256Hex,
  signEd25519,
  toBase64Url,
  utf8,
} from "./crypto.js";
import { encodeCertificate } from "./certificates.js";
import type { Certificate } from "./protocol.js";

export interface Signer {
  /** base64url PKCS#8 private key of this identity. */
  privateKey: string;
  /** Leaf certificate chain, leaf first. Empty for direct anchor signing. */
  certificates?: Certificate[];
  /** Identity. Required for direct signing, must be omitted with certificates. */
  subject?: string;
  /** Optional scope narrowing (never widening) applied per request. */
  scope?: DelegatedScope;
}

export interface PointerClientOptions {
  baseUrl: string;
  signer: Signer;
  fetch?: typeof fetch;
  /** Override the clock (tests). Returns unix seconds. */
  now?: () => number;
  /** Override nonce generation (tests). */
  nonce?: () => string;
}

export interface SignerInfo {
  subject: string;
  keyId: string;
  certId: string | null;
  direct: boolean;
}

export interface ReadResult extends PointerState {
  etag: string;
  replayed: boolean;
  idempotent: boolean;
  pointer?: string;
  signer?: SignerInfo;
}

export interface WriteOptions {
  /** Version returned by the last read. Use 0 (or `create`) for the first write. */
  ifVersion: number;
  idempotencyKey?: string | undefined;
  scope?: DelegatedScope | undefined;
}

export interface CurrentPointerState {
  value: string;
  version: number;
}

export interface AdminVariable {
  name: string;
  pubkey: string;
  createdAt: number;
}

export interface AdminVariableDetail extends AdminVariable {
  version: number;
  updatedAt: number | null;
  updatedBy: string | null;
}

export class PointerApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly body: unknown;
  readonly current: CurrentPointerState | undefined;

  constructor(
    status: number,
    code: string,
    message: string,
    body: unknown,
    current?: CurrentPointerState,
  ) {
    super(message);
    this.name = "PointerApiError";
    this.status = status;
    this.code = code;
    this.body = body;
    this.current = current;
  }
}

const newNonce = (): string => toBase64Url(randomBytes(18));

interface SignedFetchOptions {
  baseUrl: string;
  signer: Signer;
  privateKey: CryptoKey;
  method: string;
  path: string;
  body?: string | undefined;
  ifMatch?: string | undefined;
  scope?: DelegatedScope | undefined;
  idempotencyKey?: string | undefined;
  now: () => number;
  nonce: () => string;
  fetch: typeof fetch;
}

/**
 * Signs one request. The signed path is the full external pathname, so a
 * signature for /test-ptr/v1/value cannot be used for /other/v1/value.
 */
async function signedFetch(options: SignedFetchOptions): Promise<Response> {
  const body = options.body ?? "";
  const timestamp = options.now();
  const nonce = options.nonce();
  const bodySha256 = body ? await sha256Hex(body) : EMPTY_BODY_SHA256;
  // The subject is always part of the signed message. With a certificate it
  // must equal the leaf's subject, which the Worker enforces.
  const subject =
    options.signer.subject ?? options.signer.certificates![0]!.body.sub;
  const ifMatch = options.ifMatch ?? "";
  const signedPath = new URL(`${options.baseUrl}${options.path}`).pathname;

  const proof: RequestProof = {
    audience: new URL(options.baseUrl).origin,
    method: options.method,
    path: signedPath,
    timestamp,
    nonce,
    bodySha256,
    ifMatch,
    subject,
  };
  const signature = await signEd25519(
    options.privateKey,
    requestSigningMessage(proof),
  );

  const headers = new Headers({
    [HEADER_AUDIENCE]: proof.audience!,
    authorization: `${ALGORITHM} ${signature}`,
    [HEADER_TIMESTAMP]: String(timestamp),
    "x-pointer-nonce": nonce,
    accept: "application/json",
  });
  if (body) headers.set("content-type", "application/json");
  if (ifMatch) headers.set("if-match", ifMatch);
  headers.set(HEADER_SUBJECT, subject);
  if (options.idempotencyKey)
    headers.set("idempotency-key", options.idempotencyKey);
  const scope = options.scope ?? options.signer.scope;
  if (scope) headers.set(HEADER_SCOPE, JSON.stringify(scope));
  for (const cert of options.signer.certificates ?? []) {
    headers.append(HEADER_CERT, encodeCertificate(cert));
  }

  return options.fetch(`${options.baseUrl}${options.path}`, {
    method: options.method,
    headers,
    ...(body ? { body } : {}),
  });
}

async function parseJsonResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  if (!response.ok) {
    const err = (
      parsed as {
        error?: {
          code?: string;
          message?: string;
          details?: { value?: unknown; version?: unknown };
        };
      } | null
    )?.error;
    const details = err?.details;
    throw new PointerApiError(
      response.status,
      err?.code ?? "http_error",
      err?.message ?? `HTTP ${response.status}`,
      parsed,
      details && typeof details.version === "number"
        ? {
            value: typeof details.value === "string" ? details.value : "",
            version: details.version,
          }
        : undefined,
    );
  }
  return parsed;
}

export class PointerClient {
  readonly baseUrl: string;
  readonly #signer: Signer;
  readonly #privateKey: Promise<CryptoKey>;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #nonce: () => string;

  constructor(options: PointerClientOptions) {
    if (!options.baseUrl) throw new Error("baseUrl is required");
    if (!options.signer.privateKey)
      throw new Error("signer.privateKey is required");
    if (!options.signer.subject && !options.signer.certificates?.length) {
      throw new Error("signer.subject is required");
    }
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.#signer = options.signer;
    this.#privateKey = importPrivateKeyPkcs8(options.signer.privateKey);
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.#nonce = options.nonce ?? newNonce;
  }

  async capabilities(): Promise<Record<string, unknown>> {
    const response = await this.#fetch(`${this.baseUrl}/v1/capabilities`, {
      headers: { accept: "application/json" },
    });
    return (await parseJsonResponse(response)) as Record<string, unknown>;
  }

  async read(): Promise<ReadResult> {
    const response = await this.#signed("GET", "/v1/value", "");
    const body = (await parseJsonResponse(response)) as Omit<
      ReadResult,
      "etag"
    >;
    return {
      ...body,
      etag: response.headers.get("etag") ?? `"${body.version}"`,
    };
  }

  /**
   * Compare-and-swap write. Fails with `precondition_failed` (HTTP 412) if the
   * pointer changed since `ifVersion` was read.
   */
  async write(value: string, options: WriteOptions): Promise<ReadResult> {
    const body = JSON.stringify({ value });
    const response = await this.#signed("PUT", "/v1/value", body, {
      ifMatch: `"${options.ifVersion}"`,
      scope: options.scope,
      idempotencyKey: options.idempotencyKey,
    });
    const parsed = (await parseJsonResponse(response)) as Omit<
      ReadResult,
      "etag"
    >;
    return {
      ...parsed,
      etag: response.headers.get("etag") ?? `"${parsed.version}"`,
    };
  }

  /** Convenience for the very first write (`If-Match: *`). */
  async create(
    value: string,
    options: { idempotencyKey?: string | undefined } = {},
  ): Promise<ReadResult> {
    const response = await this.#signed(
      "PUT",
      "/v1/value",
      JSON.stringify({ value }),
      {
        ifMatch: "*",
        idempotencyKey: options.idempotencyKey,
      },
    );
    const parsed = (await parseJsonResponse(response)) as Omit<
      ReadResult,
      "etag"
    >;
    return {
      ...parsed,
      etag: response.headers.get("etag") ?? `"${parsed.version}"`,
    };
  }

  /** Read-modify-write helper that retries on conflict a bounded number of times. */
  async update(
    mutator: (current: ReadResult) => string | Promise<string>,
    options: { maxAttempts?: number; idempotencyKey?: string | undefined } = {},
  ): Promise<ReadResult> {
    const maxAttempts = options.maxAttempts ?? 5;
    for (let attempt = 1; ; attempt++) {
      const current = await this.read();
      const next = await mutator(current);
      try {
        return await this.write(next, {
          ifVersion: current.version,
          idempotencyKey: options.idempotencyKey,
        });
      } catch (err) {
        if (
          err instanceof PointerApiError &&
          err.status === 412 &&
          attempt < maxAttempts
        )
          continue;
        throw err;
      }
    }
  }

  async #signed(
    method: "GET" | "PUT",
    path: string,
    body: string,
    extras: {
      ifMatch?: string | undefined;
      scope?: DelegatedScope | undefined;
      idempotencyKey?: string | undefined;
    } = {},
  ): Promise<Response> {
    return signedFetch({
      baseUrl: this.baseUrl,
      signer: this.#signer,
      privateKey: await this.#privateKey,
      method,
      path,
      body,
      ifMatch: extras.ifMatch,
      scope: extras.scope,
      idempotencyKey: extras.idempotencyKey,
      now: this.#now,
      nonce: this.#nonce,
      fetch: this.#fetch,
    });
  }
}

/**
 * Control plane client. The signer must be the pinned admin key (direct signing,
 * no certificate chain).
 */
export class AdminClient {
  readonly baseUrl: string;
  readonly #signer: Signer;
  readonly #privateKey: Promise<CryptoKey>;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #nonce: () => string;

  constructor(options: PointerClientOptions) {
    if (!options.baseUrl) throw new Error("baseUrl is required");
    if (!options.signer.privateKey)
      throw new Error("signer.privateKey is required");
    if (options.signer.certificates?.length) {
      throw new Error("admin signing must be direct (no certificates)");
    }
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.#signer = {
      ...options.signer,
      subject: options.signer.subject ?? "admin",
    };
    this.#privateKey = importPrivateKeyPkcs8(options.signer.privateKey);
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.#nonce = options.nonce ?? newNonce;
  }

  async list(): Promise<{ variables: AdminVariable[] }> {
    return (await this.#send("GET", "/_admin/v1/variables")) as {
      variables: AdminVariable[];
    };
  }

  async get(name: string): Promise<AdminVariableDetail> {
    return (await this.#send(
      "GET",
      `/_admin/v1/variables/${encodeURIComponent(name)}`,
    )) as AdminVariableDetail;
  }

  async create(
    name: string,
    pubkey: string,
    requireAudience = false,
  ): Promise<AdminVariable> {
    return (await this.#send(
      "POST",
      "/_admin/v1/variables",
      JSON.stringify({
        name,
        pubkey,
        ...(requireAudience ? { requireAudience } : {}),
      }),
    )) as AdminVariable;
  }

  async rotate(name: string, pubkey: string): Promise<AdminVariable> {
    return (await this.#send(
      "PUT",
      `/_admin/v1/variables/${encodeURIComponent(name)}`,
      JSON.stringify({ pubkey }),
    )) as AdminVariable;
  }

  async remove(name: string): Promise<{ deleted: string }> {
    return (await this.#send(
      "DELETE",
      `/_admin/v1/variables/${encodeURIComponent(name)}`,
    )) as { deleted: string };
  }

  async #send(method: string, path: string, body?: string): Promise<unknown> {
    const response = await signedFetch({
      baseUrl: this.baseUrl,
      signer: this.#signer,
      privateKey: await this.#privateKey,
      method,
      path,
      body,
      now: this.#now,
      nonce: this.#nonce,
      fetch: this.#fetch,
    });
    return parseJsonResponse(response);
  }
}

/** Loads a raw Ed25519 public key from base64url, base64 or PEM for convenience. */
export function rawPublicKeyBytes(publicKey: string): Uint8Array {
  const text = publicKey.trim();
  if (text.includes("BEGIN PUBLIC KEY")) {
    const der = fromBase64Url(
      text
        .replace(/-----[^-]+-----/g, "")
        .replace(/\s+/g, "")
        .replace(/\+/g, "-")
        .replace(/\//g, "_"),
    );
    return der.slice(der.length - 32);
  }
  return fromBase64Url(text);
}

export function utf8Bytes(value: string): Uint8Array {
  return utf8(value);
}
