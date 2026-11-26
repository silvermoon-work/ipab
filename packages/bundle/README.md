# Bundle runtime

`@ipab/bundle` validates immutable UnixFS Content Bundles and their complete
single-block type definitions. Callers own the block resolver/Store. There is no
upload, pinning, network schema resolution or Schema Bundle directory.

## One definition

The root `.bundle.yaml` is the Bundle type definition, not a pointer to an
external Schema. JSON-style YAML is legal:

```yaml
name: Note
description: ""
entry:
  path: data.json
  schema:
    type: object
    required: [title]
    properties:
      title:
        type: string
  contentType: application/json
  defaultValue:
    title: Untitled
```

`name` is a required nonblank string. `description` is an optional string;
missing descriptions normalize to `""`, while null is rejected. `entry` and all
its four fields are required; other fields are rejected.

- `path` is a safe relative file path from the Bundle root, not a mutable
  initialization suggestion. It cannot collide with `.bundle.yaml` or
  `.bundle-ignore` control paths.
- `schema` is the self-contained structural JSON Schema for entry data only.
- `contentType` is exactly `application/json`, `application/yaml`,
  `application/jsonl` or `text/markdown`.
- `defaultValue` is logical JSON-compatible initialization data, not file text.
  It must satisfy `schema`; JSONL requires an array and Markdown requires an
  object.

The complete normalized definition is directly encoded as canonical DAG-CBOR
with a CIDv1/DAG-CBOR/SHA-256 identity. That CID is the Schema-to-App
registration key. The block contains the definition object, not a JSON string or
UnixFS wrapper. `encodeSchema` now takes this complete definition, not a bare
JSON Schema. `openSchema` requires the same complete profile.

**The encoded type block must be at most 1 MiB (1,048,576 bytes), inclusive.**
This is a project protocol ceiling, not a universal IPFS backend claim. There is
no chunking fallback. `schemaBytes` can lower but cannot bypass the ceiling.
Source definition text is bounded by operation parsing/manifest budgets, not the
obsolete 64 KiB pointer-manifest limit.

Name, description, schema, fixed path/format and default data all affect type
identity. Omitted/empty descriptions, object field order, YAML comments and
source formatting do not. Actual entry data is not part of this type CID. The
UnixFS root still includes original `.bundle.yaml` bytes, so editing
comments/formatting can change the content root while preserving type identity.

## Entry validation and opaque resources

JSON/YAML decode to one JSON-compatible value. JSONL decodes the complete
ordered array, including an empty file as `[]`; CRLF and terminal newlines are
accepted, blank internal lines are not. Duplicate keys, invalid
UTF-8/surrogates, nonfinite numbers and unsafe integers are rejected. Files are
not rewritten.

Markdown decodes only its leading YAML frontmatter object; `entry.schema`
validates that object, not the instruction body. Frontmatter starts with an
exact `---` line at the beginning and ends with the next exact `---` line. LF
and CRLF are supported, including a closing delimiter at EOF. Missing or empty
frontmatter decodes to `{}`; required fields can still reject it. An opening
delimiter without a closing delimiter, non-object metadata or invalid YAML is
rejected using the same strict parsing and work/depth limits. The entire
Markdown entry, including its body, must be valid UTF-8 and fit the entry byte
budget. Body syntax, links and referenced resources are not parsed or loaded.
File reads preserve all original bytes.

`bundle init` writes Markdown `defaultValue` as YAML between `---` delimiters
with an empty body. It does not put instruction text in the frontmatter or
invent a body field in the schema. See the
[Agent Skill example](../../examples/agent-skill) and
[authoring reference](../../docs/reference.md#agent-skill-bundle) for a complete
reusable Skill type definition.

The loader verifies the complete selected storage DAG and paths, parses the
definition, validates default data and validates the actual entry. Resources and
nested Bundles remain opaque: no business parsing or recursive contracts.
Strings do not trigger reads; reference interpretation belongs to the App.

Type identity is reproducible from the retained `.bundle.yaml`; opening a
content root never requests an external Schema block. A separately distributed
type CID still requires its block to be available when explicitly loaded by CID.

## Structural dialect

This is a minimal structural profile, not full JSON Schema 2020-12:

- single-name `type`: null, boolean, string, number, integer, object, array;
- `enum`, `const`, `properties`, unique `required`, `additionalProperties`
  (boolean/schema, default true);
- homogeneous `items` (boolean/schema, default unconstrained);
- `anyOf` with at least one matching structural branch;
- `title`, `description`, optional absolute root `$id`;
- `$defs` and local JSON Pointer `$ref`, including `#`.

References identify actual schema nodes in the same entry schema document.
Tokens use `~0`/`~1`; percent-encoded references, anchors, external/relative
references and nested `$id` are not supported. All definitions, including unused
ones, are checked. Productive data recursion is allowed; same-data
reference/anyOf cycles are rejected.

Unknown keywords are rejected, including `$schema`, pattern, scalar constraints,
tuples, oneOf/allOf, examples/default and `x-content-ref`. Property names and
enum/const data are not schema nodes. CBOR byte strings and IPLD links are not
JSON-compatible type-definition data.

## API

`validateSchemaValue(definitions, data, { charge, depth })` exposes the same
structural entry validator used by `openBundle`. Supply definitions from
`encodeSchema` / `inspectSchema`, parsed JSON-compatible data, a finite work
budget through `charge`, and a positive validation depth. This validates data
only; it does not load or verify a storage DAG.

`@ipab/bundle/data` provides parsing, canonical JSON, schema encoding and entry
validation without importing the Store/DAG runtime. Use it for trusted App
adapters that already receive file access through an IPAB context.

```ts
import { encodeSchema, openBundle, parseBundleManifest } from "@ipab/bundle";

const definition = parseBundleManifest(sourceYamlBytes);
const type = await encodeSchema(definition);
const bundle = await openBundle(rootCid, {
  resolveCid: (cid, request) => store.block.get(cid.toString(), request),
});
const stream = await bundle.readFile(bundle.manifest.entry.path);
```

- `parseBundleManifest(bytes, maximum?, charge?)`: parse/normalize the complete
  YAML definition and check its shape. Full schema/default checking happens
  through `inspectBundleSchema`/`encodeSchema`/opening.
- `inspectBundleSchema(value, options?)`: check complete definition, all schema
  references and default data.
- `encodeSchema(value, options?)`: return `SchemaBlock` with exact `cid`,
  canonical `bytes`, normalized `manifest`, entry `schema` and pointer index.
- `openSchema(cid, options)`: verify hash, codec, budgets, canonical normalized
  encoding and the complete profile of one type block.
- `inspectSchema(value, options?)`: pure low-level entry-schema dialect check;
  it does not encode or publish a standalone type.
- `openBundle(root, options)`: verify storage, definition, defaults and entry;
  return `kind: "content"`, `manifest`, `schemaKey`, `schema`, `cid`,
  `readFile`.
- `validateContentBundle(root, schemaBlock, options)`: also require the derived
  type CID to match the explicit validator; never trust its mutable metadata.
- `canonicalJson`, `parseData`, `safePath`, `bundleLimits`,
  `resolveBundleLimits`, `schemaBlockBytes`.

Future `readFile` streams have independent signals, unchanged bytes and
backpressure/cancellation. Missing blocks still fail after opening. No permanent
cache, bundle `close`, or resolver ownership transfer is implied.

Defaults: whole-operation 64 MiB unique blocks/parsing, 16,384 blocks, 2
MiB/block, 2,048 files, 100,000 work nodes; JSON/tree/validation depths 64; 8
MiB/entry file. The type block ceiling is 1 MiB. Overrides must be known
positive safe integers. Errors preserve code, path, pointer, reference chain and
cause.

## Breaking change

The old `{ entry: { path, schemaCid, contentType } }` pointer manifest and bare
Schema block profile are removed. Update definitions, rebuild Content/App
Bundles, and register their new type CIDs. There is no automatic migration.
Schema Bundle directories, builtin keys, the dedicated Schema Builder and
`x-content-ref` remain removed.
