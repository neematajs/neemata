import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import { expect, expectTypeOf, it } from 'vitest'

import type { Requirements } from '../src/effect/index.ts'
import type { Ref } from '../src/experimental/index.ts'
import type {
  TaskInput,
  TaskOutput,
  WorkflowInput,
  WorkflowOutput,
} from '../src/index.ts'
import { runExecutionWorker } from '../src/effect/index.ts'
import { defineWorkflowsWorker } from '../src/effect/neem.ts'
import { task, workflow } from '../src/experimental/index.ts'
import { createInMemoryWorkflowRuntime } from '../src/runtime/index.ts'
import { Billing, Payments } from './fixtures/experimental/billing.ts'

type Doubled = { readonly value: number }

const Double = task({
  name: 'double',
  pool: 'test',
  input: Schema.NumberFromString,
  output: Schema.Struct({ value: Schema.Number }),
  handler: (input) => {
    expectTypeOf(input).toEqualTypeOf<number>()
    return Effect.succeed({ value: input * 2 })
  },
})

const Label = workflow(
  { name: 'label', pool: 'test', input: Schema.Number, output: Schema.String },
  function* (w) {
    const doubled = yield* w.task('double', Double, { input: w.input })
    return (read) => String(read(doubled).value)
  },
)

it('types handlers, references and contracts from the schemas alone', () => {
  const Flow = workflow(
    {
      name: 'flow',
      pool: 'test',
      input: Schema.NumberFromString,
      output: Schema.String,
    },
    function* (w) {
      expectTypeOf(w.input).toEqualTypeOf<Ref<number>>()
      const doubled = yield* w.task('double', Double, { input: w.input })
      expectTypeOf(doubled).toEqualTypeOf<Ref<Doubled>>()
      // @ts-expect-error A reference is not the value it will refer to.
      void doubled.value

      return (read) => {
        expectTypeOf(read(doubled)).toEqualTypeOf<Doubled>()
        return String(read(doubled).value)
      }
    },
  )

  expectTypeOf(Double.contract.name).toEqualTypeOf<'double'>()
  expectTypeOf<TaskInput<typeof Double.contract>>().toEqualTypeOf<number>()
  expectTypeOf<TaskOutput<typeof Double.contract>>().toEqualTypeOf<Doubled>()
  expectTypeOf(Flow.contract.name).toEqualTypeOf<'flow'>()
  expectTypeOf<WorkflowInput<typeof Flow.contract>>().toEqualTypeOf<number>()
  expectTypeOf<WorkflowOutput<typeof Flow.contract>>().toEqualTypeOf<string>()
})

it('rejects handlers, step inputs and results that do not fit the schemas', () => {
  task({
    name: 'wrong-output',
    pool: 'test',
    input: Schema.Number,
    output: Schema.Number,
    // @ts-expect-error The handler must produce the output schema's type.
    handler: (input) => Effect.succeed(String(input)),
  })

  workflow(
    {
      name: 'wrong',
      pool: 'test',
      input: Schema.String,
      output: Schema.String,
    },
    function* (w) {
      // @ts-expect-error A string reference cannot be a number input.
      yield* w.task('direct', Double, { input: w.input })
      yield* w.task('derived', Double, {
        // @ts-expect-error A deferred input must produce the task's input.
        input: (read) => read(w.input),
      })
      // @ts-expect-error A child workflow's input is checked the same way.
      yield* w.workflow('child', Label, { input: w.input })

      return w.input
    },
  )

  const wrong = {
    pool: 'test',
    input: Schema.NumberFromString,
    output: Schema.String,
  }
  workflow(
    { ...wrong, name: 'result' },
    // @ts-expect-error The result must be the workflow's output type.
    function* (w) {
      return yield* w.task('double', Double, { input: w.input })
    },
  )
  workflow(
    { ...wrong, name: 'derived' },
    // @ts-expect-error A deferred result is checked the same way.
    function* (w) {
      const doubled = yield* w.task('double', Double, { input: w.input })
      return (read) => read(doubled).value
    },
  )
})

it('checks selector keys against the cases and unions their outputs', () => {
  workflow(
    {
      name: 'branches',
      pool: 'test',
      input: Schema.Number,
      output: Schema.Union([
        Schema.String,
        Schema.Struct({ value: Schema.Number }),
      ]),
    },
    function* (w) {
      const chosen = yield* w.branch('choice', {
        select: (read) => (read(w.input) > 0 ? 'task' : 'workflow'),
        cases: (p) => ({
          task: p.task(Double, { input: w.input }),
          workflow: p.workflow(Label, { input: w.input }),
        }),
      })
      expectTypeOf(chosen).toEqualTypeOf<Ref<Doubled | string>>()

      yield* w.branch('ordered', {
        cases: (p) => ({ only: p.task(Double, { input: w.input }) }),
        // @ts-expect-error The selector must return one of the case keys.
        select: () => 'other',
      })
      yield* w.branch('unknown', {
        // @ts-expect-error The selector must return one of the case keys.
        select: (read) => (read(w.input) > 0 ? 'task' : 'missing'),
        cases: (p) => ({ task: p.task(Double, { input: w.input }) }),
      })
      yield* w.branch('cases', {
        select: () => 'workflow',
        cases: (p) => ({
          // @ts-expect-error A case input is checked like a step input.
          workflow: p.workflow(Label, { input: (read) => `${read(w.input)}` }),
        }),
      })
      yield* w.branch('detached', {
        select: () => 'task',
        cases: (p) => {
          const detached = p.task(Double, { input: w.input })
          // @ts-expect-error A case plan is not iterable, so not yieldable.
          void (() => [...detached])
          return { task: detached }
        },
      })

      return chosen
    },
  )
})

it('requires the worker to provide the services of every reachable task', async () => {
  const runtime = createInMemoryWorkflowRuntime()
  const worker = {
    ...runtime,
    workflows: Billing.workflows,
    tasks: Billing.tasks,
    workerId: 'types',
  }
  const payments = { charge: () => Effect.succeed('card') }

  expectTypeOf<
    Requirements<(typeof Billing.tasks)[number]>
  >().toEqualTypeOf<Payments>()

  await runExecutionWorker({
    ...worker,
    context: Context.make(Payments, payments),
  })
  // @ts-expect-error The context must provide Payments for ChargeCard.
  await runExecutionWorker({ ...worker, context: Context.empty() })

  const served = {
    workflows: () => Billing.workflows,
    tasks: () => Billing.tasks,
    runtime: Effect.sync(createInMemoryWorkflowRuntime),
  }
  expect(
    defineWorkflowsWorker({
      ...served,
      layer: () => Layer.succeed(Payments, payments),
    }),
  ).toBeDefined()
  // @ts-expect-error No Layer supplies Payments.
  defineWorkflowsWorker(served)
  // @ts-expect-error The empty Layer cannot provide Payments.
  defineWorkflowsWorker({ ...served, layer: () => Layer.empty })
})
