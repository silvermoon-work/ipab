# MVP implementation decisions

> Historical MVP record: the onboarding/authorization and Swarm-CID sections
> below have been superseded by [Scope / Variable onboarding](onboarding.md).
> Current source uses configuration URLs, file Requests, no Join, public reads,
> nonexpiring exact-ID certificates, content-CID CAS and managed private Kubo.
> Build/Artifact design decisions remain applicable; old protocol examples are
> not executable compatibility guidance.

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

Shared Names use `ipab://SWARM_CID_OR_ALIAS/PATH`. A URI's swarm takes
precedence over the global selection; CID authorities are portable across
devices, while aliases are local and case-sensitive. `ipab:///PATH` uses global
`--swarm CID_OR_ALIAS`, then the saved `swarm.default`; no selection is an
error. Bare references retain existing local pin/CID semantics. Legacy
`name:PATH` references are rejected with migration guidance. `IPAB_SWARM` is no
longer supported: remove it and use `--swarm` or `ipab swarm use CID_OR_ALIAS`.

URI paths retain the existing formal Name validation and 256-character limit.
Encode individual path segments as UTF-8 percent escapes (for example,
`documents/hello%20%23world` names `documents/hello #world`). Decoding happens
once; encoded separators, traversal, malformed escapes and unsafe Names are
rejected. Credentials, ports, queries and fragments are not supported. Paths are
not URL-normalized or lowercased.

The service has one HEAD per swarm. HEAD is a DAG-CBOR publication
`{v:1,state:CID,previous?:CID}`. Its State contains `v:1`, mutable `properties`
(`name`, `description`) and `names` (Name to **CID links**). History links prior
publication records rather than Descriptors. Mutable properties are not in the
Descriptor. There is no arbitrary root replacement command. Shared properties
can be edited with `swarm update` as described below.

Artifact Bundles have exactly `{value,previous?,timestamp}`; timestamp is
RFC3339 UTC. Genesis omits previous. Iteration links the old **Artifact node**,
not its payload or the global snapshot. `exec`, `get` and `open` resolve
Artifact values; `get --raw` and `open --raw` select the node itself. `exec` has
no raw mode. One operation freezes its resolved target/content CIDs.

```sh
ipab publish dist/app.car --name apps/hello
ipab --json get ipab:///apps/hello -o downloaded-app
ipab get ipab://work/apps/hello -o downloaded-app
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

## Swarm registry and header cache

The local registry and header cache live in the selected CLI state directory,
alongside the existing swarm membership scope. The account identity remains in
HOME. `swarm create` and `swarm join` register successful swarms automatically;
both accept `--alias ALIAS`. A local alias is unique, case-sensitive, follows
the same short-name rules as pins, and is not the shared swarm display name.
Existing owner/member access can be registered using:

```sh
ipab swarm add SWARM_CID --alias work
ipab swarm list
ipab swarm use work
ipab swarm remove work
```

`add` authenticates against the service; it does not grant membership. The first
registration becomes `swarm.default` only if no saved default exists. `use`
changes this saved CID without a network request. Global selection precedence is
explicit `--swarm`, then `swarm.default`; `--swarm` also accepts local aliases.
An explicit swarm in an IPAB URI overrides this selection for that reference.
`list` shows the saved and effective selections and their source without
claiming that membership is currently authorized. `remove` only forgets the
registry entry, preserving credentials, content, cached headers and remote
membership. Removing the saved current swarm clears the default atomically
without silently selecting another swarm. Legacy credentials are not
automatically enumerated as registrations; use `add`.

Shared IPAB URI resolution in `exec`, `open` and `get` reuses an authenticated
header and locally validated Names snapshot for **300 seconds by default**. An
age of exactly 300 seconds is expired. The cache persists between commands, is
bound to the account public key and canonical Swarm CID, and retains the
immutable descriptor and snapshot so valid cache reads need no content Gateway
or pointer-service request. Local certificate validity and binding are still
checked on every cache hit; remote revocation may only be detected on refresh,
so a cached header is not proof of fresh service authorization.

An absent or expired cache is refreshed. A Name missing from a valid cached
snapshot triggers one refresh and retry; a Name missing from a just-refreshed
snapshot fails without another refresh. Content fetch/execution failures do not
trigger header retries. `--force` refreshes immediately; `--no-force` overrides
a reusable force preference. They conflict. For `exec`, both flags must precede
APP; all flags after APP are still forwarded verbatim. Bare CID and local pin
resolution do not request a swarm header.

```sh
ipab config set swarm.cacheTtl 300
ipab config set swarm.forceRefresh false
ipab exec --force ipab://work/apps/hello --help
ipab --swarm work get --force ipab:///documents/readme -o readme
ipab config reset swarm.cacheTtl
```

`swarm.cacheTtl` accepts integer seconds from 0 through 86400; 0 disables cache
reuse. `swarm.forceRefresh` defaults to false. Their environment overrides are
`IPAB_SWARM_CACHE_TTL` and `IPAB_SWARM_FORCE_REFRESH`. Failed refreshes do not
extend cache lifetime or fall back to stale data. Malformed cache data fails
explicitly and can be replaced with `--force`. `swarm status` always
authenticates and refreshes, updating the cache. Creation/join populate the
cache; a named publication invalidates it before attempting the remote write,
including unknown write outcomes. Publication CAS baselines and membership
authorization never use cached HEAD.

### Update shared swarm information

Any authenticated owner or member can update the swarm display name and
description using the same HEAD write authorization as shared Names:

```sh
ipab swarm update work --name "Team" --description "Shared workspace"
ipab swarm update --description ""
ipab --json swarm status work
```

The optional positional argument accepts a Swarm CID or local alias and
otherwise uses the effective current swarm. At least one of `--name` and
`--description` is required; an empty string clears that field. Unspecified
fields and the current Names mapping are preserved. A shared name change does
not alter local aliases or registry selection.

The user-facing policy is last successful write wins for each specified field:
no `--expect` or revision input is accepted, and stale client data does not
produce an edit-conflict response. The pointer API still requires `If-Match` to
protect the whole shared HEAD. The CLI therefore reads the current snapshot
directly, applies only the requested properties, and automatically
rereads/reapplies them on CAS contention (up to eight attempts). This preserves
concurrent Name publications and concurrent changes to unspecified information
fields rather than overwriting an entire old snapshot. Persistent contention
fails as a busy service (exit 1), not a user baseline conflict. Other failures
or unknown write outcomes are reported explicitly without stale fallback or
automatic non-CAS retries.

The linked publication history is preserved and the local header cache is
invalidated before each write attempt. Success JSON has `cid`, `root`,
`revision` and `properties` (`name`, `description`); human output shows the same
information. `swarm status` always reads the current service state and now also
includes `properties`. No new owner-only permission or credential is introduced.

### Search named entries

`ipab search QUERY` performs case-insensitive literal substring matching on
formal Names, including Artifact nodes and directly named snapshots. It does not
search Check `pass` booleans, unnamed content, payload text or history. The
query must be 1..256 characters without control characters.

```sh
ipab search hello
ipab search hello --current
ipab --swarm work search hello --force
ipab --json search hello
```

By default it searches every local registration. `--current` selects the
effective current swarm; explicit `--swarm` also narrows the scope to one swarm.
`--current` conflicts with `--swarm`. Valid caches are searched entirely
locally; only absent/expired headers refresh unless `--force` is requested. Zero
matches is success (exit 0) and does not refresh valid caches. Any unavailable
swarm fails the entire search (exit 1), rather than outputting an incomplete
success. Invalid queries/options exit 2.

JSON stdout is `{matches,swarms}`. Each match has `swarm`, nullable `alias`,
`name`, `reference` (`ipab://SWARM_CID/ENCODED_PATH`) and `targetCid`, the
direct Name target, not an expanded Artifact payload CID. Each searched swarm
reports `cid`, `source` (`cache` or `network`), `root`, `revision` and RFC3339
`verifiedAt`. Results sort by canonical swarm CID and Name; same Names in
different swarms remain distinct. References contain canonical swarm CIDs rather
than local aliases, so they can be passed directly to `get`, `exec` or `open` on
another authorized device without a separate swarm flag. Progress/errors use
stderr. Search never downloads every Artifact or its payload just to list names.

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
  - source: .bundle-type.yaml
    target: .bundle-type.yaml
  - source: app.json
    target: app.json
  - source: compiled/main.cjs
    target: resources/app.cjs
imports:
  - cid: EXACT_UNIXFS_CID
    target: resources/original
```

Instance entry/type paths come only from `.bundle.yaml`; its referenced file
defines pure MIME/schema. The recipe must select both files, not duplicate their
fields. Files use explicit relative local source/target paths; no scans or
implicit resolution. CID imports are exact UnixFS content, not Names or Artifact
values. Imported root/subtree CIDs and block bytes are preserved. Only ancestor
directories are rebuilt. Needed blocks are hash-verified and included in the
final CAR. Missing/corrupt content, path collisions (including case-only
collisions), crossing files and missing entry selections fail. `bundle build`
remains the low-level direct-directory/type-only packer.

Old App `ipab.yaml`/`ipab.json` is **rejected** by root build, not silently
ignored. Its App-specific behavior is available only to explicitly invoked
project tooling: `prepareApp` in `@ipab/cli/devtools` prepares
`dist/prepared-app/` (files plus recipe). With source enabled (default), the
recipe imports the original source DAG at `source/` from a local CAR: an
`imports` entry may specify `car`, a recipe-relative file whose root must match
the declared `cid`. This needs neither a gateway nor preloaded Store blocks.
`app.json.source.cid` still identifies the source Bundle directly. Existing
metadata/supportedSchemas/source validation and trusted project prebuild rules
are retained there, outside root build. Generated templates provide:

```sh
# Explicitly link this candidate CLI as a project dependency first:
pnpm add --save-dev @ipab/cli@link:PATH_TO_THIS_WORKTREE/apps/cli
pnpm build
ipab publish dist/app.car --name apps/hello
```

Replace the link with an authorized released version when one actually exists;
templates do not invent an unpublished registry version. Installing dependencies
and linking developer tools are explicit external operations. Source snapshots
exclude generated outputs and carry the project scripts/configuration. Check
Viewer repository build likewise prepares explicitly then invokes generic
assembly using isolated local state. Old scripts that assumed `ipab build`
compiles must migrate to a project `build` script that runs preparation before
generic assembly. `build.includeSource: false` omits both the source link and
the source DAG. A separate source CAR may still be used independently; it is not
required for distribution or offline import of newly built Apps.

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
