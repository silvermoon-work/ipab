# Bundle builder

Deterministic CAR construction; no Store upload or pinning. `0.1.0-rc.2` is
published.

`encodeBundleCar(tree, { signal?, limits? })` fully consumes and validates a
repeatable `ReadonlyFileTree` before returning
`{ cid, stream, retainedBytes, close }`. Consume `stream` completely for a
completed CAR; cancel or close to release staged bytes. Input bytes are
preserved, including manifests. Input lifetime must remain stable through
construction; each `read` returns a fresh byte stream and each `list` returns
the same directory.

`memoryTree`, `fileTree`, `memoryFile`, `listTree`, `readBytes`, `streamChunks`
provide small VFS helpers. `filesystemTree(directory)` from
`@ipab/bundle-builder/node` is an explicit directory-bound Node adapter that
rejects symlinks and nonregular files. Paths in the virtual protocol use `/`,
not OS separators.

The importer is fixed: CIDv1/SHA-256, raw leaves, 256 KiB chunks, balanced
174-child nodes, small raw file self-roots, no mode/mtime, no directory
sharding. CARv1 contains one root, its block first, then unique storage blocks
sorted lexicographically by CID binary bytes. Equal input produces equal root
CID and CAR bytes. The loader accepts other legitimate layouts within budget.

The root `.bundle.yaml` contains instance title/description, entry path and type
file path. Both referenced files must be included. The pure type file contains
only MIME and optional JSON Schema. The builder computes and includes its
canonical DAG-CBOR type block alongside the UnixFS DAG, with no wrapper,
directory graft or extra root. No external `schemaBlocks` or resolver is needed.
The result's `schema` exposes the exact validated type; content-root consumers
can reconstruct it from the definition, even without the extra block.

`encodeSchemaCar(definition, options?)` checks the pure type profile and returns
the same lifecycle interface with exactly one DAG-CBOR root/block. It does not
require an actual entry file. Both results have `cid`, `schema`, `stream`,
`manifest` (validated content instance, or `null` for a type-only CAR),
`retainedBytes` and `close`; all CAR bytes must still be consumed.

`filesystemTree(directory, { exclude? })` allows a caller-owned selection rule
before traversing excluded directories; selected files remain no-symlink,
directory-bound reads. CLI `.bundle-ignore` and output exclusions use this
adapter. Generic Builder input is already selected; it does not implicitly
interpret local ignore files.

Builder limits use the runtime defaults; larger outputs need explicit matching
larger budgets. Final staged bytes must satisfy the runtime contract. The schema
block's 1 MiB hard ceiling cannot be raised by these options.
