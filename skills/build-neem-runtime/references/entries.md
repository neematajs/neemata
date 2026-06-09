# Runtime Entries

Runtime entry files are marked exports. Neem validates each marker before using
the entry. Runtime declarations and package helpers should reference these files
by import specifier; the files themselves default-export marked values.

```ts
import {
  defineRuntimeHost,
  defineRuntimePlanner,
  defineRuntimeWorker,
} from '@nmtjs/neem'
```

## Worker Entry

```ts
import { defineRuntimeWorker } from '@nmtjs/neem'

export default defineRuntimeWorker({
  definition: { kind: 'custom' },
  async createRuntime(ctx) {
    ctx.port.on('message', (message) => {
      ctx.logger.info({ message }, 'host message')
    })

    return {
      async start() {
        ctx.logger.info({ runtime: ctx.name }, 'started')
        ctx.port.postMessage({ type: 'ready', worker: ctx.name })
        return []
      },
      async stop() {
        ctx.logger.info({ runtime: ctx.name }, 'stopped')
        ctx.port.close()
      },
    }
  },
})
```

`ctx` contains `mode`, runtime `name`, planner `data`, runtime `definition`,
`logger`, and `port`.

`ctx.port` is the worker side of the runtime-specific `MessageChannel`. Use it
for custom host/worker coordination. Neem's internal `parentPort` is reserved
for lifecycle control and is not the public runtime protocol.

## Planner Entry

```ts
import { defineRuntimePlanner } from '@nmtjs/neem'

export default defineRuntimePlanner(() => ({
  workers: [{ shard: 0 }, { shard: 1 }],
  options: { gracefulShutdownMs: 5000 },
}))
```

Use the planner for deploy-time layout: worker data, grouped workers, host
options, and package definitions. `workers` can be an array or a record of
arrays; each item becomes one worker thread and must be structured-cloneable.

`NeemRuntimePlanner<Options, Data>` type parameters define the runtime boundary:

- `Data` becomes worker `ctx.data`.
- `Options` becomes host `params.options`.
- If the runtime has no host options, omit `options` and use `undefined` for
  `Options`.
- If the runtime has host options, return `options` and make
  `defineRuntimeHost<Options>(...)` match exactly. The options shape is
  runtime/package-owned.
- Prefer a named `NeemRuntimePlanner<Options, Data>` type alias and
  `defineRuntimePlanner<Options, Data>(...)` over annotating callback returns.

## Host Entry

```ts
import { defineRuntimeHost } from '@nmtjs/neem'

export default defineRuntimeHost(({ name, logger, threads, options }) => {
  return {
    async start() {
      for (const thread of threads) {
        thread.port.on('message', (message) => {
          logger.info({ worker: thread.name, message }, 'worker message')
        })

        thread.port.postMessage({ type: 'configure', options })
      }

      logger.info({ name, threads: threads.length, options }, 'host started')
    },
    async stop() {
      for (const thread of threads) thread.port.close()
      logger.info({ name }, 'host stopped')
    },
  }
})
```

Use a host when runtime needs host-side coordination, thread management, shared
services, upstream planning, or a host-only process.

Host receives `threads`, not a single top-level `port`. Each thread handle is
`{ name, port }`, where `port` is the host side of that worker's
`MessageChannel`. Host-only runtimes receive an empty `threads` array.

## Import Rules

- Do not import worker entry modules from host or planner entry modules.
- Do not import host entry modules from worker entry modules.
- Do not import planner entry modules from runtime declaration files.
- Share pure types/helpers through separate modules when needed.
- Keep side-effectful runtime clients, sockets, transports, and schedulers
  inside the entry that owns their lifecycle.

This split is required because Neem builds and runs entries in different
process/thread contexts: planner and host in the host-runner worker, workers in
runtime worker threads. Importing across entries breaks that isolation and
couples bundle graphs that Neem expects to manage separately.

## Lifecycle Rules

- Worker entry runs worker-side runtime logic.
- Planner entry runs in the host runner and returns `workers` plus optional
  host `options`.
- Host entry runs after workers start and receives worker `MessagePort`s.
- Worker `ctx.port` and host `thread.port` are peers. Define the message
  protocol in package/runtime code; Neem only owns lifecycle.
- Host shutdown should be explicit; worker termination is fallback after
  timeout.
- Keep entry exports marked with the proper helper. Plain objects/functions fail
  validation.
