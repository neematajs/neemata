import { expect, expectTypeOf, it } from '@effect/vitest'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

import type {
  AnyWorkflow,
  MapOutput,
  Ref,
  Services,
} from '../../src/dsl/index.ts'
import type { AttemptInfo } from '../../src/program.ts'
import { task, workflow } from '../../src/dsl/index.ts'
import { serve } from '../dsl-support.ts'
import { Carriers, Fulfillment, type Ship } from '../fixtures/fulfillment.ts'

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
  handler: (input) => Effect.succeed({ value: input * 2 }),
})

const Label = workflow(
  { name: 'label', pool: 'test', input: Schema.Number, output: Schema.String },
  function* (w) {
    return yield* w.activity('text', {
      input: Schema.Number,
      output: Schema.String,
      from: w.input,
      handler: (value) => Effect.succeed(String(value)),
    })
  },
)

const numbers = {
  pool: 'test',
  input: Schema.Array(Schema.NumberFromString),
  output: Schema.Number,
}

it('types activity handlers and references from the schemas alone', () => {
  workflow({ ...numbers, name: 'activities' }, function* (w) {
    const total = yield* w.activity('total', {
      input: Schema.Array(Schema.NumberFromString),
      output: Schema.Struct({ value: Schema.Number }),
      from: w.input,
      handler: (values, attempt) => {
        expectTypeOf(values).toEqualTypeOf<readonly number[]>()
        expectTypeOf(attempt).toEqualTypeOf<AttemptInfo>()
        return Effect.succeed({ value: values.length })
      },
    })
    expectTypeOf(total).toEqualTypeOf<Ref<Doubled>>()

    yield* w.activity('output', {
      input: Schema.Number,
      output: Schema.Number,
      from: Effect.map(total, ({ value }) => value),
      // @ts-expect-error The handler must produce the output schema's type.
      handler: (value) => Effect.succeed(String(value)),
    })
    yield* w.activity('direct', {
      input: Schema.String,
      output: Schema.String,
      // @ts-expect-error A list reference cannot feed a string input.
      from: w.input,
      handler: (value) => Effect.succeed(value),
    })
    yield* w.activity('derived', {
      input: Schema.String,
      output: Schema.String,
      // @ts-expect-error A computed source must produce the input's type.
      from: Effect.map(total, ({ value }) => value),
      handler: (value) => Effect.succeed(value),
    })
    yield* w.branch('cases', {
      select: Effect.succeed('only' as const),
      cases: (p) => ({
        only: p.activity({
          input: Schema.Number,
          output: Schema.Number,
          // @ts-expect-error A case source is checked like a step source.
          from: w.input,
          handler: (value) => Effect.succeed(value),
        }),
      }),
    })

    return Effect.map(total, ({ value }) => value)
  })

  // Never built: `input` is the activity's schema, so a reference there is no
  // schema at all.
  void (() =>
    workflow({ ...numbers, name: 'schema' }, function* (w) {
      yield* w.activity('step', {
        // @ts-expect-error The value an activity receives is `from`.
        input: w.input,
        output: Schema.Number,
        from: w.input,
        handler: () => Effect.succeed(1),
      })
      return Effect.succeed(1)
    }))
})

it('keys a parallel output by member and checks every member', () => {
  workflow({ ...numbers, name: 'parallel' }, function* (w) {
    const first = yield* w.activity('first', {
      input: Schema.Array(Schema.Number),
      output: Schema.Number,
      from: w.input,
      handler: (values) => Effect.succeed(values[0] ?? 0),
    })
    const all = yield* w.parallel('all', {
      members: (p) => ({
        double: p.task(Double, { input: first }),
        label: p.workflow(Label, { input: first }),
        positive: p.activity({
          input: Schema.Number,
          output: Schema.Boolean,
          from: first,
          handler: (value) => Effect.succeed(value > 0),
        }),
      }),
    })
    expectTypeOf(all).toEqualTypeOf<
      Ref<{
        readonly double: Doubled
        readonly label: string
        readonly positive: boolean
      }>
    >()

    yield* w.parallel('mismatched', {
      members: (p) => ({
        label: p.workflow(Label, {
          // @ts-expect-error A member input is checked like a step input.
          input: Effect.map(first, (value) => `${value}`),
        }),
      }),
    })
    yield* w.parallel('selected', {
      // @ts-expect-error Every member runs, so there is nothing to select.
      select: Effect.succeed('double' as const),
      members: (p) => ({ double: p.task(Double, { input: first }) }),
    })

    return Effect.map(all, (members) => {
      // @ts-expect-error Only declared members are in the output.
      void members.missing
      return members.double.value
    })
  })

  // Never built: each fails while the workflow is assembled.
  void (() =>
    workflow({ ...numbers, name: 'detached' }, function* (w) {
      yield* w.parallel('object', {
        // @ts-expect-error Members are declared by a callback.
        members: { double: Double },
      })
      yield* w.parallel('values', {
        // @ts-expect-error A member is built with the callback's builder.
        members: () => ({ double: Double }),
      })
      yield* w.parallel('sibling', {
        members: (p) => {
          const double = p.task(Double, { input: Effect.succeed(1) })
          // @ts-expect-error A member has no reference: siblings cannot read it.
          const label = p.workflow(Label, { input: double })
          return { double, label }
        },
      })
      return Effect.succeed(1)
    }))
})

it('types map items, item inputs and outputs from the item schema', () => {
  workflow({ ...numbers, name: 'maps' }, function* (w) {
    const doubled = yield* w.mapTask('double', Double, {
      item: Schema.NumberFromString,
      items: w.input,
      input: (item, index) => {
        expectTypeOf(item).toEqualTypeOf<number>()
        expectTypeOf(index).toEqualTypeOf<number>()
        return Effect.map(w.input, (values) => {
          expectTypeOf(values).toEqualTypeOf<readonly number[]>()
          return item
        })
      },
    })
    expectTypeOf(doubled).toEqualTypeOf<Ref<MapOutput<number, Doubled>>>()

    const labelled = yield* w.mapWorkflow('label', Label, {
      item: Schema.Struct({ value: Schema.Number }),
      items: Effect.map(doubled, ({ items }) =>
        items.map(({ output }) => output),
      ),
      input: ({ value }) => Effect.succeed(value),
    })
    expectTypeOf(labelled).toEqualTypeOf<Ref<MapOutput<Doubled, string>>>()

    yield* w.mapTask('items', Double, {
      item: Schema.Number,
      // @ts-expect-error The items must be of the item schema's type.
      items: Effect.succeed(['a']),
      input: (item) => Effect.succeed(item),
    })
    yield* w.mapTask('single', Double, {
      item: Schema.Number,
      // @ts-expect-error The items are a list, not one item.
      items: Effect.map(w.input, (values) => values.length),
      input: (item) => Effect.succeed(item),
    })
    yield* w.mapTask('mismatched', Double, {
      item: Schema.String,
      items: Effect.succeed(['a']),
      // @ts-expect-error Each item's input must be the task's input.
      input: (item) => Effect.succeed(item),
    })
    yield* w.mapWorkflow('child', Label, {
      item: Schema.Number,
      items: w.input,
      // @ts-expect-error A child workflow's input is checked the same way.
      input: (item) => Effect.succeed(`${item}`),
    })
    yield* w.mapWorkflow('policy', Label, {
      item: Schema.Number,
      items: w.input,
      input: (item) => Effect.succeed(item),
      // @ts-expect-error A child workflow has no retry policy; a task has.
      retry: { attempts: 2 },
    })

    return Effect.map(doubled, ({ items }) => items.length)
  })

  // Never built: a step without one of its schemas is refused as it is declared.
  void (() =>
    workflow({ ...numbers, name: 'schemaless' }, function* (w) {
      // @ts-expect-error A map declares the schema of its items.
      yield* w.mapTask('each', Double, {
        items: w.input,
        input: (_item, index) => Effect.succeed(index),
      })
      return Effect.succeed(1)
    }))
})

class Audit extends Context.Service<
  Audit,
  { readonly record: (entry: string) => Effect.Effect<string> }
>()('types/Audit') {}

class Mailer extends Context.Service<
  Mailer,
  { readonly send: (to: string) => Effect.Effect<string> }
>()('types/Mailer') {}

const record = {
  input: Schema.String,
  output: Schema.String,
  handler: (entry: string) =>
    Effect.gen(function* () {
      const audit = yield* Audit
      return yield* audit.record(entry)
    }),
}

const send = {
  input: Schema.String,
  output: Schema.String,
  handler: (to: string) =>
    Effect.gen(function* () {
      const mailer = yield* Mailer
      return yield* mailer.send(to)
    }),
}

it('rejects sources, items and item inputs that need a service or can fail', () => {
  // A handler runs on a worker and may use its services; what feeds it is
  // computed in the coordinator, from a run and nothing else.
  workflow({ ...numbers, name: 'computed' }, function* (w) {
    yield* w.activity('source', {
      ...send,
      // @ts-expect-error A source cannot require a service.
      from: Effect.flatMap(Mailer, (mailer) => mailer.send('a')),
    })
    yield* w.mapTask('items', Double, {
      item: Schema.Number,
      // @ts-expect-error The items cannot fail.
      items: Effect.fail(new Error('none')),
      input: (item) => Effect.succeed(item),
    })
    yield* w.mapTask('each', Double, {
      item: Schema.Number,
      items: w.input,
      // @ts-expect-error An item input cannot require a service.
      input: (item) => Effect.as(Audit, item),
    })

    return Effect.succeed(1)
  })
})

it('carries the services of every activity to the worker', () => {
  const text = { pool: 'test', input: Schema.String, output: Schema.String }
  const Notify = workflow({ ...text, name: 'notify' }, function* (w) {
    const sent = yield* w.parallel('all', {
      members: (p) => ({ mail: p.activity({ ...send, from: w.input }) }),
    })
    return yield* w.branch('audit', {
      select: Effect.succeed('record' as const),
      cases: (p) => ({
        record: p.activity({
          ...record,
          from: Effect.map(sent, ({ mail }) => mail),
        }),
        skip: p.workflow(Label, { input: Effect.succeed(1) }),
      }),
    })
  })
  // A parent with no activity of its own, two levels above one that has some.
  const Parent = workflow({ ...text, name: 'parent' }, function* (w) {
    yield* w.mapWorkflow('each', Notify, {
      item: Schema.String,
      items: Effect.map(w.input, (value) => [value]),
      input: (item) => Effect.succeed(item),
    })
    return w.input
  })
  const Root = workflow({ ...text, name: 'root' }, function* (w) {
    return yield* w.workflow('parent', Parent, { input: w.input })
  })

  // A workflow requires what its own activities use, and nothing more.
  expectTypeOf<Services<typeof Notify>>().toEqualTypeOf<Audit | Mailer>()
  expectTypeOf<Services<typeof Parent>>().toEqualTypeOf<never>()
  expectTypeOf<Services<typeof Ship>>().toEqualTypeOf<Carriers>()
  // What a worker serves requires everything reachable from it.
  expectTypeOf<Served<typeof Root>>().toEqualTypeOf<Audit | Mailer>()
  expectTypeOf<Served<typeof Fulfillment>>().toEqualTypeOf<Carriers>()

  const audit = Context.make(Audit, {
    record: (entry) => Effect.succeed(entry),
  })
  const context = Context.add(audit, Mailer, {
    send: (to) => Effect.succeed(to),
  })

  expect(worker(Root, context)).toBeDefined()
  // @ts-expect-error The context must provide Mailer for a nested member.
  void (() => worker(Root, audit))
  // @ts-expect-error A workflow two levels up requires them all the same.
  void (() => worker(Root, Context.empty()))

  const book = () => Effect.succeed('tracking')
  expect(worker(Fulfillment, Context.make(Carriers, { book }))).toBeDefined()
  // @ts-expect-error Nothing supplies Carriers for the child's activity.
  void (() => worker(Fulfillment, Context.empty()))
})
