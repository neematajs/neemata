import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Schema from 'effect/Schema'
import * as Stream from 'effect/Stream'
import { describe, expect, it } from 'vitest'

import type { WorkflowRuntimeAdapter } from '../src/runtime/index.ts'
import {
  defineTask,
  implementTask,
  runExecutionWorker,
  WorkflowClient,
} from '../src/effect/index.ts'
import {
  createInMemoryWorkflowRuntime,
  createWorkflowRuntimeClient,
  WorkflowRunConflictError,
} from '../src/runtime/index.ts'

const task = defineTask({
  name: 'effect-client.task',
  input: Schema.NumberFromString,
  output: Schema.NumberFromString,
})
const implementation = implementTask(task, {
  pool: 'test',
  handler: (input) => Effect.succeed(input * 2),
})

const run = <A, E>(
  adapter: WorkflowRuntimeAdapter,
  program: Effect.Effect<A, E, WorkflowClient>,
) =>
  Effect.runPromise(
    program.pipe(
      Effect.provide(
        WorkflowClient.layer(createWorkflowRuntimeClient(adapter)),
      ),
    ),
  )

describe('Effect workflow client', () => {
  it('starts a run and reads it back decoded through the Promise client', async () => {
    const adapter = createInMemoryWorkflowRuntime()
    const snapshot = await run(
      adapter,
      Effect.gen(function* () {
        const client = yield* WorkflowClient
        const started = yield* client.start(task, 4, {
          tags: { via: 'effect' },
        })
        expect(started).toMatchObject({ status: 'queued', input: 4 })
        return yield* client.get(started.id)
      }),
    )
    expect(snapshot?.run).toMatchObject({
      kind: 'task',
      input: '4',
      tags: { via: 'effect' },
    })
  })

  it('fails a unique conflict with a tagged error that catchTag recovers', async () => {
    const adapter = createInMemoryWorkflowRuntime()
    const holder = await run(
      adapter,
      Effect.gen(function* () {
        const client = yield* WorkflowClient
        const unique = { key: ['effect-client'] }
        const first = yield* client.start(task, 1, { unique })
        return yield* client.start(task, 2, { unique }).pipe(
          Effect.as(undefined),
          Effect.catchTag('WorkflowRunConflictError', (error) =>
            Effect.succeed({ error, firstId: first.id }),
          ),
        )
      }),
    )
    expect(holder?.error).toBeInstanceOf(WorkflowRunConflictError)
    expect(holder?.error.runId).toBe(holder?.firstId)
  })

  it('reports other rejections as defects', async () => {
    const adapter = createInMemoryWorkflowRuntime()
    const exit = await run(
      adapter,
      Effect.gen(function* () {
        const client = yield* WorkflowClient
        return yield* client.restart('missing')
      }).pipe(Effect.exit),
    )
    expect(exit._tag).toBe('Failure')
    if (exit._tag !== 'Failure') return
    expect(exit.cause.reasons.map(({ _tag }) => _tag)).toEqual(['Die'])
  })

  it('watches a run until its terminal status', async () => {
    const adapter = createInMemoryWorkflowRuntime()
    const watched = Promise.withResolvers<void>()
    const events = await run(
      adapter,
      Effect.gen(function* () {
        const client = yield* WorkflowClient
        const started = yield* client.start(task, 3)
        const watching = yield* Effect.forkChild(
          Stream.runCollect(
            client
              .watch(started.id, { pollIntervalMs: 5 })
              .pipe(Stream.tap(() => Effect.sync(() => watched.resolve()))),
          ),
        )
        // Executes only once the watch has seen the queued run.
        yield* Effect.promise(() => watched.promise)
        yield* runExecutionWorker({
          ...adapter,
          workflows: [],
          tasks: [implementation],
          workerId: 'effect-client',
        })
        return yield* Fiber.join(watching)
      }),
    )
    expect(events.at(0)).toEqual({ kind: 'run', status: 'queued' })
    expect(events.at(-1)).toEqual({ kind: 'run', status: 'completed' })
  })

  it('releases an idle watcher when its consumer is interrupted', async () => {
    const memory = createInMemoryWorkflowRuntime()
    let watchers = 0
    const adapter: WorkflowRuntimeAdapter = {
      ...memory,
      wakeEvents: {
        ...memory.wakeEvents,
        onRunEvent(rootRunId, listener) {
          watchers += 1
          const remove = memory.wakeEvents.onRunEvent!(rootRunId, listener)
          return () => {
            watchers -= 1
            remove()
          }
        },
      },
    }
    const first = Promise.withResolvers<void>()
    await run(
      adapter,
      Effect.gen(function* () {
        const client = yield* WorkflowClient
        const started = yield* client.start(task, 3)
        // No worker runs it, so the watch idles in a poll it would otherwise
        // leave only after a minute.
        const watching = yield* Effect.forkChild(
          Stream.runForEach(
            client.watch(started.id, { pollIntervalMs: 60_000 }),
            () => Effect.sync(() => first.resolve()),
          ),
        )
        yield* Effect.promise(() => first.promise)
        expect(watchers).toBe(1)
        yield* Fiber.interrupt(watching)
      }),
    )
    expect(watchers).toBe(0)
  })

  it('watches anew each time the stream runs', async () => {
    const adapter = createInMemoryWorkflowRuntime()
    const counts = await run(
      adapter,
      Effect.gen(function* () {
        const client = yield* WorkflowClient
        const started = yield* client.start(task, 3)
        yield* runExecutionWorker({
          ...adapter,
          workflows: [],
          tasks: [implementation],
          workerId: 'effect-client',
        })
        const watch = client.watch(started.id)
        const first = yield* Stream.runCollect(watch)
        const second = yield* Stream.runCollect(watch)
        return [first, second]
      }),
    )
    expect(counts).toEqual([
      [{ kind: 'run', status: 'completed' }],
      [{ kind: 'run', status: 'completed' }],
    ])
  })
})
