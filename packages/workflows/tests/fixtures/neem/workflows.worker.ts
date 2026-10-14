import { appendFileSync } from 'node:fs'
import { threadId } from 'node:worker_threads'

import { Client } from '@nmtjs/workflows'
import { defineWorkflowsWorker } from '@nmtjs/workflows/neem/worker'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'

import { Greeter, Greeting, Orphaned, Shout, Unplanned } from './app.ts'
import { store } from './store.ts'

const generation = 'generation-1'
// Chosen when the worker starts, so one build serves every registry; without
// a choice the registry is valid.
const invalid = process.env.WORKFLOWS_REGISTRY

const record = (event: string, fields: Record<string, unknown>) =>
  appendFileSync(
    process.env.WORKFLOWS_EVENTS_FILE!,
    `${JSON.stringify({ event, generation, thread: threadId, ...fields })}\n`,
  )

// Application code reaches runs through the store its worker was given. A
// thread's own store is all the test of the in-memory store has: the thread
// starts a run of what it serves and reports how that run ended.
const selfStarted = (name: string) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const { id } = yield* Client.start(Shout, 'hello')
      yield* Effect.forkScoped(
        Effect.gen(function* () {
          for (;;) {
            const records = yield* Client.get(id)
            if (records?.run.status === 'completed') {
              return record('completed', { name, output: records.run.output })
            }
            yield* Effect.sleep('20 millis')
          }
        }),
      )
    }),
  )

export default defineWorkflowsWorker({
  workflows: [Greeting, ...(invalid === 'incomplete' ? [Orphaned] : [])],
  tasks: [Shout, ...(invalid === 'undeclared-pool' ? [Unplanned] : [])],
  // Every thread records the life of its store, the coordinators' too.
  store: ({ name, data }) =>
    Layer.merge(
      store,
      Layer.effectDiscard(
        Effect.acquireRelease(
          Effect.sync(() => record('acquired', { name, role: data.role })),
          () => Effect.sync(() => record('released', { name })),
        ),
      ),
    ),
  layer: ({ name, data }) =>
    Layer.merge(
      Layer.succeed(Greeter, {
        greet: (name) => Effect.succeed(`Hello, ${name}`),
      }),
      process.env.WORKFLOWS_SELF_START &&
        data.role === 'execution' &&
        data.pool === Shout.pool
        ? selfStarted(name)
        : Layer.empty,
    ),
})
