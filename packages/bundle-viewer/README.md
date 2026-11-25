# @ipab/bundle-viewer (private)

An optional `prepareData(data, { readFile, signal })` runs once in Node after
entry/type validation and before the server starts. It may resolve explicit
resources in the selected Content Bundle; errors reject startup. Its returned
JSON is checked by the existing canonical-state budget, rendered in SSR and sent
unchanged for hydration. This is not a browser file proxy or a second renderer
callback. [Check Spec](../check-spec) uses it for Markdown instructions.

React Content Bundle viewers layered on `@ipab/web-app`. One **isomorphic React
component callback** is compiled into the Node App and browser entry. The
adapter loads the selected immutable Content Bundle, checks its exact type CID
and entry data, renders real viewer HTML on the server, and hydrates the same
tree in the opaque author iframe. The host never imports viewer modules.

```ts
import { createElement } from "react";
import type { BundleViewer } from "@ipab/bundle-viewer/browser";

export const viewer: BundleViewer = ({ data }) =>
  createElement(MyBundleViewer, { data });
```

The server calls
`runBundleViewer({ context, contentCid, schema, viewer, frontendRoot: "resources/web" })`.
`schema` is the complete supported Bundle definition, not a bare JSON Schema.
The browser calls `await hydrateBundleViewer(viewer)`. Initialization and build
plumbing are provided by the [standard template](../../templates/bundle-viewer).

The component must render the same initial tree on Node and in the browser. Use
effects for `window`, media queries, URL restoration and other browser-only
work. A DOM `mount` callback, legacy renderer object or browser Task cannot
automatically become SSR. This synchronous adapter does not promise async
Suspense/streaming SSR. No CLI alias, legacy Task runtime or old Viewer manifest
is migrated; IPAB `register` / `open` remains the routing mechanism.

Input files and canonical state are bounded to 1 MiB each; HTML to 8 MiB.
Bootstrap state is embedded as escaped inert JSON rather than going through the
64 KiB RPC channel. The dynamic index is `no-store`; static bundle assets retain
their immutable cache and existing CSP. Rendering errors produce HTTP 500 plus a
backend diagnostic, not a successful empty shell. Hydration errors are reported
to the browser console. Close, pagehide and abort unmount React and disconnect
the existing Web App lease.

The adapter reads the manifest and entry through the caller's IPAB context; the
context owns storage integrity/access. It does not independently scan all
resource files, import, pin, retain, modify local files, or provide arbitrary
browser CID/file access. Bundle schemas use the current IPAB structural dialect;
old Check document `$schema` URIs are not IPAB type identities.

This is for trusted Node Apps, not a Node sandbox or public deployment server.
Existing Web Apps are unchanged unless they opt into the frontend render hook.
