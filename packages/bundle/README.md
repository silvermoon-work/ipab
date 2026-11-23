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
rejected. Files are never changed by the loader. Unreferenced attachments remain
opaque, but their paths and complete underlying storage DAG are verified.

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
`file:` extension targets use the same exact index. The fixed builtin validates
the descriptor, dialect and closed references; ordinary data cannot bypass
validation merely by spelling the builtin in its manifest.

The minimal structural dialect supports:

- single-name `type`: null, boolean, string, number, integer, object, array;
- `enum`, `const`, `properties`, unique `required`, `additionalProperties`
  (boolean or schema, standard default true);
- homogeneous `items` (boolean or schema, standard default unconstrained);
- `anyOf`: at least one complete structural **and content-reference** branch;
- `title`, `description`, full-ID `$ref`, `x-content-ref`.

Nested boolean schemas are supported. Unknown keywords at schema nodes are
rejected (including `$schema`, `$defs`, pattern, scalar constraints, tuples,
oneOf/allOf, examples/default); property names and enum/const data are not
schema nodes. Productive recursive types may descend through data children; pure
same-data `$ref`/anyOf cycles are rejected.

## Content references

`x-content-ref` requires `type: string` and one of:

```json
{ "type": "string", "x-content-ref": "file:urn:example:events" }
```

```text
json:/details.json
yaml:/details.yaml
jsonl:/events.jsonl
```

The data chooses the format/path, not the target schema. JSONL's whole array is
validated normally, including through anyOf/$ref rather than requiring a direct
root `type: array`.

```json
{ "type": "string", "x-content-ref": "bundle" }
```

```text
/child/path
```

Child Bundles self-describe with their own embedded Schema Bundle; the parent
does not impose a schema. Entering the child switches both content root and ID
namespace. Paths cannot escape that root. Non-reference strings are opaque.

AnyOf evaluates full branches; failed structure does not force its references.
Target `CONTENT_INVALID` makes that branch false, but unavailable/corrupt reads,
cancellation, path/reference errors and limits propagate. Content tasks
deduplicate by root, target, contract and format; bounded ordinary cycles are
accepted. Cyclic anyOf dependencies on pending content tasks are explicitly
rejected in v1.

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

- `openBundle`: complete validation before success; `kind` is content/schema,
  `schemaKey` is the exact embedded directory CID or fixed builtin.
- `openSchemaBundle`: require/return loaded `SchemaBundle`, exposing descriptor
  and its full-ID `definitions` index.
- `validateContentBundle(root, schemaBundle, options)`: require ordinary content
  and verify its embedded Schema Bundle CID equals the explicit validator's CID.
- `inspectSchemaBundle(descriptor, files, options?)`: pure closed-profile check.
- `canonicalJson`, `parseData`, `parseBundleManifest`,
  `parseContentRef(value, rule)`, `safePath`, `bundleLimits`,
  `resolveBundleLimits`, `SCHEMA_PROFILE`.

`readFile` returns original bytes with backpressure/cancellation. The opening
signal does not bind future streams; reads have their own signal. There is no
bundle `close`, implicit permanent cache or resolver/Store ownership transfer.
Missing blocks after opening still make later reads fail.

Errors preserve `code`, `path`, JSON Pointer `pointer`, `referenceChain`,
`cause`: MANIFEST_INVALID, SCHEMA_INVALID, REFERENCE_INVALID, PATH_INVALID,
CONTENT_INVALID, CONTENT_UNAVAILABLE, LIMIT_EXCEEDED, OPTIONS_INVALID, ABORTED.

Defaults apply to the **whole operation**, without child/branch resets: 64 MiB
unique blocks, 16384 blocks, 2 MiB/block; 64 MiB parsing; 64 KiB manifest and
descriptor each; 1 MiB/schema file; 8 MiB/data file; 2048 files, 128 schema
files, 4096 content tasks, 100000 work nodes. Tree, JSON and validation depths
are independently 64. Cached work is not recharged; repeated work is. Overrides
must be explicit positive safe integers.

Construction lives in private `@ipab/bundle-builder` and
`@ipab/schema-bundle-builder`, not a separate Schema runtime.
