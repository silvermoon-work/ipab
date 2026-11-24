# Bundle runtime

`@ipab/bundle` is the private unified runtime for Content Bundles and Schema
Bundles. Both are immutable UnixFS directories; a caller supplies raw blocks
through a caller-owned resolver/Store. No network schema resolution, upload,
pinning or legacy DAG-CBOR Schema protocol is provided.

## Manifest

`.bundle.yaml` is UTF-8 single-document YAML (JSON-style YAML is legal), with
exactly these three entry fields:

```yaml
entry:
  path: data/events.jsonl
  contentType: application/jsonl
  schema: /schema
```

`path` identifies an existing safe relative file. `schema` identifies an
embedded Schema Bundle directory, relative to this Content Bundle root with a
leading `/`; it cannot identify the root, a file, an ordinary Bundle, an
external URI or an escaping path. The actual directory DAG-link CID is its
registry identity. `schemaCid` is no longer accepted.

JSON and YAML decode to one JSON-compatible value; JSONL decodes the complete
ordered array, including an empty file as `[]`. CRLF and terminal newlines are
accepted; blank internal lines are not. JSON duplicate keys, YAML duplicate
keys, invalid UTF-8/surrogates, nonfinite numbers and unsafe integers are
rejected. Files are never changed by the loader. Only the entry data is parsed
and validated against its schema. All other resources, including nested Bundles,
remain opaque, but their paths and complete underlying storage DAG are verified.

## Schema Bundle

The same manifest uses `contentType: application/json` and exactly
`schema: builtin:bundle-schema.v1`. Its entry file is a descriptor:

```json
{
  "schemas": ["schemas/event.json", "schemas/events.json"],
  "main": "urn:example:events",
  "title": "Events",
  "description": "An ordered event collection"
}
```

`schemas` is an explicit, nonempty list of internal relative paths **without**
leading `/`. `main` is required. Every listed JSON file has one object schema at
its root, a mandatory absolute URI `$id`, and a unique ID within this Bundle.
The author chooses the ID scheme/name. All definitions, even unused definitions,
are checked before success.

`$ref` is a full explicit `$id` exactly matching this Bundle's index. There is
no network lookup, relative/fragment/pointer/alias/prefix matching, nested
`$id`, `$defs`, external dependency or recursive meta-schema loading. `main` and
schema references use the same exact index. The fixed builtin validates the
descriptor, dialect and closed references; ordinary data cannot bypass
validation merely by spelling the builtin in its manifest.

The minimal structural dialect supports:

- single-name `type`: null, boolean, string, number, integer, object, array;
- `enum`, `const`, `properties`, unique `required`, `additionalProperties`
  (boolean or schema, standard default true);
- homogeneous `items` (boolean or schema, standard default unconstrained);
- `anyOf`: at least one matching structural branch;
- `title`, `description`, full-ID `$ref`.

Nested boolean schemas are supported. Unknown keywords at schema nodes are
rejected (including `$schema`, `$defs`, pattern, scalar constraints, tuples,
oneOf/allOf, examples/default); property names and enum/const data are not
schema nodes. Productive recursive types may descend through data children; pure
same-data `$ref`/anyOf cycles are rejected.

## Entry-only contract

The embedded Schema Bundle describes the entry's data type. Its exact directory
CID is used for Schema-to-App registration; it does not declare a contract for
the entire resource tree. JSONL's whole array is validated normally, including
through anyOf/$ref rather than requiring a direct root `type: array`.

Applications define dependency formats and reference syntax, and read and
validate those resources themselves. Strings do not trigger file reads or child
Bundle validation, regardless of their spelling. `$ref` only reuses schema
definitions for entry validation; it does not refer to content files.

`x-content-ref` is no longer supported and is rejected as an unknown schema
keyword, not silently treated as an annotation. Its parser and the `references`
budget have been removed. Existing schemas using this extension must be updated;
the resulting Schema Bundle CID changes and requires a new registration.

## API

```ts
import {
  openBundle,
  openSchemaBundle,
  validateContentBundle,
  inspectSchemaBundle,
  canonicalJson,
  ContentBundleError,
} from "@ipab/bundle";

const options = {
  resolveCid: (cid, request) => store.block.get(cid.toString(), request),
};
const bundle = await openBundle(rootCid, options);
const stream = await bundle.readFile(bundle.manifest.entry.path);
```

- `openBundle`: verify storage, paths, manifest, embedded schemas and entry
  before success; no dependency content validation. `kind` is content/schema,
  `schemaKey` is the exact embedded directory CID or fixed builtin.
- `openSchemaBundle`: require/return loaded `SchemaBundle`, exposing descriptor
  and its full-ID `definitions` index.
- `validateContentBundle(root, schemaBundle, options)`: require ordinary content
  and verify its embedded Schema Bundle CID equals the explicit validator's CID.
- `inspectSchemaBundle(descriptor, files, options?)`: pure closed-profile check.
- `canonicalJson`, `parseData`, `parseBundleManifest`, `safePath`,
  `bundleLimits`, `resolveBundleLimits`, `SCHEMA_PROFILE`.

`readFile` returns original bytes with backpressure/cancellation. The opening
signal does not bind future streams; reads have their own signal. There is no
bundle `close`, implicit permanent cache or resolver/Store ownership transfer.
Missing blocks after opening still make later reads fail.

Errors preserve `code`, `path`, JSON Pointer `pointer`, `referenceChain`,
`cause`: MANIFEST_INVALID, SCHEMA_INVALID, REFERENCE_INVALID, PATH_INVALID,
CONTENT_INVALID, CONTENT_UNAVAILABLE, LIMIT_EXCEEDED, OPTIONS_INVALID, ABORTED.

Defaults apply to the **whole operation**: 64 MiB unique blocks, 16384 blocks, 2
MiB/block; 64 MiB parsing; 64 KiB manifest and descriptor each; 1 MiB/schema
file; 8 MiB/data file; 2048 files, 128 schema files, 100000 work nodes. Tree,
JSON and validation depths are independently 64. Cached work is not recharged;
repeated work is. Overrides must be explicit positive safe integers.

Construction lives in private `@ipab/bundle-builder` and
`@ipab/schema-bundle-builder`, not a separate Schema runtime.
