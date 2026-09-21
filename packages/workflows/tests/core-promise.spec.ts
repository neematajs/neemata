import { describe, expect, expectTypeOf, it } from 'vitest'
import * as z from 'zod'

import type { Env } from '../src/index.ts'
import {
  defineTask,
  defineWorkflow,
  implementTask,
  implementWorkflow,
  toStoredJsonSchema,
} from '../src/index.ts'
import {
  createHandlerRunner,
  createInMemoryWorkflowRuntime,
  createWorkflowRuntimeClient,
  runExecutionWorker,
  runWorkflowWorker,
  WorkflowCleanupTimeoutError,
} from '../src/runtime/index.ts'

// The core runs without Effect: any Standard Schema library, Promise handlers
// and an env. A single schema serves values that are stored as they are; a
// transformed value declares both directions.
const date = {
  decode: z.iso.datetime().transform((stored) => new Date(stored)),
  encode: z.date().transform((value) => value.toISOString()),
}
const dates = { decode: z.array(date.decode), encode: z.array(date.encode) }

type Clock = { readonly clock: { readonly shift: (value: Date) => Date } }
type Log = { readonly log: string[] }

const shiftTask = defineTask({ name: 'core.shift', input: date, output: date })
const shift = implementTask(shiftTask, {
  handler: (input, _lifecycle, env: Clock) => env.clock.shift(input),
})

const workflow = defineWorkflow({
  name: 'core.dates',
  input: date,
  output: dates,
})
  .activity('first', { input: date, output: date })
  .parallel('pair', (h) => ({
    shifted: h.task(shiftTask),
    same: h.activity({ input: date, output: date }),
  }))
  .mapTask('each', shiftTask, { item: date })
  .build()

const implementation = implementWorkflow(workflow)
  .first(async (input, _lifecycle, env: Log) => {
    env.log.push('first')
    return input
  })
  .pair(({ task, activity }) => ({
    shifted: task(shiftTask, { input: ({ first }) => first }),
    same: activity((input) => input, { input: ({ first }) => first }),
  }))
  .each(shiftTask, {
    items: ({ pair }) => [pair.shifted, pair.same],
    input: (_outputs, item) => item,
  })
  .finish(({ each }, _input, _lifecycle, env: Log) => {
    env.log.push('finish')
    return each.items.map(({ output }) => output)
  })

describe('workflows core without Effect', () => {
  it('requires every handler env at once from the worker', () => {
    expectTypeOf<Env<typeof shift>>().toEqualTypeOf<Clock>()
    expectTypeOf<Env<typeof implementation>>().toEqualTypeOf<Log>()
    expectTypeOf<Env<typeof shift | typeof implementation>>().toEqualTypeOf<
      Clock & Log
    >()
    const worker = {
      ...createInMemoryWorkflowRuntime(),
      workflows: [implementation],
      tasks: [shift],
      workerId: 'typed',
    }
    const clock = { shift: (value: Date) => value }
    // Thunks: only the call's types matter, the worker must not run.
    void (() => runExecutionWorker({ ...worker, env: { clock, log: [] } }))
    // @ts-expect-error The task handler's clock is missing.
    void (() => runExecutionWorker({ ...worker, env: { log: [] } }))
    // @ts-expect-error Handlers that use an env need one.
    void (() => runExecutionWorker(worker))
    void (() =>
      runExecutionWorker({
        ...worker,
        workflows: [],
        tasks: [],
        env: undefined,
      }))
  })

  it('runs activities, parallel members and map items through codecs', async () => {
    const runtime = createInMemoryWorkflowRuntime()
    const client = createWorkflowRuntimeClient(runtime)
    const log: string[] = []
    const env = {
      log,
      clock: { shift: (value: Date) => new Date(value.getTime() + 1_000) },
    }
    const workers = {
      ...runtime,
      env,
      workflows: [implementation],
      tasks: [shift],
      workerId: 'core',
    }
    const run = await client.start(workflow, new Date('2026-01-01T00:00:00Z'))
    for (let round = 0; round < 10; round++) {
      await runWorkflowWorker(workers)
      await runExecutionWorker(workers)
    }

    const snapshot = (await client.get(run.id))!
    expect(snapshot.run.status).toBe('completed')
    // Stores hold the encoded form; every re-entry decoded it for the handlers.
    expect(snapshot.run.output).toEqual([
      '2026-01-01T00:00:02.000Z',
      '2026-01-01T00:00:01.000Z',
    ])
    expect(log).toEqual(['first', 'finish'])
  })

  it('accepts a single schema only for values stored as they are', async () => {
    const greeting = z.object({ name: z.string().min(1) })
    const greet = defineTask({
      name: 'core.greet',
      input: greeting,
      output: z.string(),
    })
    const runtime = createInMemoryWorkflowRuntime()
    const client = createWorkflowRuntimeClient(runtime)
    const workers = {
      ...runtime,
      workflows: [],
      tasks: [
        implementTask(greet, { handler: ({ name }) => `Hello, ${name}` }),
      ],
      workerId: 'core',
    }

    await expect(client.start(greet, { name: '' })).rejects.toThrow(
      'Invalid task input [core.greet]',
    )
    const run = await client.start(greet, { name: 'Ada' })
    await runExecutionWorker(workers)
    expect((await client.get(run.id))?.run.output).toBe('Hello, Ada')

    void (() =>
      defineTask({
        name: 'core.transformed',
        // Its Date output cannot be validated as its string input again.
        // @ts-expect-error A transforming schema must declare both directions.
        input: date.decode,
        output: z.string(),
      }))
  })

  it('exposes the stored JSON Schema of a definition', () => {
    const task = defineTask({
      name: 'core.described',
      input: z.object({ at: z.string() }),
      output: date,
    })
    expect(toStoredJsonSchema(task.input)).toMatchObject({
      type: 'object',
      properties: { at: { type: 'string' } },
    })
    expect(toStoredJsonSchema(task.output)).toMatchObject({ type: 'string' })
  })

  it('reports a handler that keeps running after its attempt was aborted', async () => {
    const fatal = Promise.withResolvers<unknown>()
    const release = Promise.withResolvers<void>()
    const handlers = createHandlerRunner({
      cleanupTimeoutMs: 10,
      onFatal: fatal.resolve,
    })
    const abort = new AbortController()
    const running = handlers.run(() => release.promise, abort.signal)
    abort.abort(new Error('lease lost'))

    await expect(running).rejects.toBeInstanceOf(WorkflowCleanupTimeoutError)
    expect(await fatal.promise).toBeInstanceOf(WorkflowCleanupTimeoutError)
    let drained = false
    const drain = handlers.drain().then(() => (drained = true))
    await Promise.resolve()
    expect(drained).toBe(false)
    release.resolve()
    await drain
  })

  it('bounds cleanup when a handler aborts its own attempt synchronously', async () => {
    const fatal = Promise.withResolvers<unknown>()
    const handlers = createHandlerRunner({
      cleanupTimeoutMs: 5,
      onFatal: fatal.resolve,
    })
    const abort = new AbortController()
    const running = handlers.run(() => {
      // Such as a service that stops the worker from inside the handler.
      abort.abort(new Error('stopped'))
      return new Promise<never>(() => {})
    }, abort.signal)

    await expect(running).rejects.toBeInstanceOf(WorkflowCleanupTimeoutError)
    expect(await fatal.promise).toBeInstanceOf(WorkflowCleanupTimeoutError)
  })
})
