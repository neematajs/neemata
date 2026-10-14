import type { AnyTask, ServedWorkflow } from '@nmtjs/workflows'
import { defineWorkflowsWorker } from '@nmtjs/workflows/neem/worker'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'

import type { StoreSpec } from '../store.ts'
import {
  generation,
  Host,
  Order,
  Pack,
  record,
  recovery,
  revisionPools,
  Stamp,
} from '../app.ts'
import { storeLayer } from '../store.ts'

/**
 * What a deployment serves is chosen when it starts: `order`, `recovery`,
 * or revisions of the family (`v1`, `v2`), so one build serves them all.
 */
const sets = process.env
  .WORKFLOWS_DEPLOYED!.split(',')
  .map(
    (
      name,
    ): { workflows: readonly ServedWorkflow[]; tasks: readonly AnyTask[] } => {
      if (name === 'order') return { workflows: [Order, Pack], tasks: [Stamp] }
      if (name === 'recovery') return { workflows: [], tasks: recovery }
      return generation(name, revisionPools[name]!)
    },
  )
const spec: StoreSpec = JSON.parse(process.env.WORKFLOWS_STORE!)

export default defineWorkflowsWorker({
  workflows: sets.flatMap(({ workflows }) => workflows),
  tasks: sets.flatMap(({ tasks }) => tasks),
  store: () => storeLayer(spec),
  // Every thread that runs handlers records the life of its services, and
  // tells its handlers which pool it is.
  layer: ({ data }) =>
    Layer.merge(
      Layer.succeed(Host, {
        pool: data.role === 'execution' ? data.pool : data.role,
      }),
      Layer.effectDiscard(
        Effect.acquireRelease(record('acquire'), () => record('release')),
      ),
    ),
})
