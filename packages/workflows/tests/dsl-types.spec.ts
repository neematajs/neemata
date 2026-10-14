import { expect, expectTypeOf, it } from '@effect/vitest'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

import type {
  AnyWorkflow,
  InputOf,
  OutputOf,
  Ref,
  Services,
} from '../src/dsl/index.ts'
import { task, workflow } from '../src/dsl/index.ts'
import { serve } from './dsl-support.ts'
import { Billing, Payments } from './fixtures/billing.ts'

/** What a worker must provide to serve everything a workflow can start. */
type Served<W extends AnyWorkflow> = Services<
  W['workflows'][number] | W['tasks'][number]
>

const worker = <W extends AnyWorkflow>(
  root: W,
  context: Context.Context<Served<W>>,
) => serve(root.programs, context)

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
    return Effect.map(doubled, ({ value }) => String(value))
  },
)

it('types handlers, references and declarations from the schemas alone', () => {
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

      return Effect.gen(function* () {
        const value = yield* doubled
        expectTypeOf(value).toEqualTypeOf<Doubled>()
        return String(value.value)
      })
    },
  )

  expectTypeOf(Double.name).toEqualTypeOf<'double'>()
  expectTypeOf<InputOf<typeof Double>>().toEqualTypeOf<number>()
  expectTypeOf<OutputOf<typeof Double>>().toEqualTypeOf<Doubled>()
  expectTypeOf(Flow.name).toEqualTypeOf<'flow'>()
  expectTypeOf<InputOf<typeof Flow>>().toEqualTypeOf<number>()
  expectTypeOf<OutputOf<typeof Flow>>().toEqualTypeOf<string>()
  // A caller crosses to stored values and back through the same types.
  expectTypeOf(Flow.input.encode).parameter(0).toEqualTypeOf<number>()
  expectTypeOf(Flow.output.decode).returns.toEqualTypeOf<string>()
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
        // @ts-expect-error A computed input must produce the task's input.
        input: Effect.map(w.input, (text) => text.trim()),
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
    // @ts-expect-error A computed result is checked the same way.
    function* (w) {
      const doubled = yield* w.task('double', Double, { input: w.input })
      return Effect.map(doubled, ({ value }) => value)
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
        select: Effect.map(w.input, (value) =>
          value > 0 ? 'task' : 'workflow',
        ),
        cases: (p) => ({
          task: p.task(Double, { input: w.input }),
          workflow: p.workflow(Label, { input: w.input }),
        }),
      })
      expectTypeOf(chosen).toEqualTypeOf<Ref<Doubled | string>>()

      yield* w.branch('ordered', {
        cases: (p) => ({ only: p.task(Double, { input: w.input }) }),
        // @ts-expect-error The selector must produce one of the case keys.
        select: Effect.succeed('other' as const),
      })
      yield* w.branch('unknown', {
        // @ts-expect-error The selector must produce one of the case keys.
        select: Effect.map(w.input, (value) =>
          value > 0 ? 'task' : 'missing',
        ),
        cases: (p) => ({ task: p.task(Double, { input: w.input }) }),
      })
      yield* w.branch('cases', {
        select: Effect.succeed('workflow' as const),
        cases: (p) => ({
          workflow: p.workflow(Label, {
            // @ts-expect-error A case input is checked like a step input.
            input: Effect.map(w.input, (value) => `${value}`),
          }),
        }),
      })
      yield* w.branch('detached', {
        select: Effect.succeed('task' as const),
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

class Clock extends Context.Service<
  Clock,
  { readonly now: Effect.Effect<number> }
>()('types/Clock') {}

class Negative extends Error {}

const positive = (value: number) =>
  value > 0 ? Effect.succeed(value) : Effect.fail(new Negative())

it('rejects computed values that need a service or can fail', () => {
  const numeric = { pool: 'test', input: Schema.Number, output: Schema.Number }

  // The coordinator computes these with a run and nothing else: a service a
  // worker provides and a failure nobody handles are both type errors.
  workflow({ ...numeric, name: 'computed' }, function* (w) {
    yield* w.branch('service', {
      // @ts-expect-error A selector cannot require a service.
      select: Effect.as(Clock, 'only' as const),
      cases: (p) => ({ only: p.task(Double, { input: w.input }) }),
    })
    yield* w.branch('failing', {
      // @ts-expect-error A selector cannot fail.
      select: Effect.as(Effect.flatMap(w.input, positive), 'only' as const),
      cases: (p) => ({ only: p.task(Double, { input: w.input }) }),
    })
    yield* w.task('clocked', Double, {
      // @ts-expect-error An input cannot require a service.
      input: Effect.flatMap(Clock, (clock) => clock.now),
    })
    yield* w.task('checked', Double, {
      // @ts-expect-error An input cannot fail.
      input: Effect.flatMap(w.input, positive),
    })
    yield* w.workflow('failed', Label, {
      // @ts-expect-error A failure has no value to be the input.
      input: Effect.fail(new Negative()),
    })

    return w.input
  })

  workflow(
    { ...numeric, name: 'clocked' },
    // @ts-expect-error The result cannot require a service.
    function* (w) {
      yield* w.task('double', Double, { input: w.input })
      return Effect.flatMap(Clock, (clock) => clock.now)
    },
  )
  workflow(
    { ...numeric, name: 'checked' },
    // @ts-expect-error The result cannot fail.
    function* (w) {
      yield* w.task('double', Double, { input: w.input })
      return Effect.flatMap(w.input, positive)
    },
  )
})

it('reads a reference inside an Effect, never by yielding it in the body', () => {
  const text = { pool: 'test', input: Schema.Number, output: Schema.String }

  // Never built: the body yields something that is not a plan.
  void (() =>
    workflow(
      { ...text, name: 'unwrapped' },
      // @ts-expect-error Only plans can be yielded; a reference is not one.
      function* (w) {
        const doubled = yield* w.task('double', Double, { input: w.input })
        const { value } = yield* doubled
        return Effect.succeed(String(value))
      },
    ))

  workflow({ ...text, name: 'wrapped' }, function* (w) {
    const doubled = yield* w.task('double', Double, { input: w.input })
    return Effect.gen(function* () {
      const { value } = yield* doubled
      return String(value)
    })
  })
})

it('requires the worker to provide the services of every reachable task', () => {
  const payments = { charge: () => Effect.succeed('card') }

  expectTypeOf<
    Services<(typeof Billing.tasks)[number]>
  >().toEqualTypeOf<Payments>()
  // No workflow of the example has an activity of its own.
  expectTypeOf<
    Services<(typeof Billing.workflows)[number]>
  >().toEqualTypeOf<never>()
  expectTypeOf<Served<typeof Billing>>().toEqualTypeOf<Payments>()

  expect(worker(Billing, Context.make(Payments, payments))).toBeDefined()
  // @ts-expect-error The context must provide Payments for ChargeCard.
  void (() => worker(Billing, Context.empty()))
})
