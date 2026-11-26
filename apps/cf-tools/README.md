# Self-installing Cloudflare Apps

This private workspace builds two ordinary IPAB Node App Bundles:
`dist/cf-local.car` and `dist/cf-deploy.car`. Both consume the exact Worker type
defined by `packages/pointer-worker/bundle-definition.json`. There is no new
IPAB runtime, global Wrangler requirement or automatic npm publication.

## Build and import

From the repository root:

```powershell
pnpm exec turbo run build --filter=@ipab/cf-tools
ipab bundle import .\packages\pointer-worker\dist\worker.car
ipab bundle import .\apps\cf-tools\dist\cf-local.car
ipab bundle import .\apps\cf-tools\dist\cf-deploy.car
```

Each import prints a CID. Pin the returned CIDs under `pointer-worker`,
`cf-local` and `cf-deploy` respectively. Import alone does not retain content.
The builds do not import or change the device's Store.

## Installation contract

The App's self-contained bootstrap reads its embedded `package.json`,
`pnpm-lock.yaml` and `pnpm-workspace.yaml`, then runs
`pnpm install --frozen-lockfile --prod`. Wrangler is pinned to the workspace
catalog version; update the payload manifest and its pnpm lock together when
changing that version. The payload explicitly allows esbuild/workerd build
scripts without changing device-wide policy.

Installations default to
`~/.ipab/app-installs/<app-cid>/<platform-arch-node>/package`.
`IPAB_APP_INSTALL_ROOT` overrides the root. The exact pnpm version declared in
the payload's packageManager must already be installed (currently 11.28.12);
`IPAB_PNPM_CLI` can explicitly name its `pnpm.mjs`, `pnpm.cjs`, or official
`@pnpm/exe` `pnpm.exe`; package identity and the exact version are checked
before use. Native pnpm runs beneath the same guarded Node process so
cancellation still terminates only its owned process tree. It never uses a
Corepack shim. Missing or mismatched tools fail explicitly; no pnpm download or
version switch occurs. The active device registry/configuration is respected,
never replaced by a command-line override. pnpm uses its global virtual store to
reuse dependency files and avoid nesting native binaries under long CID paths on
Windows; App installation directories remain separate. Network access, lifecycle
scripts and platform binaries may be required. This is not an offline delivery
or a sandbox.

A ready marker is trusted without hashing or comparing installed files.
`--reinstall` re-extracts the Bundle payload and installs into fresh staging;
failed installation leaves the previous installation intact. It does not upgrade
the Bundle CID, remove pnpm's store, reset credentials or delete Worker state.
Installation/reinstallation requires an exclusive SQLite lock, which is released
before running the program. Running instances hold shared read locks: normal
runs can coexist, but reinstall fails explicitly while any instance is running.
SQLite rollback-journal mode is intentional; WAL would not provide this
reader/writer exclusion. The OS releases locks even after forced process
termination, so a persistent lock file does not block the next run.

The bootstrap retains IPAB context; only Wrangler runs as a subprocess.
Arguments are validated rather than passed through unrestrictedly to Wrangler.
Cancellation terminates the subprocess tree; an IPC parent guard also stops
Wrangler descendants if the bootstrap is forcibly terminated. Diagnostics go to
stderr.

## Local Pointer service

```powershell
ipab exec cf-local pointer-worker --port 8787 --state-dir .\.wrangler\pointer-state
ipab exec cf-local pointer-worker --reinstall --port 8787
```

Only local bindings are enabled, listening on `127.0.0.1`. The default
persistent state directory is `~/.ipab/cf-state/ipab-pointer-local`, independent
of App/Worker CIDs, so changing code does not implicitly discard DO state.
Choose explicit separate state directories for independent instances.

For authenticated requests, supply `--secrets-file` with an account-only JSON
file containing only `POINTER_API_KEY_SHA256`, a 64-character lowercase SHA-256
digest. The local App writes a protected temporary `.dev.vars`; it never embeds
secrets in a Bundle. Without this secret, health checks work but pointer
creation is disabled. See
[operator setup](../../packages/pointer-worker/README.md).

## Deployment

Create an instance target JSON outside the Bundle:

```json
{
  "name": "my-pointer",
  "account_id": "<your 32-character Cloudflare account ID>",
  "workers_dev": true,
  "vars": {
    "POINTER_SERVICE": "https://pointers.example.com",
    "ALLOWED_ORIGIN": ""
  }
}
```

Optional `routes` follows Wrangler's route shape. No code entry, compatibility
date, DO bindings, migration or build-hook overrides are accepted. Credentials
are supplied through Wrangler's normal authentication, not App arguments. Use an
account-scoped API token with the permissions required for your Worker and
routes; never put its value in shell arguments or IPAB history.

```powershell
# Default: packaging/validation only, no upload.
ipab exec cf-deploy pointer-worker --target .\target.json

# Explicit remote write; this is not executed by repository builds/tests.
ipab exec cf-deploy pointer-worker --target .\target.json --secrets-file .\.keys\worker-secrets.json --deploy
```

For the first deployment provide the digest secrets file; when omitted, Wrangler
retains previously deployed secrets. Local secret files are checked for
account-only access. Make the configured origin match the intended deployed URL.
Each successful invocation writes a Result Bundle with the Worker/App CIDs,
target account/name and `dry-run` or `deployed` status. It is an execution
receipt, not a remote runtime verification or database snapshot. A dry-run
cannot prove authentication, resource availability or production behavior; code
rollback does not roll back Durable Object data.

## Validation

```powershell
pnpm exec turbo run test-ci --filter=@ipab/cf-tools
pnpm --filter @ipab/cf-tools test
pnpm check
```

The `release-e2e` smoke uses isolated IPAB state, installs the embedded pnpm
payload, starts the real local Worker, checks its health, and performs only a
deployment dry-run against a placeholder target. It never deploys remotely.
