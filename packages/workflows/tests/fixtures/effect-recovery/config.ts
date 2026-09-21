import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
import { threadId } from 'node:worker_threads'

import { defineTask, implementTask } from '@nmtjs/workflows/effect'
import { defineWorkflows } from '@nmtjs/workflows/neem'
import {
  createPostgresWorkflowConnection,
  createPostgresWorkflowRuntime,
} from '@nmtjs/workflows/postgres'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import pg from 'pg'

const eventsFile = process.env.WORKFLOW_EVENTS_FILE!
const markerFile = process.env.WORKFLOW_FAILURE_FILE!
const first = !existsSync(markerFile)
const record = (event: string) =>
  appendFileSync(eventsFile, JSON.stringify({ event, threadId }) + '\n')
const resource = Context.Service<{ record: typeof record }>('recovery-resource')
const layer = Layer.effect(
  resource,
  Effect.acquireRelease(
    Effect.sync(() => {
      record('acquire')
      return { record }
    }),
    () => Effect.sync(() => record('release')),
  ),
)

export const timed = defineTask({
  name: 'effect-recovery.timed',
  input: Schema.Number,
  output: Schema.Number,
  timeout: '300ms',
  retry: { attempts: 3 },
})
export const sibling = defineTask({
  name: 'effect-recovery.sibling',
  input: Schema.Number,
  output: Schema.Number,
  retry: { attempts: 3 },
})
const tasks = [timed, sibling].map((task) =>
  implementTask(task, {
    handler: (input) =>
      Effect.gen(function* () {
        const service = yield* resource
        if (first) {
          writeFileSync(markerFile, 'failed')
          service.record(task === timed ? 'timed-started' : 'sibling-started')
          // Model a finalizer/uninterruptible operation that cannot be drained.
          return yield* Effect.uninterruptible(Effect.never)
        }
        service.record('replacement-completed')
        return input + 1
      }),
  }),
)

export const config = defineWorkflows({
  layer,
  runtime: Effect.gen(function* () {
    const pool = yield* Effect.acquireRelease(
      Effect.sync(
        () => new pg.Pool({ connectionString: process.env.POSTGRES_URL }),
      ),
      (pool) => Effect.promise(() => pool.end()),
    )
    return createPostgresWorkflowRuntime({
      connection: createPostgresWorkflowConnection(pool),
    })
  }),
  workflows: () => [],
  tasks: () => tasks,
  workers: {
    coordinator: { leaseMs: 600, pollIntervalMs: 10 },
    execution: {
      concurrency: 2,
      leaseMs: 600,
      pollIntervalMs: 10,
      cleanupTimeoutMs: 50,
    },
  },
})
