# MVP implementation decisions

## Protocol and authorization

The immutable swarm identifier is a typed Descriptor Bundle CID. Its entry has
exactly `service`, `variable`, and the full Ed25519 public key `owner`. Each
account has one key at `HOME/.ipab/identity/key.json` (`USERPROFILE` fallback).
The identity directory is also the initialization marker: missing/corrupt keys
in an existing directory are errors, never a reason to silently rotate identity.
Unix ownership/0700/0600 and Windows account-only ACLs are checked before use.
Changing a project or `--state-dir` does not create another identity.

Canonical upstream `d39cddd` implements the confirmed pointer API and supersedes
the earlier transient administrator-key flow. Creation now requires persistent,
account-protected and explicitly origin-bound cfg:

```sh
ipab config set pointers.service https://service.example
# Pipe the operator's key using safe stdin; never put it in command arguments.
ipab config set pointers.apiKey -
ipab swarm create
```

Cfg reuses upstream's account-protected State SQLite storage and `config-secret`
helpers, rather than a second credential configuration file. API-key queries and
confirmations are masked. Keys are sent only on POST to the explicitly
configured origin, never on GET/PUT, from a Descriptor-selected origin, or
through redirects. The owner signs POST body `{owner,root}`. The service
allocates the opaque ID; no client-selected variables or administrator-key
fallback remain in the CLI.

Initial State and a publication record are provided before POST; neither refers
to the not-yet-created Descriptor. The creation operation/idempotency key and
returned ID are persisted under protected state credentials before Descriptor
assembly/distribution. `swarm create --resume OPERATION` reuses the saved ID,
not another pointer allocation. An unconfirmed creation without an ID is blocked
after the minimum ten-minute server idempotency window, requiring operator
recovery rather than claiming permanent exactly-once behavior.

Portable client/cryptography/certificate/protocol code now lives under
`@ipab/bundle/pointer/*`; the Worker re-exports it rather than maintaining a
second protocol. The publishable CLI does not depend on a private Worker
package. The CLI now uses only `/v1/pointers/` POST and `/v1/pointers/{id}`
GET/PUT, `{root,revision}` responses, and strong revision-string ETags. The
canonical upstream client and Worker use the same shared source; old variable
and administrator endpoints are not retained as a fallback.

**Canonical shared protocol:** `pointer/protocol.ts` exports
`requestSigningMessage` and `RequestProof`. Its unambiguous UTF-8 signing
message is the JSON array:
`["IPAB-POINTER/2",service,pointerId,method,path,bodySha256,ifMatch,idempotencyKey,timestamp,nonce,subject]`.
Both the actual Worker and CLI consume this one encoder. This is an intentional
breaking API/envelope change, not backward compatibility with `/v1/value`.
Member certificates retain the existing signed certificate envelope as
`{v:2,service,pointerId,owner,member,cid,iat,exp}` and share
`certificateSigningMessage`, binding the full owner/member keys, target and
validity without delegation, aliases or fingerprints.

Network retries issue fresh nonce/timestamp proofs with the same operation key.
A rebase that creates a different CAS candidate receives a new operation key.
Server-pinned origin, atomic nonce/CAS/idempotency persistence, capacity
rejection, and recovery are preserved from canonical upstream. The integration
does not add a second server implementation or deploy anything.

Owners sign directly without self-membership certificates. Members need both an
owner-signed, non-delegating certificate and possession proof on every request.
Membership requests are typed, signed, target-bound Bundles valid for seven
days. Responses reference the exact request CID. Join checks the pending local
request, the account public key, owner, target, signature and validity, and
authenticates HEAD before saving the certificate. Certificates default to seven
days, with explicit `--expires-in` seconds (60 to 2592000).
Renewal/revocation/recovery are outside this MVP. Approval requires `--yes` or
an interactive confirmation.

## Content, Names and retention

All references are CIDs. `name:apps/hello` explicitly selects a formal shared
Name; bare references retain existing local pin/CID semantics. Select a swarm
with global `--swarm CID`, `IPAB_SWARM`, or `swarm.default`. The service has one
HEAD per swarm. HEAD is a DAG-CBOR publication `{v:1,state:CID,previous?:CID}`.
Its State contains `v:1`, mutable `properties` (`name`, `description`) and
`names` (Name to **CID links**). History links prior publication records rather
than Descriptors. Mutable properties are not in the Descriptor. There is no
arbitrary root replacement command or properties-edit command.

Artifact Bundles have exactly `{value,previous?,timestamp}`; timestamp is
RFC3339 UTC. Genesis omits previous. Iteration links the old **Artifact node**,
not its payload or the global snapshot. `exec`, `get` and `open` resolve
Artifact values; `get --raw` and `open --raw` select the node itself. `exec` has
no raw mode. One operation freezes its resolved target/content CIDs.

```sh
ipab publish dist/app.car --name apps/hello
ipab --json get name:apps/hello -o downloaded-app
ipab publish APP_V2 --name apps/hello --expect RELEASE_V1
ipab publish CONTENT_CID --name documents/snapshot --snapshot
ipab publish CONTENT_CID
```

Named publication creates an Artifact unless `--snapshot` explicitly names
ordinary content. Initial names must be unoccupied; ordinary snapshots cannot
replace an occupied Name. Iteration requires the exact old Artifact node.
Different-name global CAS conflicts refresh the snapshot, preserve all other
Names, rebuild a candidate and retry (at most eight attempts). Same-name changes
return edit conflict/exit 3 with retained candidate/content CIDs. Non-CAS
network failures are not silently retried; unknown commit outcomes are not
successes. Publication does not edit, compile, execute or install.

Swarm flows require a prepared private Kubo network. `store.gateway` stays
read-only; it does not upload. `swarm.provider` (default local port 5001) is an
explicit **CAR import bridge**, not a restored `store.rpc` backend. It POSTs
multipart CAR to `/api/v0/dag/import?pin-roots=true`, verifies every returned
root/pin result and keeps local coordinated retention. HTTP RPC is restricted to
loopback; other providers require HTTPS. Redirects are refused.
App/source/Artifact dependencies and required history are explicitly provided
and pinned before HEAD is written. Weak JSON CID references are not mistaken for
automatic IPFS links. Pin confirmation does not claim any remote member is
online or has downloaded content. Garbage collection does not unpin publication
roots; retention expiry/reclamation is not part of this MVP.

`get` validates the Bundle and unpacks only its actual files into a new/empty
directory, refusing overwrite. JSON output includes `targetCid` (the editing
baseline), `cid` (selected content) and `directory`. It never installs, edits,
builds, executes or automatically follows an App's optional `source.cid`. An
Agent obtains source with a separate `get SOURCE_CID`. Apps without source
remain downloadable/runnable. Node execution remains trusted, **not sandboxed**.

Creation, request and approval stdout are one CID line, or exactly `{cid}` with
global `--json`. Progress/errors use stderr. Management failures exit 1, syntax
errors 2, Name edit conflicts 3; App exit codes remain unchanged.

## Intentional build migration

Root `ipab build` now **only** assembles/validates a generic Bundle and writes
its CAR. It never executes an App compiler, npm script or prebuild hook. Supply
a directory containing `.bundle.yaml` and `ipab.build.yaml`, or the recipe path:

```yaml
version: 1
files:
  - source: app.json
    target: app.json
  - source: compiled/main.cjs
    target: resources/app.cjs
imports:
  - cid: EXACT_UNIXFS_CID
    target: resources/original
```

Type and entry come only from `.bundle.yaml`, not duplicate recipe fields. Files
use explicit relative local source/target paths; no scans or implicit
resolution. CID imports are exact UnixFS content, not Names or Artifact values.
Imported root/subtree CIDs and block bytes are preserved. Only ancestor
directories are rebuilt. Needed blocks are hash-verified and included in the
final CAR. Missing/corrupt content, path collisions (including case-only
collisions), crossing files and missing entry selections fail. `bundle build`
remains the low-level direct-directory/type-only packer.

Old App `ipab.yaml`/`ipab.json` is **rejected** by root build, not silently
ignored. Its App-specific behavior is available only to explicitly invoked
project tooling: `prepareApp` in `@ipab/cli/devtools` prepares
`dist/prepared-app/` (files plus recipe) and a separate source CAR. Existing
metadata/supportedSchemas/source validation and trusted project prebuild rules
are retained there, outside root build. Generated templates provide:

```sh
# Explicitly link this candidate CLI as a project dependency first:
pnpm add --save-dev @ipab/cli@link:PATH_TO_THIS_WORKTREE/apps/cli
pnpm prepare-app
pnpm build
ipab bundle import dist/app.source.car
ipab publish dist/app.car --name apps/hello
```

Replace the link with an authorized released version when one actually exists;
templates do not invent an unpublished registry version. Installing dependencies
and linking developer tools are explicit external operations. Source snapshots
exclude generated outputs and carry the project scripts/configuration. Check
Viewer repository build likewise prepares explicitly then invokes generic
assembly using isolated local state. Old scripts that assumed `ipab build`
compiles must migrate to the two explicit stages above.

## Validation boundary

Validation before the confirmed pointer API migration: two isolated same-host
Kubo 0.43.1 private repos and the legacy Worker router completed Hello→Welcome
and prior-release Hello, with App/source get. Windows and `office-ubuntu`
existing private Kubo 0.43.1 nodes also verified real bidirectional Bundles: A→B
`bafybeiaeyxrgijj2cteat3pdumbesjbivxmzcbirvbzwj6qv3ox4ptqive`; B→A
`bafybeidwv32yojp3qv3pa4mnx3wht7zxmrpwoysjqawx6akc5dc6rt762y`. Only new
test-owned roots were imported/pinned; prior pin absence was checked, those test
pins were removed, and owned SSH forwards stopped. No shared daemon,
configuration, swarm connections, GC or existing pins were changed.

Canonical upstream `d39cddd` is now integrated. The actual migrated Worker
router passes the two-account MVP, including forced same-name conflict,
different-name CAS refresh/retry, v1/v2/old execution, separate App/source get,
membership and provider failure before HEAD. This uses in-memory Durable Object
storage and does not claim production transaction certification from the Node
fixture.

Authorized deployed-service validation at
`https://ipab-pointer.shazhou.workers.dev` also passes owner GET/PUT/CAS,
create/update idempotency, member authorization, cross-pointer rejection, nonce
replay and Name v1→v2 with old-release execution. Content moves through the
existing Windows/office-ubuntu private Kubo peers; IPAB execution uses two
isolated Windows HOME/state contexts, not a physical remote-CLI execution claim.
Existing remote runtimes were found read-only at
`/home/scottwei/.nvm/versions/node/v26.13.1/bin/node` and v24.22.2; no
installation or shell configuration change was performed.

Fresh online test pointer IDs (no delete API is available):
`FK6Tm4Eu70NtFOIfoTmULa8NAqu_QI7tO-tXAsiRxHQ` and
`h27rAtP-Q6WiMxRwVEldVESR58L2fp79J6D8696cTeU`. Label:
`ipab-owned-validation-bbf46206-5457-4898-8c2d-a3d1d34f6690`; Swarm CID:
`bafybeidhdslt2x3d7uxnsq4tblecxqdrwfxpipzbfygtnroljivlifk7wm`. Only roots proved
not previously pinned were imported/pinned and later unpinned; owned SSH
forwards were stopped. No production pointer, shared configuration, daemon,
swarm connection or GC was changed.

Full `check-release` exposed and fixed owning-package mock isolation and a
leading-dash opaque-ID operator parsing regression. Full validation results are
reported separately; thresholds, test selection and assertions are not weakened.

Final `pnpm check-release` and `pnpm check` pass. CLI full coverage is 95.10%
statements, 90.92% branches, 95.67% functions and 95.50% lines; Worker full
coverage is 96.78%, 92.73%, 95.83% and 96.94% respectively. All four 90% gates
remain enforced. The five delivered npm packages also pass isolated tarball
installation/import/CLI smoke. Explicit public pointer subpath exports avoid
literal wildcard imports in that smoke. Large metadata/secret test cases were
partitioned with all assertions and their existing timeouts preserved.

Focused Builder tests verify a multi-block imported UnixFS DAG remains
identical, including its original CID and all required blocks, and reject
collisions, missing/corrupt inputs. Worker tests verify version-2
service/variable binding, non-delegating certificates and nonce replay
rejection.

The `pointer-worker/test/mvp.test.ts` release-E2E fixture uses separate account
HOME/state/Store contexts, a real isolated HTTP server, the actual Worker router
with isolated in-memory Durable Object storage, and an isolated verified-CAR
provider implementing Kubo's import/Gateway HTTP contract. It never contacts a
shared daemon. This is not a public deployment, real Kubo daemon test,
Cloudflare runtime certification or release authorization. It asserts
membership, Name resolution, v1/v2 output, separate App/source get, raw node
get, prior release availability, same-name conflict, different-name merge/retry
and provider failure before HEAD. It calls the canonical production Worker
router, not a competing contract server. Required checks and results are
reported separately; this document is a decision record, not fabricated
execution evidence.
