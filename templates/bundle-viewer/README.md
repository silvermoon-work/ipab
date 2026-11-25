# React Bundle Viewer template

This is a standard **data-only Project Template Bundle**, selectable through the
existing explicit directory/CAR/CID template interface. It is not yet an
installed `builtin:template.*` shortcut. Init runs no code and installs nothing.

From this repository, after `pnpm build`, use the local private framework:

```powershell
$template = (Resolve-Path .\templates\bundle-viewer).Path
$framework = (Resolve-Path .\packages\bundle-viewer).Path
ipab init reader --template $template --param "bundleViewerDependency=link:$framework"
```

Install the generated project's dependencies, then `pnpm typecheck` and
`pnpm build` using the locally linked `ipab` CLI. As with the existing Web App
template, private workspace runtime dependencies are not a published npm
delivery. The local pnpm `link:` dependency preserves the built framework's
workspace dependency links; use pnpm rather than npm for this local recipe. No
registry version is invented.

The template's Node build aliases React to the generated project's instance;
Vite deduplicates React and React DOM. Preserve these settings when linking
local components/frameworks, otherwise duplicate React can break hooks in SSR or
hydration even when package versions are equal.

Customize only the viewer callback in `src/shared/viewer.ts` for UI logic.
Replace `schemas/content.json` with your complete supported type definition;
this declarative metadata is required in addition to the callback, not a second
renderer implementation. Both entries import the same component.

The example supports a Bundle named `IPAB Message` with a JSON `message.json`
entry `{ "message": "..." }`. Its exact normalized `.bundle.yaml` definition
must equal `schemas/content.json`. Build/import that Content Bundle with the
existing bundle tools, build/import the reader App, register the exact type CID
to the reader App, then `ipab open CONTENT_CID`. Direct
`ipab exec APP_CID CONTENT_CID` also validates the type before serving.
`--no-open` is preserved. The example's More/Less interaction is hydrated; its
heading is already present in the initial HTTP HTML.

Never access `window` or `document` during initial render. Browser-only
navigation and responsive state must initialize deterministically and update in
effects after hydration. A Check viewer migration must use its existing React
component, not its `createRoot` browser Task entry.
