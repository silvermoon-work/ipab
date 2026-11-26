import { DurableObject } from "cloudflare:workers";
import { NONCE_TTL_SECONDS, type PointerConfig } from "./protocol.ts";

const KEY_VARIABLES = "variables";
const KEY_NONCES = "nonces";
const MAX_NONCES = 5000;

/**
 * The service-wide index of pointers: name -> { pubkey, createdAt }.
 *
 * Only the admin API talks to this object, so it is off the hot data path.
 * Data requests read their anchor from the variable's own PointerObject.
 */
export class RegistryObject extends DurableObject {
  #variables: Record<string, PointerConfig> = {};
  #nonces = new Map<string, number>();
  #ready: Promise<void>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#ready = ctx.blockConcurrencyWhile(async () => {
      const [stored, nonces] = await Promise.all([
        this.ctx.storage.get<Record<string, PointerConfig>>(KEY_VARIABLES),
        this.ctx.storage.get<Record<string, number>>(KEY_NONCES),
      ]);
      this.#variables = stored ?? {};
      this.#nonces = new Map(Object.entries(nonces ?? {}));
    });
  }

  /**
   * One-shot admin nonce. Admin mutations are not covered by the pointer's
   * nonce store, so the registry keeps its own replay window.
   */
  async consumeNonce(nonce: string, nowSeconds: number): Promise<boolean> {
    await this.#ready;
    for (const [value, expiresAt] of this.#nonces) {
      if (expiresAt <= nowSeconds) this.#nonces.delete(value);
    }
    if (this.#nonces.has(nonce)) return false;
    this.#nonces.set(nonce, nowSeconds + NONCE_TTL_SECONDS);
    if (this.#nonces.size > MAX_NONCES) {
      const oldest = [...this.#nonces.entries()].sort((a, b) => a[1] - b[1]);
      for (let i = 0; i < oldest.length - MAX_NONCES; i++)
        this.#nonces.delete(oldest[i]![0]);
    }
    await this.ctx.storage.put(KEY_NONCES, Object.fromEntries(this.#nonces));
    return true;
  }

  async list(): Promise<PointerConfig[]> {
    await this.#ready;
    return Object.values(this.#variables).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }

  async get(name: string): Promise<PointerConfig | null> {
    await this.#ready;
    return this.#variables[name] ?? null;
  }

  /** Atomically reserves a name. False means it already exists. */
  async create(config: PointerConfig): Promise<boolean> {
    await this.#ready;
    if (this.#variables[config.name]) return false;
    this.#variables[config.name] = config;
    await this.ctx.storage.put(KEY_VARIABLES, this.#variables);
    return true;
  }

  /** Updates an existing record (used for key rotation). */
  async put(config: PointerConfig): Promise<void> {
    await this.#ready;
    this.#variables[config.name] = config;
    await this.ctx.storage.put(KEY_VARIABLES, this.#variables);
  }

  async remove(name: string): Promise<boolean> {
    await this.#ready;
    if (!this.#variables[name]) return false;
    delete this.#variables[name];
    await this.ctx.storage.put(KEY_VARIABLES, this.#variables);
    return true;
  }
}
