# Check Spec definitions and views (private)

Migrated from `okr-agent/packages/check-bundle-viewer` under its MIT license.
The original ordered Checkpoint/Rule semantics, safe Markdown, resizable
sidebar, overview, mobile modal and keyboard behavior are retained. This is a
definition reader, not a checker or execution engine. The old repository is not
modified.

## Content Bundle

The [Check viewer App](../../apps/check-viewer) declares the complete
`IPAB Check Spec` type with `check.yaml` as its YAML entry. The new Bundle entry
keeps Spec `1.0`, but checkpoint `instructions` may be either inline text or:

```yaml
instructions:
  path: instructions/project.md
```

Only instructions are externalized. Task/checkpoint descriptions, rules and
success Context output documentation stay inline. Resource paths are explicit
Bundle-relative ASCII `.md` paths; absolute paths, traversal, backslashes, URLs,
fragments, queries and encoded paths are rejected. There is no glob, network
fallback, include directive or recursive resource resolution.

`resolveCheckInstructions(data, { readFile, signal })` validates the full
definition, compiles the target parameter JSON Schema in Node, checks scoped
identifier uniqueness, then loads referenced Markdown before SSR. Missing, blank
or invalid UTF-8 resources fail with the exact path and original cause. Reads
are deduplicated and limited to 256 references, 256 KiB per Markdown file and 1
MiB of distinct Markdown bytes. The enclosing viewer additionally limits the
complete resolved canonical state to 1 MiB. Cancellation stops file streams.

The generic Bundle protocol validates entry structure and storage integrity.
`checkSpecDefinition`, exported from the `/bundle` entry, is the shared complete
type definition used by Check SDK model generation. The viewer's declarative
Schema file is checked against that definition to preserve the same type
identity. Markdown references are an App-level contract, so generic
build/inspect success does not prove that references exist or Check semantics
are valid.

## Explicit conversion

```ts
import { splitCheckSpec } from "@ipab/check-spec/bundle";

const { spec, files } = splitCheckSpec(oldSpec);
// Serialize spec into check.yaml; write each files entry below the Bundle root.
// Include the viewer's exact complete .bundle.yaml definition, then build.
```

Conversion preserves ordered checkpoints, rules, inline documentation and
instruction contents. It does not write files, import, pin or change the old
document. An old naked Spec file is not automatically accepted as a Content
Bundle. The optional old `$schema` string remains an annotation, not the new
IPAB type CID. A ready example is
[examples/check-spec](../../examples/check-spec).

## SSR and browser validation

`CheckBundleViewer` consumes resolved inline instructions. Browser validation
uses a build-generated static AJV shape validator and shared uniqueness checks;
it never dynamically compiles a parameter Schema. Full target Schema validation
is performed by `validateCheckBundleSpec` / the resource loader in Node.
`validateCheckView` is only the view-shape/identifier validation boundary.
Builds generate the static validator from the same shape definition; no browser
`eval`, CSP exception, remote resource or runtime dependency install is needed.

Initial responsive state is identical on server and browser. Media queries are
applied in an effect after hydration, preserving the initial tree and React IDs
on mobile as well as desktop. The App uses local checkpoint selection, not the
old IPFSAW URL bridge; the migrated component's opt-in old navigation is not
enabled by the new host.

The Check App sets `preserveSelection: true` for live data. An unchanged
Checkpoint ID retains selection after instructions or entry edits; removing the
ID resets to the overview. Ordinary `CheckBundleViewer` consumers retain the
default reset-on-definition-replacement behavior.
