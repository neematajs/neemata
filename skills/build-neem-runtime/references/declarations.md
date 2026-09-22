# Runtime Declarations

## Declaration and validation

Runtime declaration files default-export `defineRuntime(declaration)` or the
result of a package helper built on `createRuntime(commonOptions)`.

```ts
import { defineRuntime } from '@nmtjs/neem'

export default defineRuntime({
  name: 'custom',
  planner: './neem.planner.ts',
  worker: { entry: './neem.worker.ts' },
  host: { entry: './neem.host.ts' },
  env: { FEATURE_FLAG: '1' },
})
```

- `defineRuntime<const TDeclaration extends NeemRuntimeDeclaration>` returns
  `NeemMarkedRuntimeDeclaration<TDeclaration>`: a shallow-frozen, branded copy.
  Supplied `env` is separately copied and frozen; this is not deep freezing.
- Declaration fields are optional `name`, `planner`, `env`, `proxy`, `worker`,
  and `host`. A complete worker declaration requires `entry`; host `entry` is
  optional. Both accept `build: { rolldown?, chunks? }`.
- Discovery requires the marker. A plain default-exported object fails even
  if it has the right fields. `isNeemRuntimeDeclaration(value)` checks the
  marker; it does not validate all declaration fields.
- Resolution requires a worker with an entry or a custom `host.entry`.
  `host: {}` alone is invalid. Worker-only declarations get Neem's default
  no-op host and still have a host-runner thread.
- A planner is required even for host-only runtimes. Without explicit
  `planner`, lookup tries sibling `neem.planner.ts`, `.mts`, `.js`, `.mjs`, in
  that order. Host-only planners must return no workers.
- Name is the trimmed explicit `name`, otherwise the nearest nonempty
  `package.json#name` walking upward. Duplicate names fail resolution.
- Project `runtimes` entries are files, directories, globs, or negated globs
  relative to the config file. Directories use `neem.runtime.ts`, `.mts`,
  `.js`, `.mjs` in that order. Positive entries matching nothing fail.

## Entry resolution and import boundaries

`NeemEntryInput` is `string | URL`. Relative paths resolve from the runtime
declaration file, including defaults supplied by a package helper. Absolute
paths and bare package exports are accepted. URL objects must use `file:`;
use `new URL('./host.ts', import.meta.url)` for a package-relative URL, or a
published export such as `@nmtjs/workflows/neem/host`.

Keep entry specifiers in declarations instead of importing marked entries as
values. Declarations are evaluated during build/dev discovery; module-level
clients, sockets, and schedulers would be created in that process.

- Runtime worker, host, and planner are separate build targets under
  `runtime/<sanitized-name>/{worker,host,planner}`. Planner and host load in the
  host-runner thread; each worker loads in its own runtime worker thread.
- Share pure helpers and type-only imports through separate modules. Avoid
  cross-entry value imports: they pull code and side effects into another
  target. This is an ownership rule, not an enforced import prohibition.
- Separate targets do not mean one output file each. Dependencies are bundled
  by default except Node builtins and configured externals; per-target chunks
  are supported. Neem's own start/worker/host-runner infrastructure is built
  together and can share chunks, while retaining separate entry modules.
- Planner and host changes reload the runtime: threads stop and restart.
  Worker changes in `neem dev` replace the runtime generation inside the
  running thread; see [entries](entries.md). Neither path hot-swaps an
  individual entry while preserving the others' state.

## Declaration helpers and layering

`createRuntime<const TCommon extends NeemRuntimeDeclarationLayer>(common)`
returns a declaration function accepting
`const TUser extends NeemRuntimeDeclarationLayer`. Calling it returns a
`NeemMarkedRuntimeDeclaration`, not a running instance. Layer types allow
partial worker/host settings; discovery validates the merged result.

```ts
import { createRuntime } from '@nmtjs/neem'

const defineServiceRuntime = createRuntime({
  env: { FEATURE_FLAG: '0', SERVICE_KIND: 'custom' },
  worker: { build: { chunks: false } },
})

export default defineServiceRuntime({
  name: 'service',
  planner: './neem.planner.ts',
  worker: { entry: './neem.worker.ts' },
  env: { FEATURE_FLAG: '1' },
})
```

Merge rules:

- Top-level fields use common then user spread order; user values win.
- `env` merges keys common then user and is copied/frozen. Values are strings.
- `proxy` merges shallowly. `routing` is a complete mode choice
  (`path`, `subdomain`, or `default`), replaced as a whole when supplied.
- `worker` and `host` merge their entry/settings separately. Their
  `build.rolldown` options merge with user scalar priority and common plugins
  before user plugins. `build.chunks` uses the user value when defined,
  otherwise common; chunk groups are not concatenated across layers.
- `host.build` applies to both host and planner artifacts. `worker.build`
  applies to the worker. Public Rolldown options customize compilation, not
  input/output topology: Neem strips unsupported fields such as `output`.
- `chunks: false` disables Neem's default dependency chunk group; otherwise a
  `deps` group is added unless the user supplies one with that name. It does
  not promise a single output file.

Declaration env is baked into the manifest as defaults. Execution merges
project env, then runtime env, then the live process env, then explicit
per-start overrides. Host runner and workers receive the resulting environment;
there is no `ctx.env` field. Use `process.env` in the owning entry.

Use a package helper when the package supplies real defaults, including a
default planner, custom host, or worker build settings. Prefer raw
`defineRuntime` when there are no defaults. See
[package-helpers.md](package-helpers.md) for the differing Workflows and Effect
helper call shapes.
