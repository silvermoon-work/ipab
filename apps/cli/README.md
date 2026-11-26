# @ipab/cli

Node subprocess App host for IPAB (InterPlanetary Artifact Bundle). **Not a
sandbox**: only execute Apps you trust.

`0.1.0-rc.0` is published. The next candidate is `0.1.0-rc.1`; until it is
published, install the existing RC:

```sh
npm install --global @ipab/cli@0.1.0-rc.0
ipab --version
ipab --help
```

Node.js 22.15.0 or newer is required. Built-in Node and Web App project
templates are validated CAR assets shipped in this package; initialization works
offline and does not install dependencies or run hooks.

See the [user guide](https://github.com/silvermoon-work/ipab#readme) and
[command reference](https://github.com/silvermoon-work/ipab/blob/main/docs/reference.md)
for Store configuration, execution, pins, templates and App development.

The rc.1 candidate removes the Kubo RPC backend and legacy alias state. Use the
Local Store and `store.gateway`; reset old `store.rpc` configuration and rebuild
local named pins. Remote Kubo pins and retention are not automatically migrated
or released. This is an intentional prerelease compatibility change.
