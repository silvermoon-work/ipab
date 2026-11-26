# @ipab/pointer-worker

Private Cloudflare Worker for signed swarm publication pointers. Each random
opaque pointer ID has one SQLite-backed Durable Object, an immutable full
Ed25519 owner key, a canonical publication CID `root` (≤256 UTF-8 bytes), and a
positive decimal string `revision`. One account key may own many pointers. This
operator tool is separate from the IPAB CLI; it does not create Swarm Bundles or
implement swarm synchronization.

## API

| Method | Route               | Authorization                              | Success                       |
| ------ | ------------------- | ------------------------------------------ | ----------------------------- |
| POST   | `/v1/pointers/`     | `X-API-Key` + direct owner signature       | `201 {id}`, `Location`        |
| GET    | `/v1/pointers/{id}` | owner/member signature                     | `200 {root,revision}`, `ETag` |
| PUT    | `/v1/pointers/{id}` | owner/member signature + strong `If-Match` | same as GET                   |

POST body is `{owner,root}`; owner is the unpadded base64url encoding of the
complete 32-byte public key. Initial revision is `"1"`. PUT body is `{root}`.
Unknown fields and invalid/noncanonical CIDs are rejected. Only a single strong
positive decimal ETag is accepted: `If-Match: "12"`. Missing is 428; malformed
is 400. Authorized CAS conflicts return 412 with current ETag and
`{error:{code:"precondition_failed",message,details:{root,revision}}}`. Even
writing the same root advances the revision. All responses are `no-store`.

`GET /_health` contains no pointer data. There are no challenges, public pointer
reads, named variables, admin, rotation, deletion or capabilities APIs. Protocol
version 2 deliberately does not migrate legacy named-variable storage.

### Signatures and members

Every request carries `Authorization: Ed25519 <signature>`, `X-Pointer-Subject`
(full signing public key), `X-Pointer-Timestamp` (Unix seconds) and
`X-Pointer-Nonce` (base64url, 22–128 characters; generate at least 128 random
bits). `requestSigningMessage()` signs the UTF-8 JSON tuple:

```text
["IPAB-POINTER/2", service, pointerId, METHOD, path,
 rawBodySHA256Hex, rawIfMatchOrEmpty, idempotencyKeyOrEmpty,
 timestamp, nonce, fullSigningPublicKey]
```

`service` is the configured canonical HTTPS origin, not Host/forwarded headers.
HTTP origins are permitted only for `localhost`, `127.0.0.1` and `[::1]` in
development. Query parameters are not supported. Member requests carry exactly
one `X-Pointer-Cert`, base64url JSON `{body,sig}`. The owner signs:

```text
["IPAB-POINTER-CERT/2", service, pointerId, owner, member, cid, iat, exp]
```

Body fields are `{v:2,service,pointerId,owner,member,cid,iat,exp}`. `cid` is a
random 16-byte base64url certificate identifier; validity is checked without
clock-skew extensions. All valid members can read/write. Certificates must be
issued directly by the stored owner: no CA chains, scopes or member delegation.

Timestamp skew is ±60 seconds. Nonces are durably retained for 130 seconds. The
5000-live-nonce bound fails closed with 429, never evicting live entries. Bodies
are bounded at 4096 bytes, encoded certificates at 4096 bytes, and total header
names/values at 16384 UTF-8 bytes before parsing/body buffering.

### Persistence and retries

Use a persistent `Idempotency-Key` for every retriable POST/PUT. Retrying uses a
**fresh nonce and timestamp**, but exactly the same signer, raw body, target and
If-Match. Captured proof reuse is always rejected, even with an idempotency key.
Different parameters under the same signer/key return 409. Authorization must
still be valid before any cached result is returned.

Creation atomically saves an allocation and retry record in the Registry before
idempotently configuring the Pointer; 201 is sent only after configuration is
persisted. Ambiguous failures/restarts recover the same ID using the original
key. Do not abandon a failed creation's key or retry without it: without a key
the service cannot correlate separate creation intents.

Pointer transactions commit nonce consumption, CAS and original retry results
atomically. Retrying a successful write within the retention window returns its
original result, not the latest state or an extra revision.

Completed creation records and write retry records expire **600 seconds** after
their first durable completion/commit; retries do not renew expiry. Expiry is
persisted and expired records are lazily pruned transactionally on subsequent
operations. After expiry the same key may represent a new operation; a new
creation can legitimately receive another ID, and a write still needs the
current If-Match. Existing pointer resources are never deleted by retry pruning.

The concrete cap is **200 live creation allocations service-wide** and **200
live write retry records per pointer**. A new keyed write or creation that would
exceed its cap returns 429, without evicting unexpired records. Existing valid
retries remain recoverable at capacity. Reads and unkeyed writes do not need a
write retry slot. Successful unkeyed creations release their allocation after
configuration is confirmed.

Incomplete creation allocations count toward the same 200-slot cap and **do not
expire automatically**, including across ambiguous configure/finalization
failures and restarts. Their ten-minute completed-retention window starts only
after Pointer persistence is confirmed and Registry completion is persisted.
Recover them by repeating the signed POST with the original key/body and a fresh
proof, even after ten minutes. If keys are lost or an unkeyed creation fails,
operator intervention is required: inspect the bounded pending allocations,
idempotently configure their Pointer from the stored config and complete the
allocation through the trusted internal binding. Do not delete a pending record
until persistence is confirmed. There is no public admin cleanup/rotation API.

Provisional v2 write records without expiry receive a persisted ten-minute grace
window on first access. Older creation allocations lacking completion metadata
remain protected pending confirmation; a retry or trusted internal recovery
reconfirms configuration before starting their completed-retention window.

## Operator setup

Use the exact Node/pnpm versions from the workspace. No deployment is performed
automatically. From this package:

```powershell
pnpm cli api-key
pnpm cli keygen --out .keys\owner.json
pnpm cli keygen --out .keys\member.json
```

`api-key` generates 32 cryptographically random bytes and prints the raw
base64url key **once**, followed by its SHA-256 configuration digest. Hashing
uses the UTF-8 encoded canonical key string. Do not run it in recorded terminal
sessions, copy the key to logs, or put it in command-line arguments. The Worker
validates the digest using Workers' native constant-time
`crypto.subtle.timingSafeEqual`; it never stores the raw key.

Copy `.dev.vars.example` to `.dev.vars`, set the printed
`POINTER_API_KEY_SHA256` digest, and keep local
`POINTER_SERVICE="http://127.0.0.1:8787"`. Run `pnpm dev`. For deployment set
the exact canonical origin in `wrangler.toml` and use
`pnpm exec wrangler secret put POINTER_API_KEY_SHA256` for the digest.
`ALLOWED_ORIGIN` optionally enables one explicit browser origin. Logs and traces
are enabled without logging credentials or request bodies.

### Client configuration and commands

The operator accepts a separate protected flat JSON file:

```json
{
  "pointers.service": "http://127.0.0.1:8787",
  "pointers.apiKey": "<operator-distributed key>"
}
```

`--config-file` reads this file, **not** IPAB's SQLite cfg. It does not invoke
`ipab config get` or assume that config queries reveal a secret. Alternative
environment keys are `IPAB_POINTERS_SERVICE` / `IPAB_POINTERS_API_KEY`.
`--service` overrides service env/config; `--api-key-file` reads a protected
file containing only the key, overriding key env/config. No plaintext
`--api-key` argument exists. API keys are sent only on creation to the explicit
configured origin; redirects are rejected.

The separate IPAB CLI also recognizes these two cfg keys and aligned environment
variables, but does not yet implement swarm commands. Its API key write is
stdin-only, for example
`Get-Content -Raw .keys\api-key.txt | ipab config set pointers.apiKey -`;
`ipab config get` and save confirmations always redact the key, including JSON.
That cfg stays in the existing account-protected State SQLite database and is
not automatically read by this operator.

Config, API-key and private-key files must be accessible only by their owning OS
account. Reads fail closed on broad permissions: Unix requires owner-only mode
and matching UID; Windows checks allowed ACL entries against the current account
SID. Newly created keystore directories/files are protected with Unix 700/600 or
Windows account-only ACLs. Existing directories are not silently repermissioned;
choose a private directory. Files are exclusive-create, never overwritten. Keep
`.keys`, `.dev.vars` and protected config outside Git.

```powershell
pnpm cli create --config-file .keys\config.json --key .keys\owner.json --root <initial-publication-cid> --idempotency-key <creation-id>
pnpm cli read --config-file .keys\config.json --key .keys\owner.json --id <pointer-id>
pnpm cli write --config-file .keys\config.json --key .keys\owner.json --id <pointer-id> --root <next-publication-cid> --if-revision 1 --idempotency-key <publication-id>
pnpm cli certify --config-file .keys\config.json --issuer .keys\owner.json --member-key .keys\member.json --id <pointer-id> --days 7 --out .keys\certified-member.json
pnpm cli read --config-file .keys\config.json --key .keys\certified-member.json --id <pointer-id>
```

Save the returned pointer ID before building any higher-level descriptor. API
keys only authorize creation; they never authorize GET/PUT or certificates.

## IPAB Worker Bundle

`pnpm exec turbo run build --filter=@ipab/pointer-worker` builds
`dist/worker.car` and writes its CID to `dist/worker.cid`, without importing or
pinning content. The Bundle contains prebuilt ESM and the portable
compatibility/DO/migration/observability contract read from `wrangler.toml`; it
excludes account names, routes, instance vars, credentials and secrets. The
Worker source and existing direct `pnpm dev` / `pnpm deploy` remain unchanged.

Two [self-installing Apps](../../apps/cf-tools/README.md) consume the same
Worker Bundle for local simulation or explicitly authorized deployment.

## Validation

```powershell
pnpm --filter @ipab/pointer-worker typecheck
pnpm --filter @ipab/pointer-worker test
pnpm --filter @ipab/pointer-worker test-coverage
```

Tests exercise pure protocol/crypto utilities and the complete router/DO path
with transactional in-memory storage, including concurrent CAS, replay,
capacity, tampering, cross-service/pointer certificates, restart and ambiguous
storage failures. Shared Vitest aliases `cloudflare:workers` to a Node stub;
these are not deployed workerd tests. Type-aware lint and all four unchanged
global 90% coverage gates remain enforced. See the
[confirmed service design](../../docs/pointers-service.md).
