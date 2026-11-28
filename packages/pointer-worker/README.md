# @ipab/pointer-worker

Private Cloudflare Scope / Variable service. One immutable-Owner Scope Durable
Object atomically coordinates independent opaque Variables, content CID CAS
(including ABA), nonces, idempotency and irreversible writable→frozen→deleted
lifecycle. Live values are public; only writes and Owner management
authenticate. The old Pointer v2 routes and revision semantics are unsupported.

See [the implemented protocol and device journey](../../docs/onboarding.md) for
schemas, signing tuples, limits, certificates, Kubo onboarding and removal.

## Local operator

Use the workspace's exact Node/pnpm. Configure `POINTER_SERVICE` and the
`POINTER_API_KEY_SHA256` secret in ignored `.dev.vars` for local development.
Production deployment is always explicit. Logs/traces are enabled without
logging credentials, keys, certificates or request bodies.

```powershell
pnpm cli api-key
pnpm cli keygen --out .keys\owner.json
pnpm dev
```

`api-key` prints a new raw key once and its SHA-256 digest. Do not run it in a
recorded terminal or store the first line in logs. Only Scope allocation uses
the origin-bound API key. A protected operator JSON config may contain
`pointers.service` and `pointers.apiKey`, selected with `--config-file`;
`--api-key-file` selects a protected raw-key file instead. No plaintext
command-line API-key parameter exists.

```powershell
pnpm cli create-scope --key .keys\owner.json --config-file .keys\service.json --idempotency-key SAVED_OPERATION_KEY
pnpm cli create --key .keys\owner.json --service https://service.example --scope SCOPE_ID --value '{"hello":"world"}'
pnpm cli read --service https://service.example --scope SCOPE_ID --id VARIABLE_ID
pnpm cli write --key .keys\owner.json --service https://service.example --scope SCOPE_ID --id VARIABLE_ID --value '{"hello":"again"}' --if-cid CONTENT_CID
pnpm cli freeze --key .keys\owner.json --service https://service.example --scope SCOPE_ID --id VARIABLE_ID
pnpm cli delete --key .keys\owner.json --service https://service.example --scope SCOPE_ID --id VARIABLE_ID
```

`certify --issuer OWNER_FILE --subject PUBLIC_KEY --scope SCOPE_ID --write HEAD_ID,PROFILE_ID --out CERTIFICATE_FILE`
issues a nonexpiring exact-ID write certificate. It is not a member keystore or
bearer token; members must prove subject-key possession. IPAB's ordinary file
Request flow packages certificates securely without requiring members to use
this operator.

Regenerate bindings after config changes:

```powershell
pnpm exec wrangler types worker-configuration.d.ts --include-runtime false --strict-vars false
pnpm typecheck
pnpm test-ci
```

Wrangler migration history retains old classes, not old HTTP routes. The new
Scope classes use SQLite-backed storage and RPC. Unit/mock tests use a
transactional DO port; `test\mvp.test.ts` additionally runs isolated, checksum-
installed real Kubo nodes, uncached two-way transfers, multiple private networks
and interrupted removal recovery. It never controls a shared daemon.
