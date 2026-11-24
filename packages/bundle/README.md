# Bundle runtime

`@ipab/bundle` is the private runtime for immutable UnixFS Content Bundles and
self-contained, single-block schemas. Callers own the block resolver/Store.
There is no upload, pinning, network schema resolution or Schema Bundle profile.

## Manifest

`.bundle.yaml` is UTF-8 single-document YAML (JSON-style YAML is legal), with
exactly these three entry fields:

```yaml
entry:
  path: data/events.jsonl
  contentType: application/jsonl
  schemaCid: "<CIDv1 DAG-CBOR SHA-256 schema block>"
```

`path` identifies an existing safe relative file. `schemaCid` identifies one
schema block, not a UnixFS file/directory, external URI or builtin profile. The
exact block CID is the Schema-to-App registration key.

JSON and YAML decode to one JSON-compatible value; JSONL decodes the complete
ordered array, including an empty file as `[]`. CRLF and terminal newlines are
accepted; blank internal lines are not. Duplicate keys, invalid
UTF-8/surrogates, nonfinite numbers and unsafe integers are rejected. Files are
never changed by the loader. Only entry data is parsed and validated against the
schema. Other resources and nested Bundles remain opaque, but their paths and
complete underlying storage DAG are verified.

## Single-block schema

Author one self-contained JSON Schema object (or boolean schema). `encodeSchema`
validates the structural profile and encodes the JSON value directly as
canonical DAG-CBOR, then computes a CIDv1/DAG-CBOR/SHA-256 identity. The block
contains the schema itself, not a JSON string, UTF-8 file wrapper, descriptor or
UnixFS DAG. Object field order and source formatting do not affect identity.
Array order, annotations and values do. No conversion rewrites the entry data.

**Encoded schema blocks must be at most 1 MiB (1,048,576 bytes).** The inclusive
limit is checked after DAG-CBOR encoding and before accepting loaded schemas. It
is a project protocol limit, not a claim about every IPFS backend. There is no
chunking or multi-block fallback. `schemaBytes` can lower the limit; increasing
it cannot bypass this hard ceiling. Store/operation byte limits may be stricter.

The minimal structural dialect supports:

- single-name `type`: null, boolean, string, number, integer, object, array;
- `enum`, `const`, `properties`, unique `required`, `additionalProperties`
  (boolean or schema, default true);
- homogeneous `items` (boolean or schema, default unconstrained);
- `anyOf`: at least one matching structural branch;
- `title`, `description`, an optional absolute root `$id`;
- `$defs` and local JSON Pointer `$ref`, including `#` for the root.

```json
{
  "type": "array",
  "$defs": {
    "event": {
      "type": "object",
      "required": ["name"],
      "properties": { "name": { "type": "string" } }
    }
  },
  "items": { "$ref": "#/$defs/event" }
}
```

References must identify actual schema nodes in the same document. Pointer
tokens use `~0`/`~1` escaping; URI percent encoding, anchors, external/relative
references and nested `$id` are not supported. All definitions, including unused
ones, are checked. Productive recursive types may descend through data children;
same-data `$ref`/anyOf cycles are rejected.

This is a minimal structural profile, not full JSON Schema 2020-12 support.
Unknown keywords are rejected, including `$schema`, pattern, scalar constraints,
tuples, oneOf/allOf, examples/default and `x-content-ref`. Property names and
enum/const data are not schema nodes. CBOR byte strings and IPLD links are not
JSON schema values; schemas cannot hide external block dependencies.

## Entry-only contract and retention

Schemas describe entry types, not the whole resource tree. `$ref` only reuses
local schema definitions; strings never trigger resource reads or child Bundle
validation. Applications define dependency formats and reference syntax, and
read and validate resources themselves.

The manifest contains a CID **string**, not an IPLD link. Retaining the UnixFS
root alone therefore does not retain the schema block. Callers must also retain
the schema CID; the CLI's operation owner retains every requested block. The
Bundle builder includes the exact schema block as an additional CAR block,
without adding it to the UnixFS tree or changing its CID.

## API

```ts
import { encodeSchema, openBundle } from "@ipab/bundle";

const schema = await encodeSchema({ type: "object" });
// Explicitly store/retain schema.cid and schema.bytes through the caller's Store.
const bundle = await openBundle(rootCid, {
  resolveCid: (cid, request) => store.block.get(cid.toString(), request),
});
const stream = await bundle.readFile(bundle.manifest.entry.path);
```

- `encodeSchema(value, options?)`: validate and return a `SchemaBlock` with
  `cid`, canonical `bytes`, `schema` and local-pointer `definitions`.
- `openSchema(cid, options)`: load, verify CID/hash, limits, canonical encoding
  and the complete structural profile of one schema block.
- `inspectSchema(value, options?)`: pure structural/closed-reference check.
- `openBundle(root, options)`: verify storage, paths, manifest, schema block and
  entry before success. Returns `kind: "content"`, `schemaKey`, `schema`,
  `manifest`, `cid` and `readFile`; no dependency business validation.
- `validateContentBundle(root, schemaBlock, options)`: also require the
  manifest's CID to match the explicit validator; always load and verify the
  actual block.
- `canonicalJson`, `parseData`, `parseBundleManifest`, `safePath`,
  `bundleLimits`, `resolveBundleLimits`, `schemaBlockBytes`.

`readFile` returns original bytes with backpressure/cancellation. The opening
signal does not bind future streams; reads have their own signal. There is no
bundle `close`, implicit permanent cache or resolver/Store ownership transfer.
Missing blocks after opening still make later reads fail.

Errors preserve `code`, `path`, JSON Pointer `pointer`, `referenceChain`,
`cause`: MANIFEST_INVALID, SCHEMA_INVALID, REFERENCE_INVALID, PATH_INVALID,
CONTENT_INVALID, CONTENT_UNAVAILABLE, LIMIT_EXCEEDED, OPTIONS_INVALID, ABORTED.

Defaults apply to the whole operation: 64 MiB unique blocks, 16,384 blocks, 2
MiB/block; 64 MiB parsing; 64 KiB manifest; 1 MiB/schema block; 8 MiB/data file;
2,048 files and 100,000 work nodes. Tree, JSON and validation depths are
independently 64. Overrides must be known positive safe integers.

## Breaking change

`entry.schema: /schema`, the builtin key, Schema Bundle descriptors/full-ID
indexes, `openSchemaBundle`, `inspectSchemaBundle`, `embeddedSchemas`, the
`schemas`/`descriptorBytes` budgets and the dedicated Schema Bundle builder
workspace have been removed. Rebuild schemas as single blocks, update manifests
and re-register their new CIDs. No automatic registration migration is provided.
`x-content-ref` and recursive business dependency validation remain removed.
