import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Schema from 'effect/Schema'
import { expect, it } from 'vitest'

import {
  defineWorkflow,
  implementWorkflow,
  runWorkflowWorker,
} from '../src/effect/index.ts'
import {
  createInMemoryWorkflowRuntime,
  createWorkflowRuntimeClient,
} from '../src/runtime/index.ts'

const workflow = defineWorkflow({
  name: 'effect-finish',
  input: Schema.NumberFromString,
  output: Schema.NumberFromString,
}).build()

it('interrupts finish on shutdown without failing the durable run', async () => {
  const started = Promise.withResolvers<void>()
  let finalized = false
  const implementation = implementWorkflow(workflow, { pool: 'test' }).finish(
    () =>
      Effect.sync(started.resolve).pipe(
        Effect.andThen(Effect.never),
        Effect.ensuring(
          Effect.sync(() => {
            finalized = true
          }),
        ),
      ),
  )
  const runtime = createInMemoryWorkflowRuntime()
  const client = createWorkflowRuntimeClient(runtime)
  const run = await client.start(workflow, 1)
  const running = Effect.runFork(
    runWorkflowWorker({
      ...runtime,
      workflows: [implementation],
      workerId: 'stop',
    }),
  )
  await started.promise
  await Effect.runPromise(Fiber.interrupt(running))
  expect(finalized).toBe(true)
  expect((await client.get(run.id))?.run).toMatchObject({
    status: 'running',
    input: '1',
  })
  expect((await client.get(run.id))?.run.output).toBeUndefined()
  const resumed = implementWorkflow(workflow, { pool: 'test' }).finish(
    (_outputs, input) => Effect.succeed(input + 1),
  )
  // Released coordination commands retain the engine's normal backoff.
  await expect
    .poll(async () => {
      await Effect.runPromise(
        runWorkflowWorker({
          ...runtime,
          workflows: [resumed],
          workerId: 'resume',
        }),
      )
      return (await client.get(run.id))?.run
    })
    .toMatchObject({ status: 'completed', output: '2' })
})

it('observes cancellation while finish is running', async () => {
  const started = Promise.withResolvers<void>()
  let finalized = false
  const implementation = implementWorkflow(workflow, { pool: 'test' }).finish(
    () =>
      Effect.sync(started.resolve).pipe(
        Effect.andThen(Effect.never),
        Effect.ensuring(
          Effect.sync(() => {
            finalized = true
          }),
        ),
      ),
  )
  const runtime = createInMemoryWorkflowRuntime()
  const client = createWorkflowRuntimeClient(runtime)
  const run = await client.start(workflow, 1)
  const running = Effect.runPromise(
    runWorkflowWorker({
      ...runtime,
      workflows: [implementation],
      workerId: 'cancel',
      leaseMs: 30,
    }),
  )
  await started.promise
  await client.cancel(run.id)
  await running
  expect(finalized).toBe(true)
  expect((await client.get(run.id))?.run.status).toBe('cancelled')
  expect((await client.get(run.id))?.run.output).toBeUndefined()
})
