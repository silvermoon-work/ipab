# @ipab/web-app

The first npm release is being prepared as `0.1.0-rc.0`.

A small local browser bridge for **trusted Node IPAB Apps**. This is not a Node
sandbox and does not make an untrusted application safe. The browser author page
runs in an opaque `sandbox="allow-scripts allow-forms"` iframe; the framework
host never imports author modules. Only explicitly named backend methods are
exposed. `allow-forms` enables JavaScript-managed `submit` events and
`preventDefault()`; the iframe CSP retains `form-action 'none'` to prohibit
network form navigation.

```ts
import { defineWebAppMethod, runWebApp } from "@ipab/web-app";

const text = {
  parse(value: unknown): string {
    if (typeof value !== "string") throw new Error("Expected text");
    return value;
  },
};

await runWebApp({
  context, // { appCid, readFile(rootCid, path, {signal}?) }
  frontendRoot: "resources/web",
  handlers: {
    greet: defineWebAppMethod({
      request: text,
      response: text,
      handle(input, { signal, emit }) {
        signal.throwIfAborted();
        emit("greeting", { name: input });
        return `Hello, ${input}!`;
      },
    }),
  },
});
```

The author browser entry is bundled locally with Vite using `base: "./"`:

```ts
import { connectWebApp } from "@ipab/web-app/browser";

const app = await connectWebApp();
const unsubscribe = app.onEvent(({ name, data }) => console.log(name, data));
const controller = new AbortController();
const greeting = await app.request("greet", "Ada", {
  signal: controller.signal,
});
// controller.abort() cancels only this call.
unsubscribe();
app.close();
```

Both runtime parsers are mandatory and run before/after the handler. The
`defineWebAppMethod` helper keeps handler input/output typed; responses and
events must be finite plain JSON. Transport permits at most 64 KiB, 4096 JSON
nodes, 16 nesting levels, 32 outstanding calls/session and 32 live sessions.
Events are bounded to 64 queued messages and 64 KiB total. Invalid method
requests receive fixed errors without backend exception text. There is no
filesystem or CID proxy. Backend code explicitly decides what content to read or
expose.

`runWebApp` binds `127.0.0.1` at a random port and returns `Promise<void>`. Its
`onDiagnostic(message)` callback (default `console.error`) reports a URL
**waiting for frontend connection**, not a claim that the frontend rendered. By
default, the ready server launches that URL in the system browser using `open`
on macOS, `rundll32.exe` on Windows, or `xdg-open` on Linux. Set
`openBrowser: false` to disable launching programmatically. The framework also
recognises the reserved App argument `--no-open`: `ipab exec APP --no-open` (no
extra `--` is needed). This argument takes precedence over `openBrowser`,
including in existing Apps rebuilt with this framework. Launch failures report a
diagnostic with the URL and leave the server available for manual access; a
successful launcher exit does not prove the page rendered. An optional `signal`,
SIGINT or SIGTERM aborts active calls, closes HTTP connections and rejects with
`AbortError`; cleanup errors reject explicitly. The App owns its context and
must close it separately. Handlers must cooperate with the per-call abort
signal: uncooperative arbitrary Node work cannot be forcibly stopped.

Each host tab has an independent random session. The process stays alive before
the first handshake; after the last disconnect it allows three seconds for a
reconnecting tab, then closes. Polling renews a 30-second lease to clean up tabs
that disappear without a disconnect. Individual calls time out after 30 seconds.
Host pagehide and `app.close()` disconnect. A reloaded author iframe should
reload the host page too; a host grants only one port.

Only safe relative paths below the configured bundle frontend root are read.
`/frame/index.html` and relative `./assets/*` work without rewriting Vite
output. HTML, JavaScript, CSS, JSON, common raster images, icons and WOFF fonts
have explicit MIME types; other types are refused. CSP blocks remote resources,
arbitrary network calls, nested frames and workers; no CDN or remote fallback
exists. Static assets are immutable with `Access-Control-Allow-Origin: null` for
opaque module imports. The host API requires its exact Host and Origin plus a
non-simple secret custom header; it provides no API CORS/preflight permission.
The author talks only over a transferred MessagePort, not directly to HTTP.

Development: `pnpm --filter @ipab/web-app build`, `typecheck`, `test`, and
`test-coverage` use the shared runner/configuration. Tests cover actual HTTP,
browser port behavior and serialized framework code via Node VM. End-to-end
browser validation should open the reported host URL, wait for the author
handshake, call a handler, observe an event and cancellation, verify
opaque-frame module loading, then close the browser tab and await the server
lifecycle.
