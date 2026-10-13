import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import { expect, expectTypeOf, it } from 'vitest'

import type { Requirements } from '../src/effect/index.ts'
import type { Ref } from '../src/experimental/index.ts'
import type { MapNodeOutput } from '../src/index.ts'
import { runExecutionWorker, runWorkflowWorker } from '../src/effect/index.ts'
import { defineWorkflowsWorker } from '../src/effect/neem.ts'
import { task, workflow } from '../src/experimental/index.ts'
import { createInMemoryWorkflowRuntime } from '../src/runtime/index.ts'
import {
  Carriers,
  Fulfillment,
  type Ship,
} from './fixtures/experimental/fulfillment.ts'

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
      handler: (values, lifecycle) => {
        expectTypeOf(values).toEqualTypeOf<readonly number[]>()
        expectTypeOf(lifecycle.signal).toEqualTypeOf<AbortSignal>()
        return Effect.succeed({ value: values.length })
      },
    })
    expectTypeOf(total).toEqualTypeOf<Ref<Doubled>>()

    yield* w.activity('output', {
      input: Schema.Number,
      output: Schema.Number,
      from: (read) => read(total).value,
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
      // @ts-expect-error A deferred source must produce the input's type.
      from: (read) => read(total),
      handler: (value) => Effect.succeed(value),
    })
    yield* w.branch('cases', {
      select: () => 'only',
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

    return (read) => read(total).value
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
      return () => 1
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
        // @ts-expect-error A member input is checked like a step input.
        label: p.workflow(Label, { input: (read) => `${read(first)}` }),
      }),
    })
    yield* w.parallel('selected', {
      // @ts-expect-error Every member runs, so there is nothing to select.
      select: () => 'double',
      members: (p) => ({ double: p.task(Double, { input: first }) }),
    })

    return (read) => {
      // @ts-expect-error Only declared members are in the output.
      void read(all).missing
      return read(all).double.value
    }
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
          const double = p.task(Double, { input: () => 1 })
          // @ts-expect-error A member has no reference: siblings cannot read it.
          const label = p.workflow(Label, { input: double })
          return { double, label }
        },
      })
      return () => 1
    }))
})

it('types map items, item inputs and outputs from the item schema', () => {
  workflow({ ...numbers, name: 'maps' }, function* (w) {
    const doubled = yield* w.mapTask('double', Double, {
      item: Schema.NumberFromString,
      items: w.input,
      input: (read, item, index) => {
        expectTypeOf(item).toEqualTypeOf<number>()
        expectTypeOf(index).toEqualTypeOf<number>()
        expectTypeOf(read(w.input)).toEqualTypeOf<readonly number[]>()
        return item
      },
    })
    expectTypeOf(doubled).toEqualTypeOf<Ref<MapNodeOutput<number, Doubled>>>()

    const labelled = yield* w.mapWorkflow('label', Label, {
      item: Schema.Struct({ value: Schema.Number }),
      items: (read) => read(doubled).items.map(({ output }) => output),
      input: (_read, { value }) => value,
    })
    expectTypeOf(labelled).toEqualTypeOf<Ref<MapNodeOutput<Doubled, string>>>()

    yield* w.mapTask('items', Double, {
      item: Schema.Number,
      // @ts-expect-error The items must be of the item schema's type.
      items: () => ['a'],
      input: (_read, item) => item,
    })
    yield* w.mapTask('single', Double, {
      item: Schema.Number,
      // @ts-expect-error The items are a list, not one item.
      items: (read) => read(w.input).length,
      input: (_read, item) => item,
    })
    yield* w.mapTask('mismatched', Double, {
      item: Schema.String,
      items: () => ['a'],
      // @ts-expect-error Each item's input must be the task's input.
      input: (_read, item) => item,
    })
    yield* w.mapWorkflow('child', Label, {
      item: Schema.Number,
      items: w.input,
      // @ts-expect-error A child workflow's input is checked the same way.
      input: (_read, item) => `${item}`,
    })
    yield* w.mapWorkflow('policy', Label, {
      item: Schema.Number,
      items: w.input,
      input: (_read, item) => item,
      // @ts-expect-error A child workflow has no retry policy; a task has.
      retry: { attempts: 2 },
    })
    // @ts-expect-error A map declares the schema of its items.
    yield* w.mapTask('schemaless', Double, {
      items: w.input,
      input: (_read, _item, index) => index,
    })

    return (read) => read(doubled).items.length
  })
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

it('carries the services of every activity to the worker', async () => {
  const text = { pool: 'test', input: Schema.String, output: Schema.String }
  const Notify = workflow({ ...text, name: 'notify' }, function* (w) {
    const sent = yield* w.parallel('all', {
      members: (p) => ({ mail: p.activity({ ...send, from: w.input }) }),
    })
    return yield* w.branch('audit', {
      select: () => 'record',
      cases: (p) => ({
        record: p.activity({ ...record, from: (read) => read(sent).mail }),
        skip: p.workflow(Label, { input: () => 1 }),
      }),
    })
  })
  // A parent with no activity of its own, two levels above one that has some.
  const Parent = workflow({ ...text, name: 'parent' }, function* (w) {
    yield* w.mapWorkflow('each', Notify, {
      item: Schema.String,
      items: (read) => [read(w.input)],
      input: (_read, item) => item,
    })
    return w.input
  })
  const Root = workflow({ ...text, name: 'root' }, function* (w) {
    return yield* w.workflow('parent', Parent, { input: w.input })
  })

  type Served<T extends { readonly workflows: readonly unknown[] }> =
    Requirements<T['workflows'][number]>

  // An implementation requires what its own activities use, and nothing more.
  expectTypeOf<Requirements<typeof Notify.implementation>>().toEqualTypeOf<
    Audit | Mailer
  >()
  expectTypeOf<
    Requirements<typeof Parent.implementation>
  >().toEqualTypeOf<never>()
  expectTypeOf<
    Requirements<typeof Ship.implementation>
  >().toEqualTypeOf<Carriers>()
  // The list a worker registers requires everything reachable from it.
  expectTypeOf<Served<typeof Root>>().toEqualTypeOf<Audit | Mailer>()
  expectTypeOf<Served<typeof Fulfillment>>().toEqualTypeOf<Carriers>()

  const runtime = createInMemoryWorkflowRuntime()
  const worker = {
    ...runtime,
    workflows: Root.workflows,
    tasks: Root.tasks,
    workerId: 'types',
  }
  const audit = Context.make(Audit, {
    record: (entry) => Effect.succeed(entry),
  })
  const context = Context.add(audit, Mailer, {
    send: (to) => Effect.succeed(to),
  })

  await runWorkflowWorker({ ...worker, context })
  await runExecutionWorker({ ...worker, context })
  // @ts-expect-error The context must provide Mailer for a nested member.
  await runExecutionWorker({ ...worker, context: audit })
  // @ts-expect-error A coordinator serves the same implementations.
  await runWorkflowWorker({ ...worker, context: Context.empty() })

  const served = {
    workflows: () => Fulfillment.workflows,
    tasks: () => Fulfillment.tasks,
    runtime: Effect.sync(createInMemoryWorkflowRuntime),
  }
  const book = () => Effect.succeed('tracking')
  expect(
    defineWorkflowsWorker({
      ...served,
      layer: () => Layer.succeed(Carriers, { book }),
    }),
  ).toBeDefined()
  // @ts-expect-error No Layer supplies Carriers for the child's activity.
  defineWorkflowsWorker(served)
  // @ts-expect-error The empty Layer cannot provide Carriers.
  defineWorkflowsWorker({ ...served, layer: () => Layer.empty })
})
