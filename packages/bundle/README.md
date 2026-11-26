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
```

`name` is a required nonblank string. `description` is an optional string;
missing descriptions normalize to `""`, while null is rejected. `entry` and all
its `path` and `contentType` fields are required. `schema` is optional; other
entry fields, including the removed `defaultValue`, are rejected.

- `path` is a safe relative file path from the Bundle root, not a mutable
  initialization suggestion. It cannot collide with `.bundle.yaml` or
  `.bundle-ignore` control paths.
- `schema` is a self-contained standard JSON Schema Draft 2020-12 object or
  boolean for decoded entry data only. Absence means no data constraints.
- `contentType` accepts any legal MIME, including legal parameters. The
  structured parsers support `application/json`, `application/yaml`,
  `application/jsonl` and `text/markdown`. Other MIME entries are opaque bytes:
  any declared schema is checked, but entry data validation is unsupported.
  Parser selection ignores case but does not strip MIME parameters;
  parameterized MIME is legal and currently reports `unsupported`.
- Entry data is supplied by the author or a general Template Bundle. Schema
  annotations such as `default` never generate or mutate it. Root `ipab init`
  renders Template Bundles; `bundle init` has been removed.

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

Name, description, schema and fixed path/MIME all affect type identity.
Omitted/empty descriptions, object field order, YAML comments and source
formatting do not. Schema literal values are preserved: no `$schema` is
injected, and absent schema differs from explicit `true`. Actual entry data is
not part of this type CID. The UnixFS root still includes original
`.bundle.yaml` bytes, so editing comments/formatting can change the content root
while preserving type identity.

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

There is no default-based Markdown generation. See the
[Agent Skill example](../../examples/agent-skill) and
[authoring reference](../../docs/reference.md#agent-skill-bundle) for a complete
reusable Skill type definition.

The loader verifies the complete selected storage DAG and paths, parses the
definition and validates the actual entry when its MIME has a structured parser.
Opaque entry bytes still undergo size, path and storage integrity checks.
Resources and nested Bundles remain opaque: no business parsing or recursive
contracts. Strings do not trigger reads; reference interpretation belongs to the
App.

Type identity is reproducible from the retained `.bundle.yaml`; opening a
content root never requests an external Schema block. A separately distributed
type CID still requires its block to be available when explicitly loaded by CID.

## Standard JSON Schema

Entry schemas use Draft 2020-12. Omitted `$schema` selects that draft; an
explicit declaration must be `https://json-schema.org/draft/2020-12/schema`.
Standard constraints include scalar bounds, `pattern`, `allOf`/`oneOf`/`not`,
conditionals, `prefixItems`, `contains`, dependencies and unevaluated
items/properties. Validation does not coerce types, apply defaults, remove
fields or execute schema-provided code. Unknown extension keywords and `format`
are annotations, not resource readers or execution hooks; `x-content-ref` has no
special behavior.

References must resolve to schema nodes within the entry schema document. Local
JSON Pointers and anchors are supported; external loading is disabled. All
definitions, including unused ones, are checked. Productive data recursion is
allowed; nonproductive same-data cycles are rejected. CBOR byte strings and IPLD
links are not JSON-compatible type-definition data.

Draft meta-schema checking uses Ajv2020; data evaluation uses the TypeBox
`Check` interpreter, not generated validation code. Nested `$id` resources and
document-local pointer/anchor references are supported without an external
resolver. Shared work/depth limits cover traversal and evaluation access, not
wall-clock execution of ECMA regular expressions. This is not a sandbox or a
hard CPU/time limit for untrusted schemas.

## API

`validateSchemaValue(definitions, data, { charge, depth })` exposes the same
Draft 2020-12 entry validator used by `openBundle`. Supply definitions from
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
  YAML definition and check its shape. Full schema checking happens through
  `inspectBundleSchema`/`encodeSchema`/opening.
- `inspectBundleSchema(value, options?)`: check complete definition, all schema
  references.
- `encodeSchema(value, options?)`: return `SchemaBlock` with exact `cid`,
  canonical `bytes`, normalized `manifest`, entry `schema` and pointer index.
- `openSchema(cid, options)`: verify hash, codec, budgets, canonical normalized
  encoding and the complete profile of one type block.
- `inspectSchema(value, options?)`: pure low-level Draft 2020-12 schema check;
  it does not encode or publish a standalone type.
- `openBundle(root, options)`: verify storage, definition and entry; return
  `kind: "content"`, `manifest`, `schemaKey`, `schema`, `cid`, `readFile`, and
  `validation: {status, contentType}`. Status is `validated` only when a
  supported parser and an explicit schema validate actual data; `schema-absent`
  means parsed data without schema constraints; `unsupported` means the MIME has
  no structured parser, not successful schema validation.
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
special `x-content-ref` interpretation remain removed.

The former required `entry.defaultValue` is now forbidden, `entry.schema` is
optional, and MIME is no longer a four-value enum. Removing defaults changes
canonical type bytes and therefore type CIDs. Rebuild definitions and all
embedded supported-schema CARs, then explicitly update pins/registrations.
Template parameter `default` values are separate and remain supported.
