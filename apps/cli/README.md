# @ipab/cli

Node subprocess App host for IPAB (InterPlanetary Artifact Bundle). **Not a
sandbox**: only execute Apps you trust.

`0.1.0-rc.2` is published. Install this RC:

```sh
npm install --global @ipab/cli@0.1.0-rc.2
ipab --version
ipab --help
```

Node.js 22.15.0 or newer is required. Built-in Node and Web App project
templates are validated CAR assets shipped in this package; initialization works
offline and does not install dependencies or run hooks.

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

Shared references use `ipab://SWARM_CID_OR_ALIAS/PATH`; `ipab:///PATH` selects
`--swarm` or the saved `swarm.default`, in that order. URI swarm authorities
take precedence and local aliases are case-sensitive. Search emits full
CID-based URIs for sharing across devices. Legacy `name:PATH` references and
`IPAB_SWARM` are no longer supported; remove the variable and use `--swarm` or
`swarm use`.

Authorized members can also use `swarm update --name TEXT --description TEXT` to
edit shared swarm information with last-write-wins semantics while preserving
concurrent Name mappings.
