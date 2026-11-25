# Check Spec viewer App

A private IPAB Web App created from the standard
[Bundle Viewer template](../../templates/bundle-viewer). One shared React
callback renders the existing Check definition UI. Node loads the selected
Bundle and Markdown resources before SSR; the browser hydrates the same data. It
only displays definitions, never executes instructions or checks.

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
the old Check JSON Schema (which is broader than the IPAB structural dialect).

Use [check.yaml](../../examples/check-spec/check.yaml) for short structural
data, with explicit [instructions](../../examples/check-spec/instructions)
Markdown files. Missing or invalid resources prevent startup; no blank
instruction fallback exists.
