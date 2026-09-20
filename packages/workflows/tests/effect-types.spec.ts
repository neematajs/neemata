import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import { expect, expectTypeOf, it } from 'vitest'

import {
  defineTask,
  defineWorkflow,
  implementTask,
  implementWorkflow,
} from '../src/index.ts'
import { defineWorkflows, defineWorkflowsWorker } from '../src/neem/index.ts'
import { createInMemoryWorkflowRuntime } from '../src/runtime/index.ts'

class Service extends Context.Service<Service, { value: number }>()(
  'test/Service',
) {}
class Missing extends Context.Service<Missing, string>()('test/Missing') {}
const layer = Layer.succeed(Service, { value: 1 })
const runtime = Effect.sync(createInMemoryWorkflowRuntime)
const task = defineTask({
  name: 'typed',
  input: Schema.NumberFromString,
  output: Schema.NumberFromString,
})
const workflow = defineWorkflow({
  name: 'typed',
  input: Schema.NumberFromString,
  output: Schema.NumberFromString,
}).build()
const implementation = implementTask(task, {
  handler: (input) =>
    Effect.gen(function* () {
      const service = yield* Service
      return input + service.value
    }),
})

it('requires the worker Layer to provide task and finish services', () => {
  const finish = implementWorkflow(workflow).finish(() =>
    Service.pipe(Effect.map(({ value }) => value)),
  )
  const config = defineWorkflows({
    layer,
    runtime,
    workflows: () => [finish],
    tasks: () => [implementation],
  })
  expect(defineWorkflowsWorker(config)).toBeDefined()

  // @ts-expect-error No Layer supplies the task service.
  defineWorkflows({
    runtime,
    workflows: () => [],
    tasks: () => [implementation],
  })
  // @ts-expect-error No Layer supplies the finish service.
  defineWorkflowsWorker({ runtime, workflows: () => [finish] })
  defineWorkflows({
    runtime,
    workflows: () => [finish],
    // @ts-expect-error The empty Layer cannot provide Service.
    layer: Layer.empty,
  })
  defineWorkflows({
    runtime,
    workflows: () => [],
    // @ts-expect-error Worker Layers cannot require services outside the worker.
    layer: Layer.effectDiscard(Missing),
  })
})

it('retains services from direct, branch and parallel activities', () => {
  const io = { input: Schema.Number, output: Schema.Number }
  const declared = defineWorkflow({ name: 'cases', ...io })
    .activity('direct', io)
    .branch('branch', {
      cases: (cases) => ({ a: cases.activity(io) }),
      output: Schema.Number,
    })
    .parallel('parallel', (cases) => ({ a: cases.activity(io) }))
    .build()
  const direct = implementWorkflow(declared)
    .direct(() => Service.pipe(Effect.map(({ value }) => value)))
    .branch({
      select: () => 'a',
      cases: ({ activity }) => ({ a: activity(() => Effect.succeed(1)) }),
    })
    .parallel({ a: () => Effect.succeed(1) })
    .finish(() => Effect.succeed(1))
  const branch = implementWorkflow(declared)
    .direct(() => Effect.succeed(1))
    .branch({
      select: () => 'a',
      cases: ({ activity }) => ({
        a: activity(() => Service.pipe(Effect.map(({ value }) => value))),
      }),
    })
    .parallel({ a: () => Effect.succeed(1) })
    .finish(() => Effect.succeed(1))
  const parallel = implementWorkflow(declared)
    .direct(() => Effect.succeed(1))
    .branch({
      select: () => 'a',
      cases: ({ activity }) => ({ a: activity(() => Effect.succeed(1)) }),
    })
    .parallel({ a: () => Service.pipe(Effect.map(({ value }) => value)) })
    .finish(() => Effect.succeed(1))
  expectTypeOf<
    Effect.Services<ReturnType<typeof direct.finish>>
  >().toEqualTypeOf<Service>()
  expectTypeOf<
    Effect.Services<ReturnType<typeof branch.finish>>
  >().toEqualTypeOf<Service>()
  expectTypeOf<
    Effect.Services<ReturnType<typeof parallel.finish>>
  >().toEqualTypeOf<Service>()
  // @ts-expect-error Direct activity requirements reach the worker boundary.
  defineWorkflows({ runtime, workflows: () => [direct] })
  // @ts-expect-error Branch activity requirements reach the worker boundary.
  defineWorkflows({ runtime, workflows: () => [branch] })
  // @ts-expect-error Parallel activity requirements reach the worker boundary.
  defineWorkflows({ runtime, workflows: () => [parallel] })
  expect(
    defineWorkflows({
      layer,
      runtime,
      workflows: () => [direct, branch, parallel],
    }),
  ).toBeDefined()
})

it('supports scoped handlers and adapter factories with services', () => {
  const scoped = implementTask(task, {
    handler: () => Effect.acquireRelease(Effect.succeed(1), () => Effect.void),
  })
  expect(
    defineWorkflows({ runtime, workflows: () => [], tasks: () => [scoped] }),
  ).toBeDefined()
  const factory = Service.pipe(Effect.andThen(runtime))
  expect(
    defineWorkflowsWorker({ layer, runtime: factory, workflows: () => [] }),
  ).toBeDefined()
  // @ts-expect-error Adapter factories also require their Layer services.
  defineWorkflows({ runtime: factory, workflows: () => [] })
})

it('accepts decoded values and Effect handlers without an async compatibility API', () => {
  implementTask(task, {
    handler: (input) => {
      expectTypeOf(input).toEqualTypeOf<number>()
      return Effect.succeed(input)
    },
  })
  implementTask(task, {
    // @ts-expect-error Handlers return decoded Type, not authored Encoded.
    handler: () => Effect.succeed('1'),
  })
  implementTask(task, {
    // @ts-expect-error Only native Effects cross the execution boundary.
    handler: async () => 1,
  })
})
