/**
 * Shared fixtures for the pointer Worker tests.
 *
 * Everything runs in-process: Durable Objects get an in-memory
 * `DurableObjectState`, and requests are dispatched straight into the Worker's
 * fetch handler. That keeps the real router, authentication and state machine in
 * the loop without starting workerd.
 */
import {
  type Certificate,
  type CertificateBody,
  type DelegatedScope,
  type RequestProof,
  EMPTY_BODY_SHA256,
  normalizeScope,
  requestSigningMessage,
} from "../src/protocol.ts";
import {
  generateKeyPair,
  importPrivateKeyPkcs8,
  keyId,
  loadTrustAnchor,
  randomBytes,
  sha256Hex,
  signEd25519,
  toBase64Url,
  type KeyPair,
} from "../src/crypto.ts";
import { encodeCertificate, issueCertificate } from "../src/certificates.ts";
import pointerWorker from "../src/index.ts";
import type { Env } from "../src/index.ts";
import { PointerObject } from "../src/pointer-object.ts";
import { RegistryObject } from "../src/registry-object.ts";
import type { AuthContext } from "../src/verify.ts";

/** Fixed clock used across the fixtures, in unix seconds. */
export const NOW = Math.floor(Date.now() / 1000);

export interface Identity {
  keys: KeyPair;
  chain: Certificate[];
  subject: string;
}

export async function makeCert(
  issuer: { keys: KeyPair; chain: Certificate[]; subject: string },
  holder: { keys: KeyPair; subject: string },
  scope: Partial<DelegatedScope>,
  options: { ca?: boolean; iat?: number; exp?: number } = {},
): Promise<Certificate> {
  const parent = issuer.chain[0]?.body;
  const issuerKey = await importPrivateKeyPkcs8(issuer.keys.privatePkcs8);
  const body: CertificateBody = {
    v: 1,
    sub: holder.subject,
    pub: holder.keys.publicRaw,
    scope: normalizeScope(scope),
    iss: issuer.subject,
    iss_pub: issuer.keys.publicRaw,
    kid: await keyId(holder.keys.publicRaw),
    cid: toBase64Url(randomBytes(16)),
    iat: options.iat ?? parent?.iat ?? NOW - 60,
    exp: options.exp ?? parent?.exp ?? NOW + 3600,
    ca: options.ca ?? false,
  };
  return issueCertificate(body, issuerKey);
}

/**
 * Trust layout used by most tests:
 *
 *   anchor "alice" (pinned in the Worker; the private key never leaves alice)
 *     ├─ CA cert "alice"             scope read+write, may name "alice/*"
 *     │    ├─ leaf "alice/agent-1"       read+write
 *     │    └─ leaf "alice/reader"        read only
 *     └─ CA cert "alice/team"        scope read+write, may name "alice/team/*"
 *          └─ leaf "alice/team/agent-2"   read+write
 */
export async function world() {
  const root = await generateKeyPair();
  const anchor = await loadTrustAnchor(root.publicRaw);

  const alice = { keys: root, chain: [] as Certificate[], subject: "alice" };
  const ca = await makeCert(
    alice,
    { keys: root, subject: "alice" },
    { read: true, write: true, sub: "alice*" },
    { ca: true },
  );

  const teamKeys = await generateKeyPair();
  const teamCa = await makeCert(
    alice,
    { keys: teamKeys, subject: "alice/team" },
    { read: true, write: true, sub: "alice/team*" },
    { ca: true },
  );
  const team = { keys: teamKeys, chain: [teamCa], subject: "alice/team" };

  const agent1Keys = await generateKeyPair();
  const agent1Cert = await makeCert(
    { keys: root, chain: [ca], subject: "alice" },
    { keys: agent1Keys, subject: "alice/agent-1" },
    { read: true, write: true, sub: "alice/agent-1" },
  );
  const agent1: Identity = {
    keys: agent1Keys,
    chain: [agent1Cert, ca],
    subject: "alice/agent-1",
  };

  const readerKeys = await generateKeyPair();
  const readerCert = await makeCert(
    { keys: root, chain: [ca], subject: "alice" },
    { keys: readerKeys, subject: "alice/reader" },
    { read: true, write: false, sub: "alice/reader" },
  );
  const reader: Identity = {
    keys: readerKeys,
    chain: [readerCert, ca],
    subject: "alice/reader",
  };

  const agent2Keys = await generateKeyPair();
  const agent2Cert = await makeCert(
    team,
    { keys: agent2Keys, subject: "alice/team/agent-2" },
    { read: true, write: true, sub: "alice/team/agent-2" },
  );
  const agent2: Identity = {
    keys: agent2Keys,
    chain: [agent2Cert, teamCa, ca],
    subject: "alice/team/agent-2",
  };

  return { root, anchor, ca, teamCa, agent1, agent2, reader };
}

export interface SignedOptions {
  method?: string;
  path?: string;
  body?: string;
  ifMatch?: string | null;
  timestamp?: number;
  nonce?: string;
  scope?: DelegatedScope;
  subject?: string;
  key?: KeyPair;
  chain?: Certificate[];
  signWith?: KeyPair;
}

export async function signedRequest(
  options: SignedOptions = {},
): Promise<Request> {
  const method = options.method ?? "GET";
  const path = options.path ?? "/v1/value";
  const body = options.body ?? "";
  const timestamp = options.timestamp ?? NOW;
  const nonce = options.nonce ?? toBase64Url(randomBytes(18));
  const subject =
    options.subject ?? (options.chain ? options.chain[0]!.body.sub : "alice");
  const ifMatch = options.ifMatch ?? "";

  const proof: RequestProof = {
    method,
    path,
    timestamp,
    nonce,
    bodySha256: body ? await sha256Hex(body) : EMPTY_BODY_SHA256,
    ifMatch,
    subject,
  };
  const signerKeys = options.signWith ?? options.key;
  if (!signerKeys) throw new Error("signedRequest needs a signing key");
  const privateKey = await importPrivateKeyPkcs8(signerKeys.privatePkcs8);
  const signature = await signEd25519(privateKey, requestSigningMessage(proof));

  const headers = new Headers({
    authorization: `Ed25519 ${signature}`,
    "x-pointer-timestamp": String(timestamp),
    "x-pointer-nonce": nonce,
  });
  for (const cert of options.chain ?? []) {
    headers.append("x-pointer-cert", encodeCertificate(cert));
  }
  headers.set("x-pointer-subject", subject);
  if (ifMatch) headers.set("if-match", ifMatch);
  if (options.scope)
    headers.set("x-pointer-scope", JSON.stringify(options.scope));
  if (body) headers.set("content-type", "application/json");

  return new Request(`https://pointer.example${path}`, {
    method,
    headers,
    ...(body ? { body } : {}),
  });
}

export function authContext(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    keyId: "kid",
    certId: "cid",
    subject: "alice/agent-1",
    scope: { read: true, write: true },
    timestamp: NOW,
    nonce: toBase64Url(randomBytes(18)),
    ifMatch: null,
    direct: false,
    ...overrides,
  };
}

/** Minimal DurableObjectStorage backed by a Map. */
export class MemoryStorage {
  readonly data = new Map<string, unknown>();

  get<T>(key: string): Promise<T | undefined> {
    return Promise.resolve(this.data.get(key) as T | undefined);
  }

  put(key: string, value: unknown): Promise<void> {
    this.data.set(key, value);
    return Promise.resolve();
  }

  deleteAll(): Promise<void> {
    this.data.clear();
    return Promise.resolve();
  }
}

export interface TestContext {
  ctx: DurableObjectState;
  storage: MemoryStorage;
}

/** In-memory DurableObjectState; runs blockConcurrencyWhile immediately. */
export function testContext(storage = new MemoryStorage()): TestContext {
  const ctx = {
    storage,
    blockConcurrencyWhile: async <T>(fn: () => Promise<T>): Promise<T> => fn(),
  } as unknown as DurableObjectState;
  return { ctx, storage };
}

export interface Service {
  env: Env;
  /** Pointers created by this service, by Durable Object name. */
  pointers: Map<string, unknown>;
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  /** Number of Pointers materialised so far (one per created name). */
  pointerCount(): number;
}

export interface ServiceOptions {
  adminPublicKey?: string;
  allowedOrigin?: string;
  /** Reuse a context so a test can force storage failures. */
  pointerContext?: () => DurableObjectState;
}

export function createService(options: ServiceOptions = {}): Service {
  const pointers = new Map<string, unknown>();
  const registries = new Map<string, unknown>();
  const contextFor = options.pointerContext ?? (() => testContext().ctx);

  const env: Record<string, unknown> = {
    POINTER: {
      idFromName: (name: string) => name as unknown as DurableObjectId,
      get: (id: DurableObjectId) => {
        const name = String(id);
        let instance = pointers.get(name);
        if (!instance) {
          instance = new PointerObject(contextFor(), env as unknown as Env);
          pointers.set(name, instance);
        }
        return instance;
      },
    },
    REGISTRY: {
      idFromName: (name: string) => name as unknown as DurableObjectId,
      get: (id: DurableObjectId) => {
        const name = String(id);
        let instance = registries.get(name);
        if (!instance) {
          instance = new RegistryObject(
            testContext().ctx,
            env as unknown as Env,
          );
          registries.set(name, instance);
        }
        return instance;
      },
    },
    ...(options.adminPublicKey === undefined
      ? {}
      : { POINTER_ADMIN_PUBLIC_KEY: options.adminPublicKey }),
    ...(options.allowedOrigin === undefined
      ? {}
      : { ALLOWED_ORIGIN: options.allowedOrigin }),
  };

  const environment = env as unknown as Env;
  return {
    env: environment,
    pointers,
    pointerCount: () => pointers.size,
    fetch: (input, init) => {
      const request =
        input instanceof Request ? input : new Request(String(input), init);
      return pointerWorker.fetch(request, environment);
    },
  };
}

export function jsonBody(value: unknown): string {
  return JSON.stringify(value);
}

export async function responseJson(response: Response): Promise<unknown> {
  return JSON.parse(await response.text()) as unknown;
}
