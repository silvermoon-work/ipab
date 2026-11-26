# @ipab/ipfs-store

Verified local IPFS/UnixFS storage with optional read-only upstream HTTP
gateways. The next npm candidate is `0.1.0-rc.1`; `0.1.0-rc.0` is published.
Source was migrated from `silvermoon-work/task-engine`; the original MIT license
and CID/protocol contracts are preserved. Kubo RPC storage is no longer
supported.

Run `pnpm check` from the repository root. Source and tests use strict
TypeScript, type-aware lint and the shared Vitest configuration.

## Local Store and upstream gateways

```ts
import { IpfsStore } from "@ipab/ipfs-store";

const store = new IpfsStore({
  dataDir: contentDirectory,
  gateway: "http://lan-storage.example:8080", // optional; an HTTP Gateway, not RPC
  limits: { bytes: 256 * 1024 * 1024, blocks: 16_384, depth: 64 },
});
```

All writes, persistent pins, usage queries and garbage collection belong to the
local Store. A gateway only supplies missing blocks, verified before atomic
local publication. It may be a shared LAN Kubo Gateway or another compatible
HTTP Gateway. No block is uploaded, no upstream pin is changed and no daemon
management/GC RPC is issued. No gateway is guessed when unset; local misses
fail. Successfully pinned complete DAGs remain available without the gateway.
Unpinned cache can be collected and then needs an available source to reacquire.

`read(cidOrCidPath, { signal? })` returns a discriminated `UnixfsNode`: files
(`type: "file" | "raw"`) expose `content()` as an async byte stream; directories
expose `entries()` as an async iterator. It does not materialize the whole file
or apply application portable-path rules. The node profile is SHA-256 raw/DAG-PB
regular files and UnixFS directories. Corrupt local blocks fail, never silently
fetching replacements.

`prepare(cid, { signal? })` verifies the complete linked DAG with unique-block,
byte and depth limits. Full DAG preparation supports raw, DAG-PB and canonical
DAG-CBOR and follows genuine IPLD links, not CID-looking strings or objects.
Unknown codecs, unsupported hashes, missing/corrupt blocks and exceeded budgets
fail. Structured blocks also have a 64-level/100,000-node inspection limit.
Shared subgraphs count once for bytes/blocks, but all paths satisfy the depth
limit. `block.get` and verified `put` support offline block transfer; low-level
verified SHA-256 blocks are codec-neutral. CAR framing, manifests, path policy
and DAG grafting remain outside Store.

`ContentBlocks` in `./dag` is the bounded in-memory transfer primitive, not
another application-level acquisition API. `contentLinks(cid, bytes)` is its
shared codec-aware extractor; callers verify integrity separately. It reuses the
identity-safe codec from `ipfs-payload/dag-cbor` without TypeBox/AJV runtime.
Pin/retain/import/reconciliation always traverse fresh backing reads.

`readContent(cid)` and `resolveContent(cid, path)` implement the type-only
`ReadonlyIpfsAccess` contract. `IpfsNode` is the shared DU: `kind: "file"` with
a `ReadableStream`, or `kind: "directory"` with an async entry stream. Entries
carry target CIDs and verified kinds. File cancellation and enumeration retain
host budgets/signals. Paths are directory-relative slash-separated segments;
empty path validates and returns the resource. Structured archives are not a
third file variant. `putContent(byteStream)` creates verified local UnixFS
content but does not establish persistent retention by itself.

`scope(limits?)` borrows backing storage with independent, no-larger reader
budgets/lifetime; closing it never closes its parent.
`IpfsStore.fromClient(port, limits?, dataDir?)` adapts a caller-owned block
source, never writing to or closing that source. Without dataDir it uses
memory-only `ContentBlocks`. Adapters expose `supportsRetention: false` and
reject coordinated retention, usage and GC. `withLocalSource(port)` creates a
coordinated local read-through Store with a borrowed source.

## Pins, ownership and imports

`pin(root)` verifies the complete DAG and persists a recursive local pin.
`unpin(root)` releases an unreferenced known pin without deleting blocks.
Neither `put`, `prepare` nor closing a Store pins/unpins content. `limits.bytes`
and `retainedBytes` measure in-process retention, not disk quotas.

All cooperating hosts sharing a dataDir must preserve the same durable
coordinationDir (default `<dataDir>/retention`) on SQLite-compatible storage. It
contains reference/operation metadata, never blocks or CARs. Distinct
registries/external writers are not a distributed ownership service.

`registerOwner`, `retain`, `confirmRetained`, `recoverOwner` and `reconcile`
coordinate persistent references. `retain` publishes durable intents before
acquisition/pinning; call `confirmRetained` after committing business
references. Use `reconcile(owner, () => readPersistedRoots())` to evaluate the
snapshot inside the participant mutex. Recovery discards abandoned
intents/imports only when the owner's old executions are stopped; its optional
`isIdle` predicate and root callback run inside the mutex. Never recover active
shared owners. Reconciliation verifies all participating roots before releasing
unreferenced pins. Failures preserve retry metadata; removed-pin counts are not
disk bytes.

`stageBlock(session, cid, bytes)` records and publishes individual local blocks,
including CAR parents before children. `finishImport(session, root, owner?)`
verifies and recursively pins the complete DAG before dropping staging
responsibility. `discardImport` drops that session's responsibility. Interrupted
imports retain retry metadata and never claim a complete root.

## Usage and explicit GC

`await store.usage({ signal? })` returns `{ cachedBytes, pinnedBytes }`.
`cachedBytes` sums canonical CID block file lengths, excluding coordination
metadata, temporary/unknown files and filesystem allocation overhead.
`pinnedBytes` is every durable recursive pin's verified DAG block union,
including indirect descendants and shared subgraphs, deduplicated by CIDv1.

`await store.gc({ signal? })` returns `{ removedBlocks, reclaimedBytes }`. It
collects unprotected blocks across the entire local Store without unpinning. The
participant mutex protects pin/owner changes and staging. Owner roots, pending
retention roots and active staged blocks survive. Incomplete import parents are
protected individually. Unknown files and temporary publications are untouched.

Every protected DAG is verified with fresh local-only reads before deletion,
using per-root content limits. Missing/corrupt content and capacity failures
abort marking before any deletion; queries/GC never fetch missing blocks or
trust warmed reader caches. Cancellation/storage failures throw; an interrupted
sweep may already have deleted blocks and can be retried. Unpinned reads/puts do
not establish a GC hold. Concurrent uncoordinated writes do not provide
transactionally exact usage snapshots; publications after initial inventory are
outside the sweep. No automatic GC, quotas, direct-pin mode or MFS.

## Public configuration and migration

`@ipab/ipfs-store/node` reads `%LOCALAPPDATA%\TaskContent\config.json` on
Windows or `~/.config/task-content/config.json` elsewhere. `TASK_CONTENT_CONFIG`
selects another file:

```json
{
  "backend": "local",
  "dataDir": "./content",
  "gateway": "http://lan-storage.example:8080"
}
```

Optional `limits` and `coordinationDir` are supported; gateway may be an ordered
URL list. Unknown fields, malformed URLs and invalid limits fail. Paths resolve
relative to the file. Legacy local configurations without `backend` still work.
Default dataDir is `~/.silvermoon.work/content`. Overrides cannot hide malformed
lower layers. `createConfiguredContent()` is an explicit host helper; library
imports never read configuration or start clients.

`backend:kubo`, `apiUrl` and Store `timeoutMs` are rejected. Replace old RPC
configuration explicitly with a local dataDir and HTTP gateway, not port 5001
RPC. Old Kubo blocks/pins/owner metadata are not moved, released or treated as
local retention. Existing CLI pin/history records keep their old configuration
and unsupported cleanup fails explicitly; independently manage old daemon pins
and create new local pins before relying on offline availability.

Local files are verified on read and published by atomic hard-link after
writing/syncing a unique complete temporary file. Existing publications are
validated, not overwritten. Close aborts owned work but never deletes blocks or
closes borrowed sources. Stores close only gateways they create. Acquisition is
deduplicated per instance; canceling a reader detaches it without canceling
another reader's shared acquisition. Non-Error cancellation reasons are reported
as Errors preserving the original reason in `cause`.
