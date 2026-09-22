import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import { describe, expect, expectTypeOf, it } from 'vitest'
import * as z from 'zod'

import {
  createHandlerRuntime,
  defineTask,
  defineWorkflow,
  implementTask,
  implementWorkflow,
  runExecutionWorker,
  runWorkflowWorker,
  type HandlerRuntime,
  type Requirements,
} from '../src/effect/index.ts'
import { defineWorkflowsWorker } from '../src/effect/neem.ts'
import {
  defineTask as defineCoreTask,
  defineWorkflow as defineCoreWorkflow,
  implementTask as implementCoreTask,
  implementWorkflow as implementCoreWorkflow,
} from '../src/index.ts'
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
  pool: 'test',
  handler: (input) =>
    Effect.gen(function* () {
      const service = yield* Service
      return input + service.value
    }),
})

it('requires the worker Layer to provide task and finish services', () => {
  const finish = implementWorkflow(workflow, { pool: 'test' }).finish(() =>
    Service.pipe(Effect.map(({ value }) => value)),
  )
  const config = {
    workflows: () => [finish],
    tasks: () => [implementation],
  }
  expect(defineWorkflowsWorker({ ...config, layer, runtime })).toBeDefined()

  // The config holds no services, so it needs none to be declared.
  const tasksOnly = {
    workflows: () => [],
    tasks: () => [implementation],
  }
  const finishOnly = { workflows: () => [finish] }
  // @ts-expect-error No Layer supplies the task service.
  defineWorkflowsWorker({ ...tasksOnly, runtime })
  // @ts-expect-error No Layer supplies the finish service.
  defineWorkflowsWorker({ ...finishOnly, runtime })
  defineWorkflowsWorker({
    ...finishOnly,
    runtime,
    // @ts-expect-error The empty Layer cannot provide Service.
    layer: Layer.empty,
  })
  defineWorkflowsWorker({
    workflows: () => [],
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
  const direct = implementWorkflow(declared, { pool: 'test' })
    .direct(() => Service.pipe(Effect.map(({ value }) => value)))
    .branch({
      select: () => 'a',
      cases: ({ activity }) => ({ a: activity(() => Effect.succeed(1)) }),
    })
    .parallel({ a: () => Effect.succeed(1) })
    .finish(() => Effect.succeed(1))
  const branch = implementWorkflow(declared, { pool: 'test' })
    .direct(() => Effect.succeed(1))
    .branch({
      select: () => 'a',
      cases: ({ activity }) => ({
        a: activity(() => Service.pipe(Effect.map(({ value }) => value))),
      }),
    })
    .parallel({ a: () => Effect.succeed(1) })
    .finish(() => Effect.succeed(1))
  const parallel = implementWorkflow(declared, { pool: 'test' })
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
  defineWorkflowsWorker({ workflows: () => [direct], runtime })
  // @ts-expect-error Branch activity requirements reach the worker boundary.
  defineWorkflowsWorker({ workflows: () => [branch], runtime })
  // @ts-expect-error Parallel activity requirements reach the worker boundary.
  defineWorkflowsWorker({ workflows: () => [parallel], runtime })
  expect(
    defineWorkflowsWorker({
      workflows: () => [direct, branch, parallel],
      layer,
      runtime,
    }),
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
    pool: 'test',
    handler: () => Effect.acquireRelease(Effect.succeed(1), () => Effect.void),
  })
  const scopedOnly = {
    workflows: () => [],
    tasks: () => [scoped],
  }
  // Scope comes from the worker, not from the Layer.
  expect(defineWorkflowsWorker({ ...scopedOnly, runtime })).toBeDefined()
  const factory = Service.pipe(Effect.andThen(runtime))
  const empty = { workflows: () => [] }
  expect(
    defineWorkflowsWorker({ ...empty, layer, runtime: factory }),
  ).toBeDefined()
  // @ts-expect-error Adapter factories also require their Layer services.
  defineWorkflowsWorker({ ...empty, runtime: factory })
})

it('accepts decoded values and Effect handlers without an async compatibility API', () => {
  implementTask(task, {
    pool: 'test',
    handler: (input) => {
      expectTypeOf(input).toEqualTypeOf<number>()
      return Effect.succeed(input)
    },
  })
  implementTask(task, {
    pool: 'test',
    // @ts-expect-error Handlers return decoded Type, not authored Encoded.
    handler: () => Effect.succeed('1'),
  })
  implementTask(task, {
    pool: 'test',
    // @ts-expect-error Only native Effects cross the execution boundary.
    handler: async () => 1,
  })
})

describe('core handlers in Effect workers', () => {
  class Service extends Context.Service<Service, { value: number }>()(
    'test/core-handlers/Service',
  ) {}
  type Db = { readonly db: { read(): number } }
  const io = { input: z.number(), output: z.number() }
  const task = defineCoreTask({ name: 'core-handlers.task', ...io })
  const coreWorkflow = defineCoreWorkflow({
    name: 'core-handlers.workflow',
    ...io,
  }).build()
  const runtime = Effect.sync(createInMemoryWorkflowRuntime)
  const layer = Layer.succeed(Service, { value: 1 })

  const needsDb = implementCoreTask(task, {
    pool: 'test',
    handler: (_input, _lifecycle, env: Db) => env.db.read(),
  })
  const finishNeedsDb = implementCoreWorkflow(coreWorkflow, {
    pool: 'test',
  }).finish((_outputs, _input, _lifecycle, env: Db) => env.db.read())
  const envless = implementCoreTask(task, {
    pool: 'test',
    handler: (input) => input,
  })
  const usesRuntime = implementCoreTask(task, {
    pool: 'test',
    handler: (_input, lifecycle, env: HandlerRuntime<Service>) =>
      env.run(
        () => Service.pipe(Effect.map(({ value }) => value)),
        lifecycle.signal,
      ),
  })
  const effectTask = implementTask(task, {
    pool: 'test',
    handler: () => Service.pipe(Effect.map(({ value }) => value)),
  })

  it('rejects a core env that is not a handler runtime in the Neem worker', () => {
    expectTypeOf<Requirements<typeof envless>>().toEqualTypeOf<never>()
    expectTypeOf<Requirements<typeof usesRuntime>>().toEqualTypeOf<Service>()
    expectTypeOf<Requirements<typeof effectTask>>().toEqualTypeOf<Service>()
    expectTypeOf<Requirements<typeof needsDb>>().not.toEqualTypeOf<never>()

    const workflows = () => []
    // @ts-expect-error An Effect worker cannot pass the task its db.
    defineWorkflowsWorker({ workflows, tasks: () => [needsDb], runtime })
    defineWorkflowsWorker({
      workflows,
      tasks: () => [needsDb],
      runtime,
      // @ts-expect-error No Layer stands in for the env either.
      layer,
    })
    // @ts-expect-error Finish handlers are checked the same way.
    defineWorkflowsWorker({ workflows: () => [finishNeedsDb], runtime })
    defineWorkflowsWorker({
      workflows,
      tasks: () => [envless, effectTask, needsDb],
      runtime,
      // @ts-expect-error One incompatible handler fails a mixed list.
      layer,
    })

    expect(
      defineWorkflowsWorker({
        workflows,
        tasks: () => [envless],
        runtime,
      }),
    ).toBeDefined()
    expect(
      defineWorkflowsWorker({
        workflows,
        tasks: () => [envless, usesRuntime, effectTask],
        runtime,
        layer,
      }),
    ).toBeDefined()
    const erased: { workflows: () => any[]; tasks: () => any[] } = {
      workflows,
      tasks: () => [needsDb],
    }
    expect(defineWorkflowsWorker({ ...erased, runtime })).toBeDefined()
  })

  it('rejects a core env that is not a handler runtime in standalone workers', () => {
    const worker = {
      ...createInMemoryWorkflowRuntime(),
      workflows: [],
      workerId: 'core-handlers',
    }
    const context = Context.make(Service, { value: 1 })
    // Thunks: only the call's types matter, the workers must not run.
    void (() =>
      // @ts-expect-error The context cannot carry the task's db.
      runExecutionWorker({ ...worker, tasks: [needsDb], context }))
    void (() =>
      runWorkflowWorker({
        ...worker,
        workflows: [finishNeedsDb],
        // @ts-expect-error Nor the finish handler's.
        context: Context.empty(),
      }))
    void (() =>
      runExecutionWorker({
        ...worker,
        tasks: [envless],
        context: Context.empty(),
      }))
    void (() =>
      runExecutionWorker({
        ...worker,
        tasks: [envless, usesRuntime, effectTask],
        context,
      }))
    const erased: any[] = [needsDb]
    void (() =>
      runExecutionWorker({
        ...worker,
        tasks: erased,
        context: Context.empty(),
      }))
  })
})

describe('core handler env subtypes in Effect workers', () => {
  class Service extends Context.Service<Service, { value: number }>()(
    'test/core-env-subtypes/Service',
  ) {}
  type Db = { readonly db: { read(): number } }
  const io = { input: z.number(), output: z.number() }
  const task = defineCoreTask({ name: 'core-env-subtypes.task', ...io })
  const coreWorkflow = defineCoreWorkflow({
    name: 'core-env-subtypes.workflow',
    ...io,
  }).build()
  const runtime = Effect.sync(createInMemoryWorkflowRuntime)
  const layer = Layer.succeed(Service, { value: 1 })

  const needsDbToo = implementCoreTask(task, {
    pool: 'test',
    handler: (_input, _lifecycle, env: HandlerRuntime<Service> & Db) =>
      env.db.read(),
  })
  const finishNeedsDbToo = implementCoreWorkflow(coreWorkflow, {
    pool: 'test',
  }).finish((_outputs, _input, _lifecycle, env: HandlerRuntime & Db) =>
    env.db.read(),
  )
  const usesRuntime = implementCoreTask(task, {
    pool: 'test',
    handler: (_input, lifecycle, env: HandlerRuntime<Service>) =>
      env.run(
        () => Service.pipe(Effect.map(({ value }) => value)),
        lifecycle.signal,
      ),
  })

  it('rejects an env that asks for more than the handler runtime', () => {
    expectTypeOf<Requirements<typeof usesRuntime>>().toEqualTypeOf<Service>()
    expectTypeOf<Requirements<typeof needsDbToo>>().not.toEqualTypeOf<Service>()
    expectTypeOf<
      Requirements<typeof finishNeedsDbToo>
    >().not.toEqualTypeOf<never>()

    const workflows = () => []
    defineWorkflowsWorker({
      workflows,
      tasks: () => [needsDbToo],
      runtime,
      // @ts-expect-error The Layer covers the services, nothing covers db.
      layer,
    })
    // @ts-expect-error Finish handlers are checked the same way.
    defineWorkflowsWorker({
      workflows: () => [finishNeedsDbToo],
      runtime,
    })
    const worker = {
      ...createInMemoryWorkflowRuntime(),
      workflows: [],
      workerId: 'core-env-subtypes',
    }
    // Thunk: only the call's types matter, the worker must not run.
    void (() =>
      runExecutionWorker({
        ...worker,
        tasks: [needsDbToo],
        // @ts-expect-error The context cannot carry the task's db.
        context: Context.make(Service, { value: 1 }),
      }))

    expect(
      defineWorkflowsWorker({
        workflows,
        tasks: () => [usesRuntime],
        runtime,
        layer,
      }),
    ).toBeDefined()
  })
})

// A step bound without a mapper receives the workflow input as is. These
// workflows take a string while their steps take a number, so every binding
// below needs a mapper; the `same` ones take the workflow input itself.
describe('Effect chain: mapper required for incompatible step inputs', () => {
  class Service extends Context.Service<Service, { value: number }>()(
    'test/mapper/Service',
  ) {}
  const text = Schema.String
  const count = Schema.Number
  const countTask = defineTask({
    name: 'mapper.count',
    input: count,
    output: count,
  })
  const textTask = defineTask({
    name: 'mapper.text',
    input: text,
    output: text,
  })
  const step = { input: count, output: count }
  const same = { input: text, output: text }
  const add = (input: number) =>
    Service.pipe(Effect.map(({ value }) => input + value))

  it('rejects a task or activity node without a mapper', () => {
    const taskNode = defineWorkflow({
      name: 'mapper.task',
      input: text,
      output: count,
    })
      .task('step', countTask)
      .build()
    const activityNode = defineWorkflow({
      name: 'mapper.activity',
      input: text,
      output: count,
    })
      .activity('step', step)
      .build()

    // @ts-expect-error The task takes a number, the workflow a string.
    implementWorkflow(taskNode, { pool: 'test' }).step(countTask)
    implementWorkflow(activityNode, { pool: 'test' })
      // @ts-expect-error The activity takes a number, the workflow a string.
      .step((input) => Effect.succeed(input + 1))

    implementWorkflow(taskNode, { pool: 'test' })
      .step(countTask, { input: (_outputs, input) => Number(input) })
      .finish(({ step }) => Effect.succeed(step))
    const mapped = implementWorkflow(activityNode, { pool: 'test' })
      .step((input) => add(input), {
        input: (_outputs, input) => Number(input),
      })
      .finish(({ step }) => Effect.succeed(step))
    expectTypeOf<Requirements<typeof mapped>>().toEqualTypeOf<Service>()
  })

  it('keeps the mapper optional when the step takes the workflow input', () => {
    const compatible = defineWorkflow({
      name: 'mapper.compatible',
      input: text,
      output: text,
    })
      .task('task', textTask)
      .activity('activity', same)
      .parallel('pair', (h) => ({
        task: h.task(textTask),
        bare: h.activity(same),
      }))
      .build()

    const implementation = implementWorkflow(compatible, { pool: 'test' })
      .task(textTask)
      .activity((input) =>
        Service.pipe(Effect.map(({ value }) => `${input}${value}`)),
      )
      .pair({ task: textTask, bare: (input) => Effect.succeed(input) })
      .finish(({ pair }) => Effect.succeed(pair.bare))
    expectTypeOf<Requirements<typeof implementation>>().toEqualTypeOf<Service>()
    expect(implementation.nodes).toHaveLength(3)
  })

  it('rejects parallel members and branch cases without a mapper', () => {
    const cases = defineWorkflow({
      name: 'mapper.cases',
      input: text,
      output: count,
    })
      .parallel('pair', (h) => ({
        task: h.task(countTask),
        activity: h.activity(step),
      }))
      .branch('pick', {
        cases: (h) => ({ task: h.task(countTask), activity: h.activity(step) }),
        output: count,
      })
      .build()
    const chain = implementWorkflow(cases, { pool: 'test' })

    chain.pair(({ task, activity }) => ({
      // @ts-expect-error The task member takes a number.
      task: task(countTask),
      // @ts-expect-error The activity member takes a number.
      activity: activity((input) => Effect.succeed(input + 1)),
    }))
    chain.pair({
      // @ts-expect-error A bare task has no mapper.
      task: countTask,
      // @ts-expect-error Nor has a bare handler.
      activity: (input: number) => Effect.succeed(input + 1),
    })

    const mapped = chain
      .pair(({ task, activity }) => ({
        task: task(countTask, { input: (_outputs, input) => Number(input) }),
        activity: activity((input) => add(input), {
          input: (_outputs, input) => Number(input),
        }),
      }))
      .pick({
        select: () => 'task',
        cases: ({ task, activity }) => ({
          task: task(countTask, { input: ({ pair }) => pair.task }),
          activity: activity((input) => Effect.succeed(input + 1), {
            input: ({ pair }) => pair.activity,
          }),
        }),
      })
      .finish(({ pick }) => Effect.succeed(pick))
    expectTypeOf<Requirements<typeof mapped>>().toEqualTypeOf<Service>()

    chain
      .pair(({ task, activity }) => ({
        task: task(countTask, { input: (_outputs, input) => Number(input) }),
        activity: activity((input) => Effect.succeed(input + 1), {
          input: (_outputs, input) => Number(input),
        }),
      }))
      .pick({
        select: () => 'task',
        cases: ({ task, activity }) => ({
          // @ts-expect-error The task case takes a number.
          task: task(countTask),
          // @ts-expect-error The activity case takes a number.
          activity: activity((input) => Effect.succeed(input + 1)),
        }),
      })
  })
})
