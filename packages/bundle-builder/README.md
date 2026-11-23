# Bundle builder

Private deterministic CAR construction; no Store upload or pinning.

`encodeBundleCar(tree, { signal?, limits?, embeddedSchemas? })` fully consumes
and validates a repeatable `ReadonlyFileTree` before returning
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
sharding. CARv1 contains one root, its block first, then unique reachable blocks
sorted lexicographically by CID binary bytes. Equal input produces equal root
CID and CAR bytes. The loader accepts other legitimate layouts within budget.

`embeddedSchemas` maps a safe relative directory path to `{ cid, resolveCid }`.
Existing Schema Bundle blocks are hash-verified and grafted without changing
their subtree CID or normalizing their contents. A directory placeholder may
exist in the VFS; a conflicting file or overlapping imports is rejected.

Builder limits use the runtime defaults; larger outputs need explicit matching
larger budgets. Final staged bytes must satisfy the runtime contract.
