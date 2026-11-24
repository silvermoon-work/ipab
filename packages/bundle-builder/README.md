# Bundle builder

Private deterministic CAR construction; no Store upload or pinning.

`encodeBundleCar(tree, { signal?, limits?, schemaBlocks? })` fully consumes and
validates a repeatable `ReadonlyFileTree` before returning
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

`schemaBlocks` supplies blocks returned by `encodeSchema` from `@ipab/bundle`.
The builder requires the manifest's exact `entry.schemaCid` block and verifies
its hash and schema profile rather than trusting supplied metadata. CAR output
includes that one standalone DAG-CBOR block, with no UnixFS wrapper, directory
graft or extra root. Unused supplied schemas are omitted from output.

The manifest CID is a string, not a storage DAG link. Consumers must retain the
schema CID separately from the UnixFS root. Merely importing/retaining the root
does not protect this extra block. The old `embeddedSchemas` option is removed.

Builder limits use the runtime defaults; larger outputs need explicit matching
larger budgets. Final staged bytes must satisfy the runtime contract. The schema
block's 1 MiB hard ceiling cannot be raised by these options.
