# Schema Bundle builder

Private closed-profile normalization and CAR construction, sharing the
`@ipab/bundle` runtime and `@ipab/bundle-builder` core.

`createSchemaBundleTree(tree, { descriptorPath?, signal?, limits? })` reads a
local JSON descriptor (default `schema.json`) and only its explicit listed
schema files. It checks all definitions/references, generates `.bundle.yaml` and
`schema.json`, and returns a repeatable virtual tree. There is no ambient
resolver, network dependency, Store upload or pin.

Schema and descriptor JSON use RFC8785 JCS object ordering, ECMAScript number
serialization, valid Unicode and the runtime finite/safe-integer safeguards.
Descriptor paths are sorted; arrays and title/description are preserved. Listed
schema paths cannot collide with generated control files. Unlisted ambient files
are not imported.

`encodeSchemaBundleCar(tree, options?)` delegates the normalized tree to the
generic fixed-profile UnixFS/CAR builder. A returned VFS alone is not proof of
successful archive consumption; consume the CAR stream fully or explicitly
close/cancel it.

Node-only exports `schemaBundleTreeFromDirectory` and
`schemaBundleCarFromDirectory` from `@ipab/schema-bundle-builder/node` use the
explicit no-symlink filesystem adapter. All schema files remain local.
