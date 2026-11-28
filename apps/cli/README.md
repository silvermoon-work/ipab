# @ipab/cli

Node subprocess App host for IPAB (InterPlanetary Artifact Bundle). **Not a
sandbox**: only execute Apps you trust.

`ipab setup --yes` verifies/installs the shared Kubo program and prepares the
protected HOME identity without contacting or starting a daemon. It is
idempotent; independent CID/local Store use still does not require Kubo.

`0.1.0-rc.2` is published. Install this RC:

```sh
npm install --global @ipab/cli@0.1.0-rc.2
ipab --version
ipab --help
```

Node.js 22.15.0 or newer is required. Built-in Node and Web App project
templates are validated CAR assets shipped in this package; initialization works
offline and does not install dependencies or run hooks.

The current source also ships `builtin:skill.ipab`, a validated Markdown Skill
Bundle about sharing information and Artifacts between people and Agents within
a Swarm. Export it offline with `ipab get builtin:skill.ipab`; its concise
`SKILL.md` links bundled usage references. It is not included in the published
rc.2 release. Shipping the Bundle does not install it into Agent directories or
configure automatic loading.

See the [user guide](https://github.com/silvermoon-work/ipab#readme) and
[command reference](https://github.com/silvermoon-work/ipab/blob/main/docs/reference.md)
for Store configuration, execution, pins, templates and App development.

The current CLI removes the Kubo RPC backend and legacy alias state. Use the
Local Store and `store.gateway`; reset old `store.rpc` configuration and rebuild
local named pins. Remote Kubo pins and retention are not automatically migrated
or released. This is an intentional prerelease compatibility change.

The rc.2 release adds shared swarm Names, authenticated five-minute HEAD
caching, local swarm registration/selection and named search. See the
[MVP implementation](../../docs/mvp-implementation.md) for force controls and
the migration from legacy creation/membership records.

The current source implements
[Scope / Variable onboarding](../../docs/onboarding.md): signed Request files,
trusted Owner fingerprints, encrypted nonexpiring exact-ID certificates, lazy
membership activation and checksum-verified managed Kubo 0.43.2 nodes. Each
Swarm uses a separate protected repo, key and ports; daemons start on demand and
survive CLI exit. No Invite/Response/Join or old Swarm CID protocol fallback
exists.

Shared references use `ipab://ALIAS_OR_ENCODED_CONFIG_URL/PATH`; `ipab:///PATH`
selects `--swarm` or the saved `swarm.default`, in that order. URI swarm
authorities take precedence and local aliases are case-sensitive. Search emits
full configuration-URL-based URIs for sharing across devices. Legacy `name:PATH`
references and `IPAB_SWARM` are no longer supported; remove the variable and use
`--swarm` or `swarm use`.

Owner uses `swarm update` for organization information and `swarm exclude` /
`swarm resume` for irreversible, resumable member removal. Members change only
their own public profile using `swarm profile`. HEAD uses content-CID CAS, not a
history revision.
