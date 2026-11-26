# @silvermoon-work/devtool.package-smoke

Private experiment; not included in IPAB's npm release.

```sh
package-smoke --verify scripts/package-smoke.mjs --allow-build esbuild
```

Run through pnpm from a workspace root with an exact `packageManager`, after
building its packages. The tool uses that active pnpm to enumerate the
workspace, pack every non-private member (including a non-private root), and
install all tarballs in a new temporary consumer. Internal dependencies are
overridden to the same tarballs, never linked to workspace source. Nothing is
published.

The trusted project's standalone `.mjs` verifier is copied into the consumer and
executed with Node from that directory. Package imports resolve to installed
packages. `smoke-packages.json` lists their names. The verifier must not rely on
relative imports or assets from its original directory.

Dependency install scripts need explicit `--allow-build PACKAGE` permission;
otherwise pnpm's policy fails the installation when builds require approval. The
current machine's registry is preserved. Commands have a five-minute timeout,
failures stop the check, and only this invocation's temporary directory is
removed. The temporary directory is not a sandbox: installation and verification
execute trusted code with the current user's permissions.
