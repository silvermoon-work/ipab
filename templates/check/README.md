# Check App template

Data-only Project Template Bundle, selected through the existing explicit
directory/CAR/CID interface. Init runs no code and installs nothing. The private
SDK is linked explicitly; there is no invented npm version or builtin shortcut.

After building this workspace, with the locally linked IPAB CLI:

```powershell
$template = (Resolve-Path .\templates\check).Path
$sdk = (Resolve-Path .\packages\check-sdk).Path
ipab init greeting-check --template $template --param "checkSdkDependency=link:$sdk"
Set-Location .\greeting-check
pnpm install
pnpm typecheck
pnpm build
'{"text":"hello"}' | ipab exec <app-cid>
'{"text":"goodbye"}' | ipab exec <app-cid>
```

Use the App CID from build. Both checks exit 0 and commit a result; the second
has `pass:false` and a structured problem. Malformed/schema-invalid STDIN exits
nonzero without a committed output. Query IPAB history for the output CID.

Edit `src/check.ts` to define global parameters and a single Checkpoint or
ordered array. A subsequent Checkpoint can read a typed earlier success via
`context.outputOf(previous)`. Each step documents its rules, instructions and
success facts; no separate per-problem documents or contract arrays are needed.
`src/main.ts` contains only SDK startup and explicit error reporting.

The trusted `ipab-prebuild` hook generates a Check Spec model with external
instruction Markdown, embeds its actual UnixFS directory in the App and records
its CID. Runtime links that same directory into Result Bundle `check/`; it does
not copy documents or calculate a Markdown closure. Additional model resources
must be explicitly mapped in `scripts/ipab-prebuild.mjs`.

This development recipe uses pnpm `link:` to preserve the private SDK's
workspace runtime dependencies. Do not substitute npm directory installation or
assume a published package. The generated project is private; building and
running code is explicitly trusted and not sandboxed. See the
[SDK contract](../../packages/check-sdk).
