import type { AnyTask, ServedWorkflow } from '@nmtjs/workflows'
import * as NodeRuntime from '@effect/platform-node/NodeRuntime'
import { Worker } from '@nmtjs/workflows'
import * as Effect from 'effect/Effect'

import type { StoreSpec } from './store.ts'
import {
  EverySecond,
  generation,
  Host,
  Order,
  Pack,
  revisionPools,
  Stamp,
  Tick,
} from './app.ts'
import { storeLayer } from './store.ts'

/**
 * A worker process of the integration tests: the workers `WORKFLOWS_WORKER` asks
 * for, over the store it names, until the process is told to stop or is
 * killed. `SIGTERM` interrupts the workers, which is the engine's clean stop.
 */

type Sweep = { readonly everyMs?: number; readonly batchSize?: number }

export type WorkerConfig = {
  readonly store: StoreSpec
  /**
   * What the process has code for: `order`, `tick`, a revision of the
   * family (`v1`, `v2`), or one edited in place (`v1:reshaped`).
   */
  readonly served: readonly string[]
  /** A coordinator with these options, unless `false`. */
  readonly coordinator?:
    | false
    | {
        readonly concurrency?: number
        readonly leaseMs?: number
        readonly pollMs?: number
        readonly reaping?: false | Sweep
        readonly scheduling?: Sweep
        /** Whether it is given the schedule of the fixture. */
        readonly schedules?: boolean
      }
  /** One execution worker for each entry: of its pool, or of every pool. */
  readonly execution?: readonly {
    readonly pool?: string
    readonly concurrency?: number
    readonly leaseMs?: number
    readonly pollMs?: number
    readonly cleanupTimeoutMs?: number
  }[]
}

const config: WorkerConfig = JSON.parse(process.env.WORKFLOWS_WORKER!)

type Served = {
  readonly workflows: readonly ServedWorkflow[]
  readonly tasks: readonly AnyTask[]
}

const sets = config.served.map((name): Served => {
  if (name === 'order') return { workflows: [Order, Pack], tasks: [Stamp] }
  if (name === 'tick') return { workflows: [Tick], tasks: [] }
  const [revision, shape] = name.split(':') as [string, string | undefined]
  return generation(revision, revisionPools[revision]!, {
    reshaped: shape === 'reshaped',
  })
})
const served = {
  workflows: sets.flatMap(({ workflows }) => workflows),
  tasks: sets.flatMap(({ tasks }) => tasks),
}

const { schedules, ...coordinator } = config.coordinator || {}
const workers = [
  ...(config.coordinator === false
    ? []
    : [
        Worker.coordinator({
          ...coordinator,
          workflows: served.workflows,
          ...(schedules ? { schedules: [EverySecond] } : {}),
        }),
      ]),
  ...(config.execution ?? []).map((options) =>
    Worker.execution({ ...options, ...served }).pipe(
      Effect.provideService(Host, { pool: options.pool ?? 'any' }),
    ),
  ),
]

NodeRuntime.runMain(
  Effect.sync(() => process.stdout.write('WORKFLOWS_READY\n')).pipe(
    Effect.andThen(
      Effect.all(workers, { concurrency: 'unbounded', discard: true }),
    ),
    Effect.provide(storeLayer(config.store)),
    // The sets are chosen at run time, so the types cannot tell that `Host`
    // is all their handlers require.
  ) as Effect.Effect<void, unknown>,
)
