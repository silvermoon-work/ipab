import { timingSafeEqual } from "node:crypto";
import {
  ScopeClient,
  issueScopeCertificate,
  uniqueId,
} from "@ipab/bundle/pointer/scope";
import {
  generateKeyPair,
  importPrivateKeyPkcs8,
  sha256Hex,
  toBase64Url,
} from "../src/crypto.ts";
import pointerWorker, { type Env } from "../src/index.ts";
import { ScopeObject } from "../src/scope-object.ts";
import { ScopeRegistry } from "../src/scope-registry.ts";

Object.defineProperty(crypto.subtle, "timingSafeEqual", {
  configurable: true,
  value: (a: Uint8Array, b: Uint8Array) => timingSafeEqual(a, b),
});
export const NOW = Math.floor(Date.now() / 1000);
export const SERVICE = "https://pointer.example";
export const ROOT =
  "bafyreid3qonq3i2rjekgz7mtarpu4zbfmgg4uhtcjtpijdgrrhdke5opzq";
export const API_KEY = toBase64Url(new Uint8Array(32).fill(7));
export { generateKeyPair };

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
export async function createScopeService(
  options: { service?: string; digest?: string; allowedOrigin?: string } = {},
) {
  const stores = new Map<string, MemoryStorage>(),
    objects = new Map<string, ScopeObject>(),
    registries = new Map<string, ScopeRegistry>();
  const storageFor = (id: string) => {
    let storage = stores.get(id);
    if (!storage) {
      storage = new MemoryStorage();
      stores.set(id, storage);
    }
    return storage;
  };
  const environment = {
    POINTER_SERVICE: options.service ?? SERVICE,
    POINTER_API_KEY_SHA256: options.digest ?? (await sha256Hex(API_KEY)),
    ALLOWED_ORIGIN: options.allowedOrigin ?? "",
    SCOPE: {
      getByName: (id: string) => {
        let object = objects.get(id);
        if (!object) {
          object = new ScopeObject(testContext(storageFor(id)).ctx, env);
          objects.set(id, object);
        }
        return object;
      },
    },
    SCOPE_REGISTRY: {
      getByName: (id: string) => {
        let object = registries.get(id);
        if (!object) {
          object = new ScopeRegistry(testContext(storageFor(id)).ctx, env);
          registries.set(id, object);
        }
        return object;
      },
    },
  };
  const env = environment as unknown as Env;
  const fetcher: typeof fetch = (input, init) =>
    pointerWorker.fetch(
      input instanceof Request ? input : new Request(input, init),
      env,
    );
  return {
    env,
    stores,
    objects,
    fetch: fetcher,
    restart() {
      objects.clear();
      registries.clear();
    },
  };
}
export async function scopeWorld() {
  const service = await createScopeService(),
    owner = await generateKeyPair(),
    member = await generateKeyPair();
  const signer = { publicKey: owner.publicRaw, privateKey: owner.privatePkcs8 };
  const client = new ScopeClient({
    service: SERVICE,
    signer,
    apiKey: API_KEY,
    fetch: service.fetch,
  });
  const scope = await client.createScope(uniqueId()),
    variable = await client.create(scope.id, { root: "A" }, uniqueId()),
    profile = await client.create(scope.id, {}, uniqueId());
  const certificate = await issueScopeCertificate(
    {
      v: 1,
      service: SERVICE,
      scopeId: scope.id,
      subject: member.publicRaw,
      write: [variable.id, profile.id],
    },
    await importPrivateKeyPkcs8(owner.privatePkcs8),
  );
  const memberClient = new ScopeClient({
    service: SERVICE,
    fetch: service.fetch,
    signer: {
      publicKey: member.publicRaw,
      privateKey: member.privatePkcs8,
      certificate,
    },
  });
  const reader = new ScopeClient({ service: SERVICE, fetch: service.fetch });
  return {
    service,
    owner,
    member,
    client,
    scope,
    variable,
    profile,
    certificate,
    memberClient,
    reader,
  };
}
