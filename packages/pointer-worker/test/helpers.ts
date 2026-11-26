import { timingSafeEqual } from "node:crypto";
import {
  certificateSigningMessage,
  requestSigningMessage,
  type Certificate,
  type CertificateBody,
} from "../src/protocol.ts";
import {
  generateKeyPair,
  importPrivateKeyPkcs8,
  randomBytes,
  sha256Hex,
  signEd25519,
  toBase64Url,
  type KeyPair,
} from "../src/crypto.ts";
import { encodeCertificate, issueCertificate } from "../src/certificates.ts";
import pointerWorker, { type Env } from "../src/index.ts";
import { PointerObject } from "../src/pointer-object.ts";
import { RegistryObject } from "../src/registry-object.ts";

Object.defineProperty(crypto.subtle, "timingSafeEqual", {
  configurable: true,
  value: (a: Uint8Array, b: Uint8Array) => timingSafeEqual(a, b),
});
export const NOW = Math.floor(Date.now() / 1000);
export const SERVICE = "https://pointer.example";
export const ROOT =
  "bafyreid3qonq3i2rjekgz7mtarpu4zbfmgg4uhtcjtpijdgrrhdke5opzq";
export const ROOT2 =
  "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3ognsctz5sq3tv5yo2aqgndou";
export const API_KEY = toBase64Url(new Uint8Array(32).fill(7));
export async function makeCert(
  owner: KeyPair,
  member: KeyPair,
  pointerId: string,
  overrides: Partial<CertificateBody> = {},
): Promise<Certificate> {
  return issueCertificate(
    {
      v: 2,
      service: SERVICE,
      pointerId,
      owner: owner.publicRaw,
      member: member.publicRaw,
      cid: toBase64Url(randomBytes(16)),
      iat: NOW - 1,
      exp: NOW + 3600,
      ...overrides,
    },
    await importPrivateKeyPkcs8(owner.privatePkcs8),
  );
}
export interface SignedOptions {
  key: KeyPair;
  method?: string;
  path?: string;
  pointerId?: string;
  service?: string;
  body?: string;
  bodyBytes?: Uint8Array;
  ifMatch?: string;
  timestamp?: number;
  nonce?: string;
  idempotencyKey?: string;
  certificate?: Certificate;
  apiKey?: string;
  subject?: string;
}
export async function signedRequest(options: SignedOptions): Promise<Request> {
  const method = options.method ?? "GET";
  const pointerId = options.pointerId ?? "";
  const path = options.path ?? `/v1/pointers/${pointerId}`;
  const body = options.body ?? "";
  const timestamp = options.timestamp ?? NOW;
  const nonce = options.nonce ?? toBase64Url(randomBytes(24));
  const subject = options.subject ?? options.key.publicRaw;
  const ifMatch = options.ifMatch ?? "",
    idempotencyKey = options.idempotencyKey ?? "";
  const signature = await signEd25519(
    await importPrivateKeyPkcs8(options.key.privatePkcs8),
    requestSigningMessage({
      service: options.service ?? SERVICE,
      pointerId,
      method,
      path,
      timestamp,
      nonce,
      subject,
      ifMatch,
      idempotencyKey,
      bodySha256: await sha256Hex(options.bodyBytes ?? body),
    }),
  );
  const headers = new Headers({
    authorization: `Ed25519 ${signature}`,
    "x-pointer-timestamp": String(timestamp),
    "x-pointer-nonce": nonce,
    "x-pointer-subject": subject,
  });
  if (options.certificate)
    headers.set("x-pointer-cert", encodeCertificate(options.certificate));
  if (options.apiKey) headers.set("x-api-key", options.apiKey);
  if (ifMatch) headers.set("if-match", ifMatch);
  if (idempotencyKey) headers.set("idempotency-key", idempotencyKey);
  if (body || options.bodyBytes)
    headers.set("content-type", "application/json");
  return new Request(`${SERVICE}${path}`, {
    method,
    headers,
    ...(options.bodyBytes
      ? { body: new Uint8Array(options.bodyBytes) }
      : body
        ? { body }
        : {}),
  });
}
export class MemoryStorage {
  readonly data = new Map<string, unknown>();
  failBeforeCommit = false;
  failAfterCommit = false;
  #tail: Promise<void> = Promise.resolve();
  get<T>(key: string): Promise<T | undefined> {
    return Promise.resolve(
      structuredClone(this.data.get(key)) as T | undefined,
    );
  }
  put(key: string, value: unknown): Promise<void> {
    this.data.set(key, structuredClone(value));
    return Promise.resolve();
  }
  list<T>(options: { prefix: string }): Promise<Map<string, T>> {
    return Promise.resolve(
      new Map(
        [...this.data]
          .filter(([key]) => key.startsWith(options.prefix))
          .map(([key, value]) => [key, structuredClone(value) as T]),
      ),
    );
  }
  delete(key: string): Promise<boolean> {
    return Promise.resolve(this.data.delete(key));
  }
  async transaction<T>(
    callback: (txn: MemoryStorage) => Promise<T>,
  ): Promise<T> {
    const before = this.#tail;
    let release = (): void => {};
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await before;
    try {
      const txn = new MemoryStorage();
      for (const [key, value] of this.data)
        txn.data.set(key, structuredClone(value));
      const result = await callback(txn);
      if (this.failBeforeCommit)
        throw new Error("injected storage failure before commit");
      this.data.clear();
      for (const [key, value] of txn.data)
        this.data.set(key, structuredClone(value));
      if (this.failAfterCommit)
        throw new Error("injected ambiguous storage commit");
      return result;
    } finally {
      release();
    }
  }
}
export function testContext(storage = new MemoryStorage()): {
  ctx: DurableObjectState;
  storage: MemoryStorage;
} {
  return {
    storage,
    ctx: {
      storage,
      blockConcurrencyWhile: async <T>(fn: () => Promise<T>): Promise<T> =>
        fn(),
    } as unknown as DurableObjectState,
  };
}
export interface Service {
  env: Env;
  pointers: Map<string, PointerObject>;
  pointerStores: Map<string, MemoryStorage>;
  registryStore: MemoryStorage;
  restart(): void;
  fetch: typeof fetch;
}
export async function createService(
  options: { service?: string; digest?: string; allowedOrigin?: string } = {},
): Promise<Service> {
  const pointers = new Map<string, PointerObject>();
  const pointerStores = new Map<string, MemoryStorage>();
  const registryStore = new MemoryStorage();
  let registry: RegistryObject | undefined;
  const env = {
    POINTER_SERVICE: options.service ?? SERVICE,
    POINTER_API_KEY_SHA256: options.digest ?? (await sha256Hex(API_KEY)),
    ALLOWED_ORIGIN: options.allowedOrigin,
    POINTER: {
      idFromName: (name: string) => name,
      get: (name: string) => {
        let instance = pointers.get(name);
        if (!instance) {
          const storage = pointerStores.get(name) ?? new MemoryStorage();
          pointerStores.set(name, storage);
          instance = new PointerObject(testContext(storage).ctx, environment);
          pointers.set(name, instance);
        }
        return instance;
      },
    },
    REGISTRY: {
      idFromName: (name: string) => name,
      get: () =>
        (registry ??= new RegistryObject(
          testContext(registryStore).ctx,
          environment,
        )),
    },
  };
  const environment = env as unknown as Env;
  return {
    env: environment,
    pointers,
    pointerStores,
    registryStore,
    restart: () => {
      pointers.clear();
      registry = undefined;
    },
    fetch: (input, init) =>
      pointerWorker.fetch(
        input instanceof Request ? input : new Request(input, init),
        environment,
      ),
  };
}
export async function createPointer(
  service: Service,
  owner: KeyPair,
  root = ROOT,
  idempotencyKey?: string,
): Promise<string> {
  const response = await service.fetch(
    await signedRequest({
      key: owner,
      method: "POST",
      body: JSON.stringify({ owner: owner.publicRaw, root }),
      apiKey: API_KEY,
      ...(idempotencyKey ? { idempotencyKey } : {}),
    }),
  );
  if (response.status !== 201)
    throw new Error(
      `creation failed: ${response.status}: ${await response.text()}`,
    );
  return (await response.json<{ id: string }>()).id;
}
export async function responseJson(response: Response): Promise<unknown> {
  return response.json();
}
export { certificateSigningMessage, generateKeyPair };
