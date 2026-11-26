# Check Spec viewer App

A private IPAB Web App created from the standard
[Bundle Viewer template](../../templates/bundle-viewer). One shared React
callback renders the existing Check definition UI. Node loads the selected
Bundle and Markdown resources before SSR; the browser hydrates the same data. It
only displays definitions, never executes instructions or checks.

## Local folder watch

The single source argument resolves in order: existing local directory, host
named pin, then CID. `--folder PATH` remains an explicit disambiguation option.
A matching directory that is invalid or inaccessible, or a pin that is not
ready, produces an error rather than falling back. Named pins resolve once to an
immutable CID; only folders auto-update. "Alias" here means the existing named
pin, not the preserved legacy aliases table. Named input requires a host
providing `resolvePin`.

After rebuilding and importing the viewer App once, supply a local Bundle folder
instead of a content CID:

```powershell
node apps\cli\dist\main.js exec <viewer-app-cid> .\examples\check-spec
```

The folder must include `.bundle.yaml`, `check.yaml` and the referenced Markdown
files. Relative folders resolve from the CLI's working directory. Add
`--no-open` to open the reported URL manually. You do not need to build or
import the content folder after editing it.

While the page is connected, it checks for updates approximately once per
second. Each reload reads only the manifest, entry and actually referenced
Markdown files, checks their limits/type/semantics and rechecks the complete
selected file snapshot before publishing. This supports ordinary writes and
editor atomic replacements without relying on inode-based filesystem watching.
It does not watch application source or require rebuilding the App.

Changes update the existing page, preserving a selected Checkpoint if its ID
still exists. Deleted IDs return to the overview. Invalid edits hide the old
view and show an error; fixing the files restores the view automatically. The
hidden old component retains selection, but is never displayed as current
success. Closing all tabs stops the existing App lifecycle; folder polling does
not keep a disconnected service alive.

Folder mode is local development only, not a CID, pin or persistent Store
snapshot. It rejects symbolic-link resources and never uploads, imports or
modifies the folder. Use a trusted, stable local directory; path/race checks are
best-effort, not an OS sandbox against malicious same-user file replacement. CID
mode remains unchanged and immutable.

From the repository root:

```powershell
pnpm build
node apps\cli\dist\main.js bundle build examples\check-spec
node apps\cli\dist\main.js bundle import apps\check-viewer\dist\app.car
```

The example build prints its content CID and exact Check type CID; the App
import prints the viewer App CID. To associate them:

```powershell
node apps\cli\dist\main.js register set <check-type-cid> <viewer-app-cid>
node apps\cli\dist\main.js open <check-content-cid>
```

Or run the App directly:

```powershell
node apps\cli\dist\main.js exec <viewer-app-cid> <check-content-cid> --no-open
```

Remove `--no-open` to launch the system browser. `exec` requires exactly one
content CID (besides `--no-open`); the App checks its exact type before serving.
Import is not pinning; use existing pin commands for durable retention.

Root `pnpm build` creates `dist/app.car` and a separate source CAR without
importing either. Dependencies use the workspace, React is deduplicated in both
build targets, and the App stays private. No publishing, registration, shared
Store writes or automatic association happens during root build.

The authoritative App-supported definition is
[schemas/check.json](schemas/check.json). The example's `.bundle.yaml` carries
the same complete definition; a real CAR/SSR regression checks their normalized
type identity. Copy that definition for other Check bundles; do not substitute
the old Check JSON Schema (which describes a different data contract). Entry
schemas use standard JSON Schema Draft 2020-12; the Bundle definition carries no
entry default data.

Use [check.yaml](../../examples/check-spec/check.yaml) for short structural
data, with explicit [instructions](../../examples/check-spec/instructions)
Markdown files. Missing or invalid resources prevent startup; no blank
instruction fallback exists.
