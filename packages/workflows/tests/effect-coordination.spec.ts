import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import { expect, it } from 'vitest'

import { defineWorkflow, implementWorkflow } from '../src/index.ts'
import {
  createInMemoryWorkflowRuntime,
  createWorkflowRuntimeClient,
  runWorkflowWorker,
} from '../src/runtime/index.ts'

const workflow = defineWorkflow({
  name: 'effect-finish',
  input: Schema.NumberFromString,
  output: Schema.NumberFromString,
}).build()

it('interrupts finish on shutdown without failing the durable run', async () => {
  const started = Promise.withResolvers<void>()
  const stop = new AbortController()
  let finalized = false
  const implementation = implementWorkflow(workflow).finish(() =>
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
  const running = runWorkflowWorker({
    ...runtime,
    context: Context.empty(),
    workflows: [implementation],
    workerId: 'stop',
    signal: stop.signal,
  })
  await started.promise
  stop.abort()
  await running
  expect(finalized).toBe(true)
  expect((await client.get(run.id))?.run).toMatchObject({
    status: 'running',
    input: '1',
  })
  expect((await client.get(run.id))?.run.output).toBeUndefined()
  const resumed = implementWorkflow(workflow).finish((_outputs, input) =>
    Effect.succeed(input + 1),
  )
  // Released coordination commands retain the engine's normal backoff.
  await expect
    .poll(async () => {
      await runWorkflowWorker({
        ...runtime,
        context: Context.empty(),
        workflows: [resumed],
        workerId: 'resume',
      })
      return (await client.get(run.id))?.run
    })
    .toMatchObject({ status: 'completed', output: '2' })
})

it('observes cancellation while finish is running', async () => {
  const started = Promise.withResolvers<void>()
  let finalized = false
  const implementation = implementWorkflow(workflow).finish(() =>
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
  const running = runWorkflowWorker({
    ...runtime,
    context: Context.empty(),
    workflows: [implementation],
    workerId: 'cancel',
    leaseMs: 30,
  })
  await started.promise
  await client.cancel(run.id)
  await running
  expect(finalized).toBe(true)
  expect((await client.get(run.id))?.run.status).toBe('cancelled')
  expect((await client.get(run.id))?.run.output).toBeUndefined()
})
