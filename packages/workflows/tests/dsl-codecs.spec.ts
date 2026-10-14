import { describe, expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import * as SchemaTransformation from 'effect/SchemaTransformation'

import type { WorkflowProgram } from '../src/program.ts'
import { decodeRun, task, workflow } from '../src/dsl/index.ts'
import { node, serve } from './dsl-support.ts'

// Both are stored as text, so a value that skipped a boundary in either
// direction has the wrong type on the other side.
const Count = Schema.NumberFromString
const When = Schema.DateFromString

const DAY = 86_400_000
const day = (ordinal: number) => new Date(Date.UTC(2026, 0, ordinal))
const iso = (ordinal: number) => day(ordinal).toISOString()

const Order = Schema.Struct({
  at: When,
  count: Count,
  text: Schema.Boolean,
})
const Summary = Schema.Struct({
  at: When,
  picked: Count,
  both: Schema.Struct({ next: When, child: Count }),
  each: Schema.Array(Schema.Struct({ item: When, output: When })),
  tens: Schema.Array(Count),
})

/** One workflow crossing every boundary, logging each decoded value it sees. */
function author() {
  const seen: [where: string, value: unknown][] = []
  const saw = (where: string) =>
    seen.filter(([place]) => place === where).map(([, value]) => value)
  const logged =
    <Input, Output>(where: string, run: (input: Input) => Output) =>
    (input: Input) =>
      Effect.sync(() => {
        seen.push([where, input])
        return run(input)
      })

  const Next = task({
    name: 'next',
    pool: 'test',
    input: When,
    output: When,
    handler: logged('next', (at) => new Date(at.getTime() + DAY)),
  })
  const Plain = task({
    name: 'plain',
    pool: 'test',
    input: Schema.Number,
    output: Schema.Number,
    handler: logged('plain', (count) => count + 1),
  })
  const Tenfold = workflow(
    { name: 'tenfold', pool: 'test', input: Count, output: Count },
    function* (w) {
      return yield* w.activity('times', {
        input: Count,
        output: Count,
        from: w.input,
        handler: logged('tenfold', (count) => count * 10),
      })
    },
  )

  const Flow = workflow(
    { name: 'flow', pool: 'test', input: Order, output: Summary },
    function* (w) {
      const doubled = yield* w.activity('double', {
        input: Count,
        output: Count,
        from: Effect.map(w.input, ({ count }) => count),
        handler: logged('double', (count) => count * 2),
      })
      const picked = yield* w.branch('pick', {
        select: Effect.map(w.input, ({ text }) => (text ? 'text' : 'plain')),
        // Both cases produce a number; only `text` stores it as text.
        cases: (p) => ({
          text: p.activity({
            input: Count,
            output: Count,
            from: doubled,
            handler: logged('text', (count) => count + 1),
          }),
          plain: p.task(Plain, { input: doubled }),
        }),
      })
      const both = yield* w.parallel('both', {
        members: (p) => ({
          next: p.task(Next, { input: Effect.map(w.input, ({ at }) => at) }),
          child: p.workflow(Tenfold, { input: picked }),
        }),
      })
      const each = yield* w.mapTask('each', Next, {
        item: When,
        items: Effect.map(both, ({ next }) => {
          seen.push(['items', next])
          return [next, new Date(next.getTime() + DAY)]
        }),
        input: (item, index) =>
          Effect.sync(() => {
            seen.push([`item ${index}`, item])
            return item
          }),
      })
      const tens = yield* w.mapWorkflow('tens', Tenfold, {
        item: Count,
        items: Effect.map(picked, (count) => [count, count + 1]),
        input: (count) => Effect.succeed(count),
      })

      return Effect.gen(function* () {
        const { items } = yield* each
        seen.push(['result', items.map(({ item }) => item)])
        return {
          at: (yield* w.input).at,
          picked: yield* picked,
          both: yield* both,
          each: items.map(({ item, output }) => ({ item, output })),
          tens: (yield* tens).items.map(({ output }) => output),
        }
      })
    },
  )

  return { saw, Flow, Next, Tenfold }
}

describe('stored values', () => {
  it.effect(
    'are the schemas` encodings at every boundary, and decoded values everywhere else',
    () =>
      Effect.gen(function* () {
        const { saw, Flow, Tenfold } = author()
        const engine = serve(Flow.programs)

        const records = yield* engine.run(Flow, {
          at: day(1),
          count: 21,
          text: true,
        })
        const runs = (name: string) =>
          engine.inspect
            .runs()
            .filter(({ run }) => run.name === name)
            .map(({ run }) => [run.input, run.output])

        expect(records.run).toMatchObject({
          status: 'completed',
          input: { at: iso(1), count: '21', text: true },
          output: {
            at: iso(1),
            picked: '43',
            both: { next: iso(2), child: '430' },
            each: [
              { item: iso(2), output: iso(3) },
              { item: iso(3), output: iso(4) },
            ],
            tens: ['430', '440'],
          },
        })

        // An activity: its node, its attempt and its handler.
        expect(node(records, 'double')).toMatchObject({
          input: '21',
          output: '42',
        })
        expect(
          records.attempts.find(({ nodeName }) => nodeName === 'double'),
        ).toMatchObject({ input: '21', output: '42' })
        expect(saw('double')).toEqual([21])

        // The selected case, read back by the steps after it.
        expect(node(records, 'pick')).toMatchObject({
          selectedCase: 'text',
          input: '42',
          output: '43',
        })
        expect(saw('text')).toEqual([42])
        expect(saw('plain')).toEqual([])

        // Members: a task run and a child workflow run, each in its encoding.
        expect(node(records, 'both')?.output).toEqual({
          next: iso(2),
          child: '430',
        })

        // Map items, each item's input, and the aggregate of their outputs.
        expect(saw('items')).toEqual([day(2)])
        expect(node(records, 'each')).toMatchObject({
          input: [iso(2), iso(3)],
          output: {
            items: [
              { item: iso(2), index: 0, output: iso(3) },
              { item: iso(3), index: 1, output: iso(4) },
            ],
          },
        })
        expect(saw('item 0')).toEqual([day(2)])
        expect(saw('item 1')).toEqual([day(3)])
        expect(saw('result')).toEqual([[day(2), day(3)]])
        expect(node(records, 'tens')).toMatchObject({
          input: ['43', '44'],
          output: {
            items: [
              { item: '43', output: '430' },
              { item: '44', output: '440' },
            ],
          },
        })

        // Task and child workflow runs hold their own input and output.
        expect(runs('next')).toEqual([
          [iso(1), iso(2)],
          [iso(2), iso(3)],
          [iso(3), iso(4)],
        ])
        expect(saw('next')).toEqual([day(1), day(2), day(3)])
        expect(runs('tenfold')).toEqual([
          ['43', '430'],
          ['43', '430'],
          ['44', '440'],
        ])
        expect(saw('tenfold')).toEqual([43, 43, 44])

        // A caller reads the run back through the declaration it started.
        expect(decodeRun(Flow, records.run)).toMatchObject({
          id: records.run.id,
          status: 'completed',
          input: { at: day(1), count: 21, text: true },
          output: {
            at: day(1),
            picked: 43,
            both: { next: day(2), child: 430 },
            each: [
              { item: day(2), output: day(3) },
              { item: day(3), output: day(4) },
            ],
            tens: [430, 440],
          },
        })
        expect(() => decodeRun(Tenfold, records.run)).toThrow(
          `Run [${records.run.id}] is not a run of workflow [tenfold]`,
        )
      }),
  )

  it.effect('of a branch are read back with the selected case`s schema', () =>
    Effect.gen(function* () {
      const { saw, Flow } = author()

      const records = yield* serve(Flow.programs).run(Flow, {
        at: day(1),
        count: 21,
        text: false,
      })

      // The other case stores a number as it is: the same reference reads it.
      expect(node(records, 'pick')).toMatchObject({
        selectedCase: 'plain',
        input: 42,
        output: 43,
      })
      expect(saw('plain')).toEqual([42])
      expect(saw('tenfold')).toEqual([43, 43, 44])
      expect(records.run).toMatchObject({
        status: 'completed',
        output: { picked: '43', tens: ['430', '440'] },
      })
    }),
  )

  it.effect('of a pending run decode without an output', () =>
    Effect.gen(function* () {
      const { Flow } = author()
      const run = yield* serve(Flow.programs).start(Flow, {
        at: day(1),
        count: 1,
        text: true,
      })

      const decoded = decodeRun(Flow, run)

      expect(decoded.input).toEqual({ at: day(1), count: 1, text: true })
      expect(decoded).not.toHaveProperty('output')
    }),
  )
})

describe('a value that cannot cross a boundary', () => {
  const text = { pool: 'test', input: Schema.String, output: Schema.String }

  it('is refused before a caller starts a run with it', () => {
    const { Flow } = author()

    expect(() =>
      // @ts-expect-error A count is a number.
      Flow.input.encode({ at: day(1), count: 'many', text: true }),
    ).toThrow('Invalid workflow input [flow]')
  })

  it.effect('fails the attempt whose handler produced it', () =>
    Effect.gen(function* () {
      const Raw = task({
        name: 'raw',
        pool: 'test',
        input: Schema.String,
        // Any value fits its schema; a stored one must still be JSON.
        output: Schema.Any,
        handler: () => Effect.succeed({ when: day(1) }),
      })
      const Flow = workflow({ ...text, name: 'flow' }, function* (w) {
        yield* w.task('raw', Raw, { input: w.input })
        return w.input
      })

      const records = yield* serve(Flow.programs).run(Flow, 'x')

      expect(records.run).toMatchObject({
        status: 'failed',
        error: {
          message: 'Invalid task output [raw]',
          cause: { message: 'Expected a JSON value at $.when' },
        },
      })
    }),
  )

  it.effect('fails the attempt that was handed one its schema refuses', () =>
    Effect.gen(function* () {
      const { saw, Next } = author()
      const engine = serve([Next.program])
      // Stored by a caller that went around the declaration.
      const run = yield* engine.startStored({
        kind: 'task',
        name: 'next',
        input: 'yesterday',
      })

      const records = yield* engine.drain(run.id)

      expect(saw('next')).toEqual([])
      expect(records.run).toMatchObject({
        status: 'failed',
        error: { message: 'Invalid task input [next]' },
      })
    }),
  )

  it.effect('fails the step it was computed for, like any computed value', () =>
    Effect.gen(function* () {
      const Echo = task({
        ...text,
        name: 'echo',
        handler: (input) => Effect.succeed(input),
      })
      const Flow = workflow({ ...text, name: 'flow' }, function* (w) {
        yield* w.task('step', Echo, {
          // @ts-expect-error A step's input is the task's input type.
          input: Effect.succeed(7),
        })
        return w.input
      })

      const records = yield* serve(Flow.programs).run(Flow, 'x')

      expect(records.nodes).toMatchObject([{ name: 'step', status: 'failed' }])
      expect(records.run).toMatchObject({
        status: 'failed',
        error: { message: 'Invalid task input [echo]' },
      })
    }),
  )

  it.effect('fails the run when it is the result', () =>
    Effect.gen(function* () {
      const Echo = task({
        ...text,
        name: 'echo',
        handler: (input) => Effect.succeed(input),
      })
      const Flow = workflow(
        { ...text, name: 'flow' },
        // @ts-expect-error The result is the workflow's output type.
        function* (w) {
          yield* w.task('step', Echo, { input: w.input })
          return Effect.succeed(7)
        },
      )

      const records = yield* serve(Flow.programs).run(Flow, 'x')

      expect(records.nodes).toMatchObject([
        { name: 'step', status: 'completed' },
      ])
      expect(records.run).toMatchObject({
        status: 'failed',
        error: { message: 'Invalid workflow output [flow]' },
      })
    }),
  )
})

describe('a map whose items are not a list', () => {
  const text = { pool: 'test', input: Schema.String, output: Schema.String }
  const Echo = task({
    ...text,
    name: 'echo',
    handler: (input) => Effect.succeed(input),
  })

  it.effect('fails its step when the workflow is declared with schemas', () =>
    Effect.gen(function* () {
      const Flow = workflow({ ...text, name: 'flow' }, function* (w) {
        yield* w.mapTask('each', Echo, {
          item: Schema.String,
          // @ts-expect-error The items are a list.
          items: w.input,
          input: (item) => Effect.succeed(item),
        })
        return w.input
      })

      const records = yield* serve(Flow.programs).run(Flow, 'x')

      expect(records.nodes).toMatchObject([
        { name: 'each', kind: 'mapTask', status: 'failed' },
      ])
      expect(records.children).toEqual([])
      expect(records.run).toMatchObject({
        status: 'failed',
        error: { message: 'Invalid map items [flow.each]' },
      })
    }),
  )

  it.effect('fails its step in a program written by hand', () =>
    Effect.gen(function* () {
      const program: WorkflowProgram = {
        kind: 'workflow',
        name: 'flow',
        steps: [
          {
            name: 'each',
            kind: 'map',
            // Nothing types a program where it runs.
            items: () => 'x' as never,
            input: (_outputs, _input, item) => item,
            target: { kind: 'task', task: { name: 'echo' } },
          },
        ],
        result: () => null,
      }
      const engine = serve([program, Echo.program])
      const run = yield* engine.startStored({ name: 'flow', input: 'x' })

      const records = yield* engine.drain(run.id)

      expect(records.nodes).toMatchObject([
        { name: 'each', kind: 'mapTask', status: 'failed' },
      ])
      expect(records.children).toEqual([])
      expect(records.run).toMatchObject({
        status: 'failed',
        error: { message: 'Map [each] needs a list of items' },
      })
    }),
  )
})

describe('the functions of a program', () => {
  /** Maps the letters of its input, each item's input reading the input too. */
  function author() {
    const count = { decoded: 0 }
    const Counted = Schema.String.pipe(
      Schema.decodeTo(
        Schema.String,
        SchemaTransformation.transform({
          decode: (value) => {
            count.decoded++
            return value
          },
          encode: (value) => value,
        }),
      ),
    )
    const Echo = task({
      name: 'echo',
      pool: 'test',
      input: Schema.String,
      output: Schema.String,
      handler: (input) => Effect.succeed(input),
    })
    const Flow = workflow(
      { name: 'flow', pool: 'test', input: Counted, output: Schema.String },
      function* (w) {
        yield* w.mapTask('each', Echo, {
          item: Schema.String,
          items: Effect.map(w.input, (word) => word.split('')),
          input: (letter) => Effect.map(w.input, (word) => `${word}:${letter}`),
        })
        return w.input
      },
    )
    const [each] = Flow.program.steps
    if (each?.kind !== 'map') throw new Error('Expected a map')

    return { count, each, result: Flow.program.result }
  }

  it('decode what a pass reads once, however many values read it', () => {
    const { count, each } = author()
    // What one pass hands every function it calls.
    const outputs = {}

    const items = each.items(outputs, 'abc', {})
    const inputs = items.map((item, index) =>
      each.input(outputs, 'abc', item, index, {}),
    )

    expect(inputs).toEqual(['abc:a', 'abc:b', 'abc:c'])
    expect(count.decoded).toBe(1)
    // The next pass reads what is stored then.
    each.items({}, 'abc', {})
    expect(count.decoded).toBe(2)
  })

  it('compute from their arguments alone', () => {
    const { result } = author()
    const outputs = { each: { items: [] } }

    expect(result(outputs, 'abc', {})).toBe('abc')
    expect(result(outputs, 'xyz', {})).toBe('xyz')
  })
})
