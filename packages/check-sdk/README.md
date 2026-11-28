# Check SDK (private)

Typed, ordered Checkpoints for IPAB Node Apps. This borrows execution-local
composition from OKR Agent, not its Task Protocol, worker, ContentRef or legacy
graph interfaces. The SDK and [Check template](../../templates/check) are
private workspace tooling, not npm delivery or a new installed builtin.

## Authoring

`defineCheckpoint` takes id, optional title (defaults to id), description,
instructions, rules, success-output documentation and a sync/async `check`
callback. Rules use portable lowercase identifiers and are unique within a
Checkpoint. Return either:

```ts
{ pass: true, output: { root, head } }
{ pass: false, problems: [{ code: "worktree-clean", context: { files } }] }
```

Failure problems must be nonempty and codes must belong to that Checkpoint.
Context is finite, acyclic JSON data with safe integers. No per-problem document
or reference is generated. Duplicate problem codes are allowed for distinct
facts.

`defineCheck({name, description, parameters, checkpoints})` accepts a single
Checkpoint or a nonempty ordered array. Global `parameters` has a JSON object
`schema` and a typed `parse(unknown)` callback. SDK validation runs before parse
or any Checkpoint, without coercion, defaults, remote schema loading or
stripping extra properties. The parser supplies the TypeScript boundary; it may
throw. There is no repeated per-Checkpoint target schema or separate ID/code
contract. Definitions generate the matching Check model and instruction
documents.

Checkpoints receive the parsed input and `{signal, outputOf}`. `outputOf(step)`
returns the typed original success value of an earlier successful **definition
object in this execution**, not a lookup by id. Current, future, foreign and
previous-run values are unavailable. Map, functions and circular success objects
can remain execution-local; they are never serialized, deep-frozen, logged or
published. Author code owns input/output mutation. All steps run in order; the
first failure stops later steps and preserves every problem in that step.

## Runtime

`runCheck(check)` reads one UTF-8 JSON value from STDIN (at most 1 MiB).
Duplicate keys, trailing documents, invalid UTF-8 and invalid global input fail
execution. argv and stdio remain ordinary IPAB channels, not Task RPC. There is
no automatic stdout report or input publication.

The App embeds a real Check Spec Bundle at `resources/check/` and its accurate
CID at `resources/check-model.json`. Runtime verifies its type and resolved
model against the executable definition before checking. The model uses the pure
Check Spec type identity and can be opened by the rebuilt Check viewer.

Normal completion writes:

```text
.bundle.yaml
.bundle-type.yaml # pure MIME / JSON Schema type
result.json       # entry
check/            # real UnixFS DAG link to the embedded original model
```

Entry is `{check:"check", checkpoint, pass:true}`, or the same header with
`pass:false, problems:[{code,context}, ...]`. `checkpoint` is the failed step;
when every step passes, it is the final passed step. No empty Check is
permitted. The fixed JSON result type is independent of any individual
Check/model CID. `check` is a Bundle-relative directory path, not a weak CID
string. Serialized results must fit the existing Bundle entry limit of 8 MiB;
oversized reports fail before any output write or model link.

Business failure completes the App normally (exit 0) so IPAB commits its report.
Thrown errors, cancellation, invalid callback data and output faults reject; the
template reports them on stderr and exits nonzero. No partial result is
committed. IPAB reports the whole output directory CID and owns its retention.
Retaining that root protects the linked model DAG without duplicating model file
blocks. No Markdown link closure or network fetch is performed.

For explicit embedding/tests, `runCheck` accepts `{context,input,signal}` and
returns the same report after writes; `executeCheck(check,value,signal)`
executes without output packaging.

## Building

`buildCheckApp` from `@ipab/check-sdk/build` runs only in an explicitly trusted
`ipab-prebuild` hook. It requires an empty output directory, loads the
definition module's default export, generates its model, computes the
deterministic model CID, and bundles the Node entry. Its output has `app.cjs`,
`check/` and `check-model.json`, selected by the template's `ipab.yaml`. The
output directory must be inside the project, as provided by IPAB's owned
prebuild staging, so externalized build-time imports resolve from that project.

Optional `resources: {"references/shared.md":"docs/shared.md"}` explicitly
copies project files into the model. Sources are directory-bound, nonsymlink
files; resource files are limited to 1 MiB and the whole Bundle retains existing
budgets. Generated-path collisions and hidden custom resources fail. Links stay
as authored; they do not cause implicit reads or dependency-closure generation.
Instructions are generated as `instructions/<id>.md`; link relative to those
locations. Builds and imports never execute the runtime Check callback.

This is not a sandbox. Building evaluates trusted project definitions; running
Checks retains the user's filesystem, process, network and environment access.

## Validation

Use `pnpm exec turbo run test typecheck --filter=@ipab/check-sdk`. Tests include
real template creation, strict compilation, App CAR import, STDIN execution,
pass/fail commitment and exact model-DAG reuse. Root `pnpm check` runs daily
unit/mock validation; `pnpm check-release` retains full E2E and all four
existing 90% coverage thresholds.
