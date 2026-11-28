# Scope / Variable service

The previous Pointer v2 / revision-CAS contract is intentionally unsupported.
The canonical API, signing bytes, exact-ID nonexpiring certificates, public
reads, lifecycle, limits and recovery behavior are documented in
[Scope / Variable onboarding](onboarding.md#resource-service).

The private `@ipab/pointer-worker` package supplies a Cloudflare Worker with one
SQLite-backed Durable Object per Scope. Configure the exact canonical
`POINTER_SERVICE` origin and secret `POINTER_API_KEY_SHA256`; the creation API
key is never used for public reads or normal Variable writes. Existing
deployment DO classes remain declared in migration history only; old routes are
unavailable.

```sh
pnpm --filter @ipab/pointer-worker exec wrangler types worker-configuration.d.ts --include-runtime false --strict-vars false
pnpm --filter @ipab/pointer-worker typecheck
pnpm --filter @ipab/pointer-worker test-ci
```

Generated binding types are committed; secret typing is separately augmented.
Tests exercise canonical Worker routing with a transactional in-memory DO port.
Real private-network acceptance uses isolated Kubo repos and processes, never an
existing user's daemon. No deployment is performed by normal onboarding.
