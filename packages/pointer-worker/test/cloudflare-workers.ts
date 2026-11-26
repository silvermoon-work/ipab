/**
 * Node stand-in for the Workers-only `cloudflare:workers` module.
 *
 * Vitest aliases the import to this file (see ../../vitest.config.ts) so the
 * Durable Object classes can be constructed with an in-memory
 * `DurableObjectState` in tests. The real module is only available inside the
 * Workerd runtime used by `wrangler dev` / `wrangler deploy`; TypeScript keeps
 * checking call sites against the declarations in @cloudflare/workers-types.
 */
export class DurableObject<Env = unknown> {
  protected readonly ctx: DurableObjectState;
  protected readonly env: Env;

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}
