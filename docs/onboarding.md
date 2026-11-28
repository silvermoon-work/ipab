# Scope / Variable onboarding

This protocol intentionally replaces the old Swarm CID, Pointer revision,
expiring certificate, Request/Response Bundle and Join protocols. There is no
migration or authentication fallback. Existing HOME identities, Store contents
and unrelated Kubo daemons are never cleared.

## Device journey

Prepare the device explicitly before Swarm onboarding:

```sh
ipab setup --yes
```

Setup verifies/installs the shared Kubo program and initializes or validates the
protected HOME identity. Repeating it preserves both. It does not create a Swarm
repo, contact/start existing daemons, deploy services or install login startup.

Owner configures an HTTPS Scope service and its origin-bound creation API key:

```sh
ipab config set pointers.service https://service.example
ipab config set pointers.apiKey -
ipab swarm create --name Team --alias work
ipab swarm status work
```

Pipe the API key through stdin; never put it in arguments. The key permits Scope
creation only. Creation returns a public configuration URL,
`https://service.example/v1/SCOPE_ID/CONFIG_ID`. Share that URL and the Owner
fingerprint shown by status through a trusted independent channel.

Member creates a self-contained Request without needing private-network access:

```sh
ipab swarm request CONFIG_URL --owner-fingerprint TRUSTED_FINGERPRINT --name Wei --alias work --output request.json
ipab swarm export work --output request-again.json
```

The exact signed Request, X25519 encryption identity and Kubo PeerID association
are saved locally. Re-export does not rotate identity, node or Request ID.
Requests have a signed file ID and application time, not expiry. Owner must
confirm the applicant's real identity, using IM or an in-person second channel:

```sh
ipab swarm approve request.json --yes
```

Approval creates the member's public profile and publishes an encrypted,
Owner-signed package in configuration. No Invite, password, Response file or
Join command exists. The member's next normal operation discovers the package,
verifies exact Request/Owner/identity/resource bindings, decrypts, configures
its private Kubo node and continues:

```sh
ipab swarm status work
ipab get ipab://work/notes/hello
ipab --swarm work publish CONTENT_CID --name notes/new --snapshot
ipab swarm profile work --name Wei
ipab swarm profile work --address /ip4/192.168.1.12/tcp/PORT/p2p/PEER_ID
```

Status shows the device's actual addresses and PeerID. IPv4 TCP LAN/VPN
addresses must end in the approved PeerID; several addresses still represent one
member. Initial addresses are detected from private IPv4 interfaces and
loopback. Use `swarm profile --address` to replace the advertised list where
routing needs explicit configuration. Address updates do not rebind node
identity. Owner alone changes organization name/description using
`swarm update`. Members may share display names.

`--swarm CONFIG_URL` and registered aliases select the content endpoint as well
as HEAD. `ipab://ALIAS/path` selects its own Swarm, while `ipab:///path` uses
the saved default. Cross-device references encode the exact configuration URL as
the URI authority, for example
`ipab://https%3A%2F%2Fservice.example%2Fv1%2FSCOPE_ID%2FCONFIG_ID/notes/hello`.
Search emits that canonical form, never a local alias or old descriptor CID.
Direct CID/pin operations without a selected Swarm remain local and do not
require Kubo; selecting a Swarm enables its read-through block source.

## Resource service

One SQLite-backed Scope Durable Object is the coordination atom. Scope holds the
immutable Owner Ed25519 key; Variables do not repeat their trust root. Scope and
Variable IDs independently use 32 CSPRNG bytes encoded as canonical 43-character
base64url. IDs are opaque, not names.

| Operation              | Endpoint                            | Authorization                                 |
| ---------------------- | ----------------------------------- | --------------------------------------------- |
| Allocate Scope         | `POST /v1/scopes`, `{owner}`        | Creation API key + Owner proof                |
| Read Scope trust root  | `GET /v1/SCOPE`                     | Public                                        |
| Allocate Variable      | `POST /v1/SCOPE`, `{value}`         | Owner proof                                   |
| Read value             | `GET /v1/SCOPE/VARIABLE`            | Public                                        |
| CAS value              | `PUT /v1/SCOPE/VARIABLE`, `{value}` | Owner or exact-ID certificate + subject proof |
| Freeze writes          | `POST /v1/SCOPE/VARIABLE/freeze`    | Owner proof                                   |
| Delete frozen resource | `DELETE /v1/SCOPE/VARIABLE`         | Owner proof                                   |

Values return `{value,cid,status}`. `If-Match: "VALUE_CID"` is the only write
precondition. The server computes canonical CIDv1 / DAG-CBOR / SHA-256 itself;
A→B→A permits a writer holding old A to write C. There is no history revision.
State-changing proofs use `Ed25519 SIGNATURE`, `x-ipab-subject`,
`x-ipab-timestamp`, `x-ipab-nonce`, `idempotency-key` and optionally
`x-ipab-certificate` (base64url JSON). Shared signing messages bind protocol,
service origin, Scope, Variable, HTTP method, exact path, body hash, CAS,
idempotency key, timestamp, nonce and subject. Timestamps allow ±60 seconds;
successful mutation transactions retain nonces for 130 seconds. Reusing a proof
is rejected, even for an idempotent operation. A network retry must use a fresh
nonce/proof and the same operation key/body/CAS.

The Owner certificate body is
`{v:1,service,scopeId,subject,write:[EXACT_VARIABLE_IDS]}` with an Owner
signature. It has no expiry, renewal, read permission, wildcard or management
capability. The subject must sign every mutation: an encrypted certificate is
not a bearer token. The member certificate grants current HEAD and only that
member's profile. Old permissions become useless when their exact HEAD/profile
IDs retire; there is no generic certificate revocation or membership-generation
service.

Lifecycle is irreversible: writable → frozen/readable → deleted. Freeze and CAS
linearize in the same Scope transaction. Frozen values cannot be changed even by
Owner; deletion requires freeze and leaves a tombstone. PUT cannot create a
missing/deleted resource; retired IDs are not reallocated.

JSON values permit null, boolean, strings, finite numbers and plain JSON
objects/arrays. Integers must be safe; unpaired Unicode surrogates, undefined,
binary, CID objects, cycles and non-plain objects are rejected. Limits are
inclusive 64 KiB in both canonical DAG-CBOR and compact UTF-8 JSON, depth 32,
8192 traversed entries, 128 KiB wire body, 16 KiB headers, 8 KiB certificate and
32 exact certificate IDs. Each Scope/Owner has a lifetime allocation limit of
4096 Variables/Scopes. Allocation/lifecycle retry results remain durable (at
most 12288 per Scope); ordinary PUT retries expire 600 seconds after the first
commit without renewal, with at most 4096 live records per Scope. Live records
are never evicted. Resuming an ambiguous organization publication also checks
its exact value CID before retrying CAS, so an expired retry cannot silently
allocate a replacement or overwrite later configuration.

## Configuration, publication and crypto

Public configuration contains version, immutable Scope/Owner binding,
name/description, current HEAD ID, epoch, bootstrap addresses and each member's
signing public key, distinct X25519 encryption key, PeerID, profile ID, Request
ID and encrypted approval. Public profile is `{name,addresses,updatedAt}`. An
organization has at most 16 members; each profile has at most 16 addresses. HEAD
value is `{root:PUBLICATION_CID}`; publication links a DAG-CBOR State and
optional previous publication. State v2 contains only CID-linked Names, not
organization metadata, profiles or node addresses. Artifact Bundles retain their
exact Bundle type and optional previous Artifact link.

Request has independent account and node possession signatures. Kubo's new
Ed25519 node identity signs its account-bound Request; the account signs the
Request and node proof. X25519 encryption uses an ephemeral key, HKDF-SHA-256
with a random 32-byte salt, and AES-256-GCM with a random 12-byte IV. AAD, HKDF
info and Owner signature bind the exact configuration URL, Scope, Owner, member,
encryption key, Request ID, PeerID, profile ID, HEAD ID and epoch. The encrypted
plaintext contains only the certificate and Swarm PSK.

Normal operation uses saved HEAD/package information without fetching
configuration every time. HEAD lookup has the existing bounded local cache; HEAD
read failure or write rejection refreshes configuration at most once. Ordinary
content CAS conflict is handled separately, not mistaken for revoked
authorization. Signature, decryption, networking and identity errors remain
distinct. Frozen old HEAD is readable until deleted, permitting old snapshots.

## Member removal and interruption

```sh
ipab --swarm work swarm exclude MEMBER_PUBLIC_KEY --yes
ipab swarm resume work
```

The persistent Owner-only operation records the old configuration, final frozen
HEAD, new HEAD/key/epoch, package generation and publication progress. It first
atomically freezes old HEAD, downloads and retains its final committed
publication while still on the old private network, then creates new HEAD with
the same final value. Capture includes every State in publication history and
the weak JSON string references in Artifact `value`/`previous` and App
`source.cid`, not merely DAG-CBOR/PB links. It downloads/retains the full
closure on the old network, records its exact roots, and provides/pins those
same roots after switching networks. It rotates PSK and remaining packages,
freezes/deletes the leaving profile, CAS-publishes configuration at the
unchanged URL, switches the managed Owner node, provides the captured final DAG
to the new network and deletes old HEAD. Interrupted operations visibly require
`swarm resume`; no step unfreezes old HEAD. Do not abandon a failed transition
by creating another organization or editing progress files. Successful
pre-freeze writes are included regardless of content creation time.

Approval history only warns about repeated Requests. An exact
completed-operation retry returns its prior result with a warning, without
granting new authority. `swarm approve FILE --yes --again` is an explicit new
approval, distinct from resuming a previously unconfirmed operation; a
previously removed identity may be approved again. History is not a reliable
revocation boundary. Members who lose account or local Request keys must create
a new identity/Request and have Owner remove the old identity. Lost Owner/Swarm
keys have no system recovery, second Owner or recovery key: make secure backups.

## Managed node boundary

Kubo **0.43.2** is the selected stable release. Installation retrieves the
official version-specific release asset and SHA-256 digest over HTTPS, bounds
the download, verifies the archive before extraction, validates layout/version
and protects/verifies the cached executable. Windows, macOS and Linux x64/arm64
assets are supported when published by that exact release. One protected binary
installation is shared across this state directory's Swarms; each Scope gets a
different protected repo, node identity, PSK, daemon log and API/Gateway/TCP
ports. Repo identity uses the full service-origin + Scope ID, preventing cross-
service ID collisions. API/Gateway bind loopback; admin RPC also requires a
separate protected random Bearer secret, never published in configuration or
approval packages. The server profile's private-address dial filters are cleared
for LAN/VPN. Public bootstrap, mDNS, AutoConf, AutoTLS, NAT port mapping, hole
punching, relays and public DHT routing are off; `LIBP2P_FORCE_PNET=1` prevents
accidental public networking.

CLI starts an owned daemon only on demand, verifies readiness and PeerID and
leaves it running after CLI exits. Device restart needs no login service: next
use restores the same repo/PeerID and starts it again. Epoch switching stops
only the verified managed node before replacing its PSK and connections. Store
remains local; `withLocalSource()` supplies an isolated verified read-through
block source. Publication explicitly imports/pins CAR roots into the selected
node before CAS. No Store RPC backend or shared-daemon management is restored.

First release supports reachable LAN/VPN only; it does not provision a public
relay, content host or NAT traversal service. Public metadata privacy is
accepted. PSK is not a PeerID allowlist and private networking is **not content
encryption**. Rotation accepts temporary write interruption, offline clients'
switch windows and stale old-network uploads of uncommitted content. Old blocks
and caches are not erased, and old-key holders can still exchange old data among
themselves. Only switched managed nodes stop their old connections.
