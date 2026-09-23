import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import { expect, expectTypeOf, it } from 'vitest'

import {
  createHandlerRuntime,
  defineTask,
  defineWorkflow,
  implementTask,
  implementWorkflow,
  runExecutionWorker,
  type Requirements,
} from '../src/effect/index.ts'
import { defineWorkflowsWorker } from '../src/effect/neem.ts'
import { defineWorkflows } from '../src/neem/index.ts'
import {
  createHandlerRunner,
  createInMemoryWorkflowRuntime,
  runExecutionWorker as runStoredExecutionWorker,
} from '../src/runtime/index.ts'

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
    workflows: () => [finish],
    tasks: () => [implementation],
  })
  expect(defineWorkflowsWorker(config, { layer, runtime })).toBeDefined()

  // The config holds no services, so it needs none to be declared.
  const tasksOnly = defineWorkflows({
    workflows: () => [],
    tasks: () => [implementation],
  })
  const finishOnly = defineWorkflows({ workflows: () => [finish] })
  // @ts-expect-error No Layer supplies the task service.
  defineWorkflowsWorker(tasksOnly, { runtime })
  // @ts-expect-error No Layer supplies the finish service.
  defineWorkflowsWorker(finishOnly, { runtime })
  defineWorkflowsWorker(finishOnly, {
    runtime,
    // @ts-expect-error The empty Layer cannot provide Service.
    layer: Layer.empty,
  })
  defineWorkflowsWorker(defineWorkflows({ workflows: () => [] }), {
    runtime,
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
  expectTypeOf<Requirements<typeof direct>>().toEqualTypeOf<Service>()
  expectTypeOf<Requirements<typeof branch>>().toEqualTypeOf<Service>()
  expectTypeOf<Requirements<typeof parallel>>().toEqualTypeOf<Service>()
  // @ts-expect-error Direct activity requirements reach the worker boundary.
  defineWorkflowsWorker(defineWorkflows({ workflows: () => [direct] }), {
    runtime,
  })
  // @ts-expect-error Branch activity requirements reach the worker boundary.
  defineWorkflowsWorker(defineWorkflows({ workflows: () => [branch] }), {
    runtime,
  })
  // @ts-expect-error Parallel activity requirements reach the worker boundary.
  defineWorkflowsWorker(defineWorkflows({ workflows: () => [parallel] }), {
    runtime,
  })
  expect(
    defineWorkflowsWorker(
      defineWorkflows({ workflows: () => [direct, branch, parallel] }),
      { layer, runtime },
    ),
  ).toBeDefined()
})

it('requires a standalone worker context to cover its handlers', () => {
  const worker = {
    ...createInMemoryWorkflowRuntime(),
    workflows: [],
    tasks: [implementation],
    workerId: 'typed',
  }
  const context = Context.make(Service, { value: 1 })
  // Thunks: only the call's types matter, the worker must not run.
  void (() => runExecutionWorker({ ...worker, context }))
  // A supervisor that drains handlers itself passes the runtime as their env.
  const handlers = createHandlerRunner()
  void (() =>
    runStoredExecutionWorker({
      ...worker,
      handlers,
      env: createHandlerRuntime(context),
    }))
  // Built separately, so the call cannot influence what the runtime provides.
  const insufficient = createHandlerRuntime(Context.empty())
  void (() =>
    runStoredExecutionWorker({
      ...worker,
      handlers,
      // @ts-expect-error A runtime built from the empty context cannot either.
      env: insufficient,
    }))
  // @ts-expect-error Handlers that require services need an env.
  void (() => runStoredExecutionWorker({ ...worker, handlers }))
  // @ts-expect-error The empty context cannot provide Service.
  void (() => runExecutionWorker({ ...worker, context: Context.empty() }))
})

it('supports scoped handlers and adapter factories with services', () => {
  const scoped = implementTask(task, {
    handler: () => Effect.acquireRelease(Effect.succeed(1), () => Effect.void),
  })
  const scopedOnly = defineWorkflows({
    workflows: () => [],
    tasks: () => [scoped],
  })
  // Scope comes from the worker, not from the Layer.
  expect(defineWorkflowsWorker(scopedOnly, { runtime })).toBeDefined()
  const factory = Service.pipe(Effect.andThen(runtime))
  const empty = defineWorkflows({ workflows: () => [] })
  expect(
    defineWorkflowsWorker(empty, { layer, runtime: factory }),
  ).toBeDefined()
  // @ts-expect-error Adapter factories also require their Layer services.
  defineWorkflowsWorker(empty, { runtime: factory })
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
