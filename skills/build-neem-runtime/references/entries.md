# Runtime Entries

Import helpers and public types from `@nmtjs/neem`. Runtime worker, planner,
and host modules default-export values produced by their respective helpers.
Neem checks markers on import; marker guards do not validate full shapes.

## Worker entry

`defineRuntimeWorker<Data = unknown, Definition = unknown>(worker)` accepts
`Omit<NeemRuntimeWorker<Data, Definition>, '_'>` and returns
`NeemRuntimeWorker<Data, Definition>`. Both `definition` and `createRuntime`
are required; `definition: undefined` is valid. The helper brands and
shallow-freezes a copy without freezing the caller's input or nested definition.
`isNeemRuntimeWorker(value)` checks this object marker.

`createRuntime(ctx)` may return `NeemRuntime` synchronously or asynchronously.
The exact `NeemRuntimeWorkerContext<Data, Definition>` fields are:

| Field        | Value                                                     |
| ------------ | --------------------------------------------------------- |
| `mode`       | `'development'` or `'production'`                         |
| `name`       | Worker thread name, e.g. `jobs:0` or `jobs:execution:0`   |
| `data`       | This worker's cloned planner item (`Data`)                |
| `definition` | The entry's worker-local `Definition`, not planner output |
| `logger`     | Pino `Logger` for this worker                             |
| `port`       | Node `MessagePort` paired with the host's thread handle   |

Definitions can contain functions/resources that cannot be cloned: they are
loaded in each worker, not transferred from the planner. Prefer acquiring
resources in the factory or `start()` so their cleanup has an explicit owner.
`InferNeemRuntimeWorkerData<TWorker>` extracts the worker data type; the `_`
member is an optional type witness, not runtime data to populate.

```ts
import { defineRuntimeWorker } from '@nmtjs/neem'

type WorkerData = { shard: number }
type Definition = { kind: string }

export default defineRuntimeWorker<WorkerData, Definition>({
  definition: { kind: 'custom' },
  createRuntime(ctx) {
    function onMessage(message: unknown) {
      ctx.logger.info({ message }, 'host message')
    }

    return {
      start() {
        ctx.port.on('message', onMessage)
        ctx.port.postMessage({ type: 'ready', shard: ctx.data.shard })
        // No proxy upstreams; the host receives this queued message later.
        return undefined
      },
      stop() {
        ctx.port.off('message', onMessage)
      },
    }
  },
})
```

`NeemRuntime` has required `start()` and `stop()`, plus optional
`readonly finished?: PromiseLike<void>`:

- `start(): MaybePromise<readonly NeemRuntimeUpstream[] | undefined>` resolves
  when ready. `[]`, explicit `undefined`, or a contextually typed omitted
  return all mean no upstreams.
- Each upstream is `{ type: 'http' | 'http2' | 'ws', url: string }`. Neem
  validates the array and URL strings before announcing readiness. Invalid
  results fail startup. These are proxy destinations, not worker handles or
  disposers; open the listener before returning its URL.
- `stop(): MaybePromise<void>` owns resource cleanup, including partial
  startup. It may run before `start()`, while `start()` is pending, or after a
  rejected start. If the async factory rejects without returning a runtime,
  it must release anything it acquired itself.
- Neem observes `finished` after readiness. Fulfillment or rejection before a
  requested stop is a runtime failure, including successful early completion.
  Expose it for long-running work; detached task failures need supervision by
  the runtime. If this promise can reject before readiness, attach a rejection
  observer immediately while retaining the original promise for Neem.
- During `neem dev`, an edit to the worker or its bundled dependencies
  replaces the runtime generation in the same thread: Neem awaits `stop()`,
  creates the updated runtime, then calls `start()`. Module state in unchanged
  modules survives; runtime resources do not. Changed upstreams, rejected or
  failed patches, and the `build.updates.maxPatches` budget (default 50) restart
  the thread instead. Declare `reload: 'thread'` on the worker when a fresh
  thread is required on every edit.

## Planner entry

`defineRuntimePlanner` has generics `Options = unknown`, `Data = unknown`, and
`const TPlanner extends NeemRuntimePlanner<Options, Data> =
NeemRuntimePlanner<Options, Data>`. It accepts `planner: TPlanner` and returns
`TPlanner`. It brands the input function in place and leaves it unfrozen.
`isNeemRuntimePlanner` checks the function marker.

`NeemRuntimePlanner<Options, Data>` takes `NeemRuntimePlannerContext` with
exactly `{ mode, name, logger }`: mode, runtime name, and a Pino `Logger`.
It returns `NeemRuntimePlan<Options, Data>` or a promise of it:

- Required `workers`: `readonly Data[]` or
  `Record<string, readonly Data[]>`. Array names are `<runtime>:<index>`;
  grouped names are `<runtime>:<group>:<index>`. Groups share the same worker
  entry; use a data discriminator for different roles.
- Optional `options?: Options`: passed to the host factory in the same
  host-runner thread. It is retained there, so it need not be cloneable.
- Worker items cross threads and must be structured-cloneable. Host-only
  runtimes return `workers: []` (or empty groups); nonempty workers require a
  worker artifact.
- `Options` and `Data` are independent. Use `undefined` for absent host
  options. Even with a concrete `Options`, the plan type keeps `options`
  optional: the package must ensure it supplies the value or make its host
  handle `undefined`.

```ts
import { defineRuntimePlanner } from '@nmtjs/neem'

export default defineRuntimePlanner<undefined, { shard: number }>((ctx) => {
  ctx.logger.info({ name: ctx.name }, 'planning runtime')
  return { workers: [{ shard: 0 }, { shard: 1 }] }
})
```

## Host entry and ports

`defineRuntimeHost` has `Options = unknown` and a `const TFactory` constrained
to `(params: NeemRuntimeHostFactoryParams<Options>) =>
MaybePromise<NeemRuntimeHost>`, defaulting to that function type. It accepts
`factory: TFactory` and returns `TFactory`. Branding mutates the function
without freezing it; `isNeemRuntimeHostFactory` checks the marker.

`NeemRuntimeHostFactory<Options = unknown, THost extends NeemRuntimeHost =
NeemRuntimeHost>` is the public factory type, returning `MaybePromise<THost>`.
Its parameters are exactly `{ mode, name, logger, threads, options }`:
mode, runtime name, Pino logger, `readonly NeemRuntimeThreadHandle[]`, and the
planner's `Options`. Each handle has only `{ name: string, port: MessagePort }`.
There is no top-level host port or thread control API. Host-only runtimes get
an empty array. `NeemRuntimeHost` has optional `start()` and `stop()`, both
returning `MaybePromise<void>`; it has no upstream result or `finished` field.

```ts
import { defineRuntimeHost } from '@nmtjs/neem'

export default defineRuntimeHost<undefined>(({ name, logger, threads }) => ({
  start() {
    for (const thread of threads) {
      thread.port.on('message', (message: unknown) => {
        logger.info({ worker: thread.name, message }, 'worker message')
      })
    }
    logger.info({ name, count: threads.length }, 'host started')
  },
  stop() {
    logger.info({ name }, 'host stopped')
  },
}))
```

Use a host for shared services and coordination. Neem creates a MessageChannel
per worker, transfers one end as worker `ctx.port`, and later transfers the
peer to the host runner as `thread.port`. The package owns the message protocol
and its listeners/resources. Neem closes ports during shutdown; manual close
is not required. Host stop finishes before worker stop begins, so do not rely
on host-port messaging during worker finalization.

The worker's internal `parentPort` carries Neem lifecycle messages. Never use
it for the package protocol; `ctx.port` is the public coordination channel.

## Startup, shutdown, and failures

Normal order is planner -> all worker factories/start calls (concurrent) ->
host factory -> optional host start -> runtime ready. A worker must not wait
for host configuration before resolving `start()`: the host does not exist yet.

Shutdown calls host stop, then stops all workers concurrently, then shuts down
the host runner. A host stop error does not skip worker cleanup.

- Worker readiness has a fixed 30,000 ms timeout.
- Worker stop has a hard 5,000 ms deadline from its stop request. This includes
  waiting for a pending factory and all finalizers; then Neem terminates the
  thread. There is no public configurable worker stop deadline. Package-level
  timeouts cannot extend it.
- Stop during bootstrap awaits the factory and invokes the eventual runtime's
  stop once, even if start has not run. Stop during start invokes cleanup
  without waiting for readiness. Late readiness is suppressed, and rejection
  of pending readiness does not terminate a thread before its stop deadline.
- A rejected start or invalid start result invokes runtime stop once before
  reporting the original start error. Cleanup failures are logged. If this
  cleanup hangs, the worker readiness timeout still bounds startup.
- Host-runner RPC requests (plan/start/stop/shutdown) default to 30,000 ms,
  overridable with positive `NEEM_HOST_RUNNER_REQUEST_TIMEOUT_MS` in its env.
  After shutdown acknowledgement, runner exit has a separate 5,000 ms wait
  before termination. These are distinct from the worker stop deadline.

A worker-reported error reaches the host as `NeemWorkerError`, with `worker`,
`origin: NeemWorkerErrorOrigin`, and an `Error` cause containing the serialized
summary. Origins are `bootstrap` (import/marker/factory), `start`
(start/readiness-result validation), and `runtime` (uncaught error, unhandled
rejection, premature `finished`, or stop failure). The worker logs the original
value; the host cause is not the original cross-thread object. The constructor
accepts `{ worker: string, origin, cause: Error }`. Native thread errors,
unexpected exits, and controller timeouts can be ordinary errors instead.

When readiness is still pending, failure rejects startup and cleans up the
runtime and sibling workers. It does not call the ready-worker recovery path.
After readiness, failure reaches runtime recovery/failure handling, including
when a `worker:ready` hook is still pending. Do not swallow initialization
errors and return an apparently healthy worker.

## Plugin hooks

A plugin entry default-exports `definePluginHooks(factory)`, where
`definePluginHooks<const T extends NeemPluginHooksFactory>(factory: T): T`
is an identity helper, not a marker or freezer. Neem requires a function here,
not a branded runtime entry. Register its specifier through
`definePlugin({ name, entry })` in the project config's `plugins` array.
Plugin declarations also accept `options` and `build.rolldown`.

`NeemPluginHooksFactory<Options = unknown>` returns `NeemPluginHooks` or a
promise. Its
`NeemPluginHooksContext<Options = unknown>` has exactly
`{ name, mode, options, logger, getHealth }`: plugin name, mode, configured
options, Pino logger, and `getHealth(): NeemRuntimeServerHealth`. Options
default to `unknown`; narrow them in the factory when needed. Hooks run with
the runtime server controller, not inside each runtime worker or host runner.

```ts
import { definePluginHooks } from '@nmtjs/neem'

export default definePluginHooks(({ logger }) => ({
  'worker:fail'({ name, error }) {
    logger.error({ worker: name, err: error }, 'worker failed')
  },
}))
```

`NeemPluginHooks` is a partial `NeemHostHookMap`; callbacks may return promises:

- `initialize`, `dispose`;
- `server:start`, `server:ready`, `server:reload`, `server:stop`, `server:fail`;
- `runtime:start`, `runtime:ready`, `runtime:reload`, `runtime:stop`,
  `runtime:fail`;
- `worker:start`, `worker:ready`, `worker:stop`, `worker:fail`.

Every event has `{ mode, error? }`. Runtime events add `name` and optional
`upstreams`; worker events add `id`, `name`, `artifactId`, and `owner`.
These are `NeemHostHookEvent`, `NeemHostRuntimeHookEvent`, and
`NeemHostWorkerHookEvent`. `NeemHostHooks` is the typed Hookable container.
Hooks are awaited serially in registration order; exceptions can fail the
lifecycle operation. Use `initialize`/`dispose` for plugin-owned resources;
failed initialize triggers dispose cleanup and hook removal.
