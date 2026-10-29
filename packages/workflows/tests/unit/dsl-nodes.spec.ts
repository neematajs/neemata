import { describe, expect, it } from '@effect/vitest'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

import type { RunRecords } from '../../src/model.ts'
import { task, workflow } from '../../src/dsl/index.ts'
import { serializeWorkflowGraph } from '../../src/graph/index.ts'
import { node, serve, shape } from '../dsl-support.ts'
import { Carriers, Fulfillment } from '../fixtures/fulfillment.ts'

const Line = Schema.Struct({
  sku: Schema.String,
  quantity: Schema.NumberFromString,
})
const Lines = Schema.Array(Line)
const Order = Schema.Struct({
  id: Schema.String,
  gift: Schema.Boolean,
  lines: Lines,
})
const Risk = Schema.Literals(['low', 'high'])
const Reserved = Schema.Struct({ sku: Schema.String, bin: Schema.String })
const Parcel = Schema.Struct({
  order: Schema.String,
  sku: Schema.String,
  bin: Schema.String,
})
const Label = Schema.Struct({ sku: Schema.String, tracking: Schema.String })
const Labels = Schema.Array(Label)
const Tracking = Schema.Array(Schema.String)
const Summary = Schema.Struct({
  order: Schema.String,
  units: Schema.Number,
  risk: Risk,
  tracking: Tracking,
  note: Schema.String,
})

const text = { pool: 'test', input: Schema.String, output: Schema.String }

/** Authors fulfillment once, logging every handler call and computed value. */
function author() {
  const log: [step: string, input?: unknown][] = []

  function logged<Input, Output>(step: string, run: (input: Input) => Output) {
    return (input: Input) =>
      Effect.sync(() => {
        log.push([step, input])
        return run(input)
      })
  }

  const Screen = task({
    name: 'order.screen',
    pool: 'risk',
    input: Schema.String,
    output: Risk,
    handler: logged('screen', () => 'low' as const),
  })
  const Reserve = task({
    name: 'stock.reserve',
    pool: 'warehouse',
    input: Line,
    output: Reserved,
    handler: logged('reserve', ({ sku, quantity }) => ({
      sku,
      bin: `bin-${quantity}`,
    })),
  })

  const Ship = workflow(
    { name: 'parcel.ship', pool: 'shipping', input: Parcel, output: Label },
    function* (w) {
      return yield* w.activity('label', {
        title: 'Label',
        input: Parcel,
        output: Label,
        from: w.input,
        handler: logged('label', ({ order, sku }) => ({
          sku,
          tracking: `${order}/${sku}`,
        })),
      })
    },
  )

  const Root = workflow(
    { name: 'fulfillment', pool: 'fulfillment', input: Order, output: Summary },
    function* (w) {
      const checks = yield* w.parallel('checks', {
        title: 'Checks',
        members: (p) => ({
          units: p.activity({
            description: 'Counts the units',
            input: Lines,
            // Stored as a string, read back as a number.
            output: Schema.NumberFromString,
            from: Effect.map(w.input, ({ lines }) => {
              log.push(['units input'])
              return lines
            }),
            retry: { attempts: 2 },
            timeout: '5s',
            handler: logged('units', (lines) =>
              lines.reduce((sum, line) => sum + line.quantity, 0),
            ),
          }),
          risk: p.task(Screen, {
            input: Effect.map(w.input, ({ id }) => id),
            timeout: '10s',
          }),
        }),
      })
      const reserved = yield* w.mapTask('reserve', Reserve, {
        description: 'Reserves every line',
        item: Line,
        items: Effect.map(w.input, ({ lines }) => {
          log.push(['items'])
          return lines
        }),
        input: (line, index) =>
          Effect.sync(() => {
            log.push(['item input', index])
            return line
          }),
        concurrency: 2,
        retry: { attempts: 2 },
        timeout: '20s',
      })
      const shipped = yield* w.mapWorkflow('ship', Ship, {
        title: 'Ship',
        item: Reserved,
        items: Effect.map(reserved, ({ items }) =>
          items.map(({ output }) => output),
        ),
        input: ({ sku, bin }) =>
          Effect.map(w.input, ({ id }) => ({ order: id, sku, bin })),
        cancellation: 'detach',
      })
      const note = yield* w.branch('wrap', {
        select: Effect.map(w.input, ({ gift }) => {
          log.push(['select'])
          return gift ? 'gift' : 'plain'
        }),
        cases: (p) => ({
          gift: p.activity({
            title: 'Gift',
            input: Schema.String,
            output: Schema.String,
            from: Effect.map(w.input, ({ id }) => id),
            handler: logged('gift', (order) => `gift:${order}`),
          }),
          plain: p.activity({
            input: Schema.Number,
            output: Schema.String,
            from: Effect.map(checks, ({ units }) => units),
            timeout: '1s',
            handler: logged('plain', (units) => `plain:${units}`),
          }),
        }),
      })
      const tracking = yield* w.activity('collect', {
        title: 'Collect',
        description: 'Lists the tracking codes',
        input: Labels,
        output: Tracking,
        from: Effect.map(shipped, ({ items }) =>
          items.map(({ output }) => output),
        ),
        retry: { attempts: 3 },
        timeout: '15s',
        handler: logged('collect', (labels) =>
          labels.map((label) => label.tracking),
        ),
      })

      return Effect.gen(function* () {
        const { units, risk } = yield* checks
        return {
          order: (yield* w.input).id,
          units,
          risk,
          tracking: yield* tracking,
          note: yield* note,
        }
      })
    },
  )

  return { log, Root, Ship, Screen, Reserve }
}

const order = {
  id: 'o-1',
  gift: false,
  lines: [
    { sku: 'a', quantity: 2 },
    { sku: 'b', quantity: 3 },
    { sku: 'c', quantity: 1 },
  ],
}

describe('activities, parallel and maps', () => {
  it('builds every node without calling a handler or computing a value', () => {
    const { log, Root, Ship } = author()

    expect(log).toEqual([])
    expect(Root.workflows.map(({ name }) => name)).toEqual([
      'fulfillment',
      'parcel.ship',
    ])
    expect(Root.tasks.map(({ name }) => name)).toEqual([
      'order.screen',
      'stock.reserve',
    ])
    expect(serializeWorkflowGraph(Ship).nodes).toEqual([
      { name: 'label', kind: 'activity', title: 'Label' },
    ])
    expect(log).toEqual([])
  })

  it('builds the program the engine runs, and the graph a frontend receives', () => {
    const { Root } = author()

    expect(shape(Root.program)).toEqual({
      kind: 'workflow',
      name: 'fulfillment',
      steps: [
        {
          name: 'checks',
          kind: 'parallel',
          members: {
            units: {
              kind: 'activity',
              execute: 'function',
              input: 'function',
              retry: { attempts: 2 },
              timeout: '5s',
            },
            risk: {
              kind: 'task',
              task: { name: 'order.screen' },
              input: 'function',
              timeout: '10s',
            },
          },
        },
        {
          name: 'reserve',
          kind: 'map',
          items: 'function',
          input: 'function',
          target: {
            kind: 'task',
            task: { name: 'stock.reserve' },
            retry: { attempts: 2 },
            timeout: '20s',
          },
          concurrency: 2,
        },
        {
          name: 'ship',
          kind: 'map',
          items: 'function',
          input: 'function',
          target: {
            kind: 'workflow',
            workflow: { name: 'parcel.ship' },
            cancellation: 'detach',
          },
        },
        {
          name: 'wrap',
          kind: 'branch',
          select: 'function',
          cases: {
            gift: { kind: 'activity', execute: 'function', input: 'function' },
            plain: {
              kind: 'activity',
              execute: 'function',
              input: 'function',
              timeout: '1s',
            },
          },
        },
        {
          name: 'collect',
          kind: 'activity',
          execute: 'function',
          input: 'function',
          retry: { attempts: 3 },
          timeout: '15s',
        },
      ],
      result: 'function',
    })
    expect(serializeWorkflowGraph(Root)).toEqual({
      name: 'fulfillment',
      nodes: [
        {
          name: 'checks',
          kind: 'parallel',
          title: 'Checks',
          cases: [
            { key: 'units', kind: 'activity', description: 'Counts the units' },
            {
              key: 'risk',
              kind: 'task',
              target: { kind: 'task', name: 'order.screen' },
            },
          ],
        },
        {
          name: 'reserve',
          kind: 'mapTask',
          description: 'Reserves every line',
          target: { kind: 'task', name: 'stock.reserve' },
        },
        {
          name: 'ship',
          kind: 'mapWorkflow',
          title: 'Ship',
          target: { kind: 'workflow', name: 'parcel.ship' },
        },
        {
          name: 'wrap',
          kind: 'branch',
          cases: [
            { key: 'gift', kind: 'activity', title: 'Gift' },
            { key: 'plain', kind: 'activity' },
          ],
        },
        {
          name: 'collect',
          kind: 'activity',
          title: 'Collect',
          description: 'Lists the tracking codes',
        },
      ],
    })
  })

  it.effect.each([
    { gift: false, note: 'plain:6', ran: 'plain', skipped: 'gift' },
    { gift: true, note: 'gift:o-1', ran: 'gift', skipped: 'plain' },
  ])(
    'runs every node and only the $ran activity case',
    ({ gift, note, ran, skipped }) =>
      Effect.gen(function* () {
        const { log, Root } = author()

        const records = yield* serve(Root.programs).run(Root, {
          ...order,
          gift,
        })

        expect(records.run).toMatchObject({
          status: 'completed',
          output: {
            order: 'o-1',
            units: 6,
            risk: 'low',
            tracking: ['o-1/a', 'o-1/b', 'o-1/c'],
            note,
          },
        })
        expect(
          records.nodes.map(({ name, status, selectedCase }) => ({
            name,
            status,
            selectedCase,
          })),
        ).toEqual([
          { name: 'checks', status: 'completed', selectedCase: undefined },
          { name: 'reserve', status: 'completed', selectedCase: undefined },
          { name: 'ship', status: 'completed', selectedCase: undefined },
          { name: 'wrap', status: 'completed', selectedCase: ran },
          { name: 'collect', status: 'completed', selectedCase: undefined },
        ])

        const steps = log.map(([step]) => step)
        expect(steps).toContain(ran)
        expect(steps).not.toContain(skipped)
        // Each value was computed and each handler ran once per unit of work.
        expect(steps.toSorted()).toEqual(
          [
            'units input',
            'units',
            'screen',
            'items',
            'item input',
            'item input',
            'item input',
            'reserve',
            'reserve',
            'reserve',
            'label',
            'label',
            'label',
            'select',
            ran,
            'collect',
          ].toSorted(),
        )

        const inputs = Object.fromEntries(log)
        // Handlers see decoded values; the parallel output is keyed by member.
        expect(inputs.units).toEqual(order.lines)
        expect(inputs.screen).toBe('o-1')
        expect(inputs[ran]).toBe(gift ? 'o-1' : 6)
        expect(inputs.collect).toEqual([
          { sku: 'a', tracking: 'o-1/a' },
          { sku: 'b', tracking: 'o-1/b' },
          { sku: 'c', tracking: 'o-1/c' },
        ])
        expect(log.filter(([step]) => step === 'label')).toEqual([
          ['label', { order: 'o-1', sku: 'a', bin: 'bin-2' }],
          ['label', { order: 'o-1', sku: 'b', bin: 'bin-3' }],
          ['label', { order: 'o-1', sku: 'c', bin: 'bin-1' }],
        ])

        // Records hold the schemas' encodings: quantities and units as strings.
        expect(node(records, 'checks')?.output).toEqual({
          units: '6',
          risk: 'low',
        })
        expect(node(records, 'reserve')?.input).toEqual([
          { sku: 'a', quantity: '2' },
          { sku: 'b', quantity: '3' },
          { sku: 'c', quantity: '1' },
        ])
      }),
  )

  it.effect(
    'runs the documented fulfillment example with the worker services',
    () =>
      Effect.gen(function* () {
        const context = Context.make(Carriers, {
          book: (order, sku) => Effect.succeed(`${order}-${sku}`),
        })
        const outputs: unknown[] = []

        for (const gift of [false, true]) {
          const records = yield* serve(Fulfillment.programs, context).run(
            Fulfillment,
            { ...order, gift },
          )
          outputs.push(records.run.output)
        }

        const shared = {
          order: 'o-1',
          units: 6,
          risk: 'low',
          tracking: ['o-1-a', 'o-1-b', 'o-1-c'],
        }
        expect(outputs).toEqual([
          { ...shared, note: '6 units' },
          { ...shared, note: 'gift receipt for o-1' },
        ])
      }),
  )

  it.effect(
    'gives a frontend the whole graph and one run`s state as plain JSON',
    () =>
      Effect.gen(function* () {
        const graph = serializeWorkflowGraph(Fulfillment)

        expect(JSON.parse(JSON.stringify(graph))).toEqual({
          name: 'fulfillment',
          nodes: [
            {
              name: 'checks',
              kind: 'parallel',
              cases: [
                { key: 'units', kind: 'activity' },
                {
                  key: 'risk',
                  kind: 'task',
                  target: { kind: 'task', name: 'fulfillment.screen' },
                },
              ],
            },
            {
              name: 'reserve',
              kind: 'mapTask',
              target: { kind: 'task', name: 'fulfillment.reserve' },
            },
            {
              name: 'ship',
              kind: 'mapWorkflow',
              target: { kind: 'workflow', name: 'fulfillment.ship' },
            },
            {
              name: 'wrap',
              kind: 'branch',
              cases: [
                { key: 'gift', kind: 'activity' },
                { key: 'plain', kind: 'activity' },
              ],
            },
          ],
        })

        const context = Context.make(Carriers, {
          book: (order, sku) => Effect.succeed(`${order}-${sku}`),
        })
        const engine = serve(Fulfillment.programs, context)
        const records: RunRecords = JSON.parse(
          JSON.stringify(
            yield* engine.run(Fulfillment, { ...order, gift: true }),
          ),
        )
        const units = (name: string) =>
          records.children.filter(({ nodeName }) => nodeName === name)

        // The graph keeps both cases; the run says which one it took.
        expect(
          records.nodes.map(({ name, status, selectedCase }) => [
            name,
            status,
            selectedCase,
          ]),
        ).toEqual([
          ['checks', 'completed', undefined],
          ['reserve', 'completed', undefined],
          ['ship', 'completed', undefined],
          ['wrap', 'completed', 'gift'],
        ])
        // A map is one node of the graph and one child run per item of the run.
        const runs = new Map(
          engine.inspect.runs().map(({ run }) => [run.id, run.name]),
        )
        expect(
          units('ship').map(({ childKey, status, childRunId }) => [
            childKey,
            status,
            runs.get(childRunId!),
          ]),
        ).toEqual([
          ['item:0', 'completed', 'fulfillment.ship'],
          ['item:1', 'completed', 'fulfillment.ship'],
          ['item:2', 'completed', 'fulfillment.ship'],
        ])
        // Members are in the order the graph's `cases` declare them.
        expect(units('checks').map(({ childKey }) => childKey)).toEqual([
          'member:units',
          'member:risk',
        ])
        expect(units('wrap').map(({ childKey }) => childKey)).toEqual([
          'case:gift',
        ])
      }),
  )
})

describe('parallel settlement', () => {
  function author() {
    const calls = { card: 0, stock: 0, audit: 0, after: 0 }

    const Stock = task({
      ...text,
      name: 'stock',
      handler: (input) =>
        Effect.sync(() => {
          calls.stock++
          return `stock:${input}`
        }),
    })
    const Audit = workflow({ ...text, name: 'audit' }, function* (w) {
      return yield* w.activity('record', {
        input: Schema.String,
        output: Schema.String,
        from: w.input,
        handler: (input) =>
          Effect.sync(() => {
            calls.audit++
            return `audit:${input}`
          }),
      })
    })
    const After = task({
      ...text,
      name: 'after',
      handler: (input) =>
        Effect.sync(() => {
          calls.after++
          return input
        }),
    })

    const flow = (fail: boolean) =>
      workflow({ ...text, name: 'flow' }, function* (w) {
        const all = yield* w.parallel('all', {
          members: (p) => ({
            card: p.activity({
              input: Schema.String,
              output: Schema.String,
              from: w.input,
              handler: (input) =>
                Effect.suspend(() => {
                  calls.card++
                  return fail
                    ? Effect.fail(new Error('card declined'))
                    : Effect.succeed(`card:${input}`)
                }),
            }),
            stock: p.task(Stock, { input: w.input }),
            audit: p.workflow(Audit, { input: w.input }),
          }),
        })

        return yield* w.task('after', After, {
          input: Effect.map(all, (members) => Object.values(members).join(' ')),
        })
      })

    return { calls, flow }
  }

  it.effect('settles every member before failing', () =>
    Effect.gen(function* () {
      const { calls, flow } = author()
      const Flow = flow(true)

      const failed = yield* serve(Flow.programs).run(Flow, 'o-1')

      // The failure does not stop its siblings, and nothing later runs.
      expect(failed.run).toMatchObject({
        status: 'failed',
        error: { message: 'card declined' },
      })
      expect(failed.nodes.map(({ name, status }) => [name, status])).toEqual([
        ['all', 'failed'],
      ])
      expect(calls).toEqual({ card: 1, stock: 1, audit: 1, after: 0 })
      expect(
        failed.children.map(({ childKey, status }) => [childKey, status]),
      ).toEqual([
        ['member:card', 'failed'],
        ['member:stock', 'completed'],
        ['member:audit', 'completed'],
      ])
    }),
  )

  it.effect('hands every member`s output to the next step, by key', () =>
    Effect.gen(function* () {
      const { calls, flow } = author()
      const Flow = flow(false)

      const records = yield* serve(Flow.programs).run(Flow, 'o-1')

      expect(records.run).toMatchObject({
        status: 'completed',
        output: 'card:o-1 stock:o-1 audit:o-1',
      })
      expect(calls).toEqual({ card: 1, stock: 1, audit: 1, after: 1 })
    }),
  )

  it.effect('retries an activity under the policy its step declares', () =>
    Effect.gen(function* () {
      const attempts = { count: 0 }
      const Flow = workflow({ ...text, name: 'flaky' }, function* (w) {
        return yield* w.activity('step', {
          input: Schema.String,
          output: Schema.String,
          from: w.input,
          retry: { attempts: 2 },
          handler: (input) =>
            Effect.suspend(() =>
              ++attempts.count === 1
                ? Effect.fail(new Error('first attempt failed'))
                : Effect.succeed(input.toUpperCase()),
            ),
        })
      })

      const records = yield* serve(Flow.programs).run(Flow, 'paid')

      expect(records.run).toMatchObject({ status: 'completed', output: 'PAID' })
      expect(attempts.count).toBe(2)
    }),
  )
})

describe('maps', () => {
  const Numbers = Schema.Array(Schema.NumberFromString)
  const Doubled = Schema.Struct({
    values: Schema.Array(Schema.Number),
    runs: Schema.Number,
  })

  /** Doubles each number; a `flaky` number fails the first time it is seen. */
  function author(
    options: { concurrency?: number; retry?: { attempts: number } } = {},
    flaky: readonly number[] = [],
  ) {
    const calls: number[] = []
    const computed = { items: 0, input: [] as [item: number, index: number][] }
    const failed = new Set<number>()

    const Double = task({
      name: 'double',
      pool: 'test',
      input: Schema.NumberFromString,
      output: Schema.Number,
      handler: (value) =>
        Effect.suspend(() => {
          calls.push(value)
          if (!flaky.includes(value) || failed.has(value)) {
            return Effect.succeed(value * 2)
          }

          failed.add(value)
          return Effect.fail(new Error(`cannot double ${value}`))
        }),
    })
    const Flow = workflow(
      { name: 'doubling', pool: 'test', input: Numbers, output: Doubled },
      function* (w) {
        const doubled = yield* w.mapTask('each', Double, {
          ...options,
          item: Schema.NumberFromString,
          items: Effect.map(w.input, (numbers) => {
            computed.items++
            return numbers
          }),
          input: (item, index) =>
            Effect.sync(() => {
              computed.input.push([item, index])
              return item
            }),
        })

        return yield* w.activity('collect', {
          input: Schema.Array(Schema.Number),
          output: Doubled,
          from: Effect.map(doubled, ({ items }) =>
            items.map(({ output }) => output),
          ),
          handler: (values) => Effect.succeed({ values, runs: values.length }),
        })
      },
    )

    return { calls, computed, Flow }
  }

  it.effect('completes an empty map and runs the steps after it', () =>
    Effect.gen(function* () {
      const { calls, computed, Flow } = author()

      const records = yield* serve(Flow.programs).run(Flow, [])

      expect(records.run).toMatchObject({
        status: 'completed',
        output: { values: [], runs: 0 },
      })
      expect(node(records, 'each')).toMatchObject({
        status: 'completed',
        input: [],
        output: { items: [] },
      })
      expect(calls).toEqual([])
      expect(computed).toEqual({ items: 1, input: [] })
    }),
  )

  it.effect(
    'starts at most `concurrency` items at once and lists outputs by index',
    () =>
      Effect.gen(function* () {
        const { calls, computed, Flow } = author({ concurrency: 2 })
        const engine = serve(Flow.programs)
        const run = yield* engine.start(Flow, [5, 4, 3, 2, 1])
        const started: number[] = []

        for (let round = 0; round < 3; round++) {
          yield* engine.pass
          yield* engine.execute
          started.push(calls.length)
        }
        const records = yield* engine.drain(run.id)

        // Two per pass: an item starts only once a slot is free.
        expect(started).toEqual([2, 4, 5])
        expect(calls).toEqual([5, 4, 3, 2, 1])
        expect(computed).toEqual({
          items: 1,
          input: [
            [5, 0],
            [4, 1],
            [3, 2],
            [2, 3],
            [1, 4],
          ],
        })
        expect(records.run.output).toEqual({
          values: [10, 8, 6, 4, 2],
          runs: 5,
        })

        // Items are stored encoded, each beside its index and its own run.
        expect(node(records, 'each')?.output).toEqual({
          items: [5, 4, 3, 2, 1].map((item, index) => ({
            item: `${item}`,
            index,
            runId: records.children[index]?.childRunId,
            output: item * 2,
          })),
        })
      }),
  )

  it.effect('keeps item order when a retried item finishes last', () =>
    Effect.gen(function* () {
      const { calls, Flow } = author({ retry: { attempts: 2 } }, [7])

      const records = yield* serve(Flow.programs).run(Flow, [7, 8, 9])

      expect(calls).toEqual([7, 8, 9, 7])
      expect(records.run.output).toEqual({ values: [14, 16, 18], runs: 3 })
    }),
  )

  it.effect('settles every item before failing', () =>
    Effect.gen(function* () {
      const { calls, computed, Flow } = author({}, [2])

      const failed = yield* serve(Flow.programs).run(Flow, [1, 2, 3])

      expect(failed.run).toMatchObject({
        status: 'failed',
        error: { message: 'cannot double 2' },
      })
      expect(calls).toEqual([1, 2, 3])
      expect(failed.children.map(({ status }) => status)).toEqual([
        'completed',
        'failed',
        'completed',
      ])
      expect(computed.items).toBe(1)
      expect(computed.input).toHaveLength(3)
    }),
  )

  it.effect('starts one child workflow per item', () =>
    Effect.gen(function* () {
      const Shout = workflow({ ...text, name: 'shout' }, function* (w) {
        return yield* w.activity('upper', {
          input: Schema.String,
          output: Schema.String,
          from: w.input,
          handler: (input) => Effect.succeed(input.toUpperCase()),
        })
      })
      const Flow = workflow(
        {
          name: 'shouting',
          pool: 'test',
          input: Schema.Array(Schema.String),
          output: Schema.String,
        },
        function* (w) {
          const shouted = yield* w.mapWorkflow('each', Shout, {
            item: Schema.String,
            items: w.input,
            input: (word, index) =>
              Effect.map(
                w.input,
                (words) => `${index + 1}/${words.length} ${word}`,
              ),
          })

          return Effect.map(shouted, ({ items }) =>
            items.map(({ output }) => output).join(', '),
          )
        },
      )
      const engine = serve(Flow.programs)

      const records = yield* engine.run(Flow, ['a', 'b'])

      expect(Flow.workflows).toEqual([Flow, Shout])
      expect(Flow.programs).toEqual([Flow.program, Shout.program])
      expect(records.run.output).toBe('1/2 A, 2/2 B')
      expect(
        engine.inspect
          .runs()
          .filter(({ run }) => run.name === 'shout')
          .map(({ run }) => [run.input, run.status]),
      ).toEqual([
        ['1/2 a', 'completed'],
        ['2/2 b', 'completed'],
      ])
    }),
  )
})

describe('node misuse', () => {
  const Echo = task({
    ...text,
    name: 'echo',
    handler: (input) => Effect.succeed(input),
  })
  const echo = {
    input: Schema.String,
    output: Schema.String,
    handler: (input: string) => Effect.succeed(input),
  }

  it('rejects a parallel member that was not built by the members builder', () => {
    expect(() =>
      workflow({ ...text, name: 'rooted' }, function* (w) {
        yield* w.parallel('both', {
          // @ts-expect-error A step plan is not a member.
          members: () => ({ only: w.task('step', Echo, { input: w.input }) }),
        })
        return w.input
      }),
    ).toThrow(
      'Parallel member [rooted.both.only] must be built with the members builder',
    )
  })

  it('rejects member keys and map options the engine rejects', () => {
    expect(() =>
      workflow({ ...text, name: 'reserved' }, function* (w) {
        yield* w.parallel('both', {
          members: (p) => ({ constructor: p.task(Echo, { input: w.input }) }),
        })
        return w.input
      }),
    ).toThrow('Workflow parallel member key cannot be "constructor": both')
    expect(() =>
      workflow({ ...text, name: 'unbounded' }, function* (w) {
        yield* w.mapTask('each', Echo, {
          item: Schema.String,
          items: Effect.succeed([]),
          input: (item) => Effect.succeed(item),
          concurrency: 0,
        })
        return w.input
      }),
    ).toThrow('Map node concurrency must be a positive integer')
  })

  it('rejects a computed `__proto__` member key without calling its handler', () => {
    let calls = 0

    // Only a computed key makes `__proto__` an own property of the literal.
    expect(() =>
      workflow({ ...text, name: 'reserved' }, function* (w) {
        yield* w.parallel('both', {
          members: (p) => ({
            ['__proto__']: p.activity({
              input: Schema.String,
              output: Schema.String,
              from: w.input,
              handler: (input) => Effect.sync(() => `${input}:${++calls}`),
            }),
          }),
        })
        return w.input
      }),
    ).toThrow('Workflow parallel member key cannot be "__proto__": both')
    expect(calls).toBe(0)
  })

  it('rejects an activity without a source or a handler', () => {
    expect(() =>
      workflow({ ...text, name: 'sourceless' }, function* (w) {
        // @ts-expect-error An activity declares where its input comes from.
        return yield* w.activity('step', echo)
      }),
    ).toThrow(
      '[sourceless.step] needs a reference or an Effect computed from references, received undefined',
    )
    expect(() =>
      workflow({ ...text, name: 'idle' }, function* (w) {
        return yield* w.branch('choice', {
          select: Effect.succeed('only' as const),
          cases: (p) => ({
            // @ts-expect-error An activity declares its handler.
            only: p.activity({ ...echo, from: w.input, handler: undefined }),
          }),
        })
      }),
    ).toThrow('Missing activity handler [idle.choice.only]')
  })

  it('rejects a map without its items or its item input', () => {
    expect(() =>
      workflow({ ...text, name: 'itemless' }, function* (w) {
        // @ts-expect-error A map declares its items.
        yield* w.mapTask('each', Echo, {
          item: Schema.String,
          input: (item: string) => Effect.succeed(item),
        })
        return w.input
      }),
    ).toThrow(
      '[itemless.each] needs a reference or an Effect computed from references, received undefined',
    )
    expect(() =>
      workflow({ ...text, name: 'inputless' }, function* (w) {
        // @ts-expect-error A map declares each item's input.
        yield* w.mapTask('each', Echo, {
          item: Schema.String,
          items: Effect.succeed([]),
        })
        return w.input
      }),
    ).toThrow(
      '[inputless.each] needs an input callback for its items, received undefined',
    )
  })

  it('rejects a step declared without one of its schemas', () => {
    expect(() =>
      workflow({ ...text, name: 'schemaless' }, function* (w) {
        // @ts-expect-error A map declares the schema of its items.
        yield* w.mapTask('each', Echo, {
          items: Effect.succeed([]),
          input: (_item, index) => Effect.succeed(`${index}`),
        })
        return w.input
      }),
    ).toThrow('Missing schema for map item [schemaless.each]')
    expect(() =>
      workflow({ ...text, name: 'schemaless' }, function* (w) {
        yield* w.activity('step', {
          ...echo,
          from: w.input,
          // @ts-expect-error An activity declares the schema of its output.
          output: undefined,
        })
        return w.input
      }),
    ).toThrow('Missing schema for activity output [schemaless.step]')
  })

  it('rejects another workflow`s reference in any new construct', () => {
    function build(inner: (outer: string) => unknown) {
      return () =>
        workflow({ ...text, name: 'outer' }, function* (w) {
          const first = yield* w.task('first', Echo, { input: w.input })
          // The reference is smuggled past the types on purpose.
          inner(first as unknown as string)
          return first
        })
    }
    const foreign = (label: string) =>
      `Reference [outer.first] belongs to another workflow and cannot be read in [${label}]`

    expect(
      build((first) =>
        workflow({ ...text, name: 'inner' }, function* (w) {
          // @ts-expect-error A value is not a reference.
          return yield* w.activity('step', { ...echo, from: first })
        }),
      ),
    ).toThrow(foreign('inner.step'))
    expect(
      build((first) =>
        workflow({ ...text, name: 'inner' }, function* (w) {
          yield* w.parallel('both', {
            members: (p) => ({
              // @ts-expect-error A value is not a reference.
              one: p.activity({ ...echo, from: first }),
            }),
          })
          return w.input
        }),
      ),
    ).toThrow(foreign('inner.both.one'))
    expect(
      build((first) =>
        workflow({ ...text, name: 'inner' }, function* (w) {
          yield* w.mapTask('each', Echo, {
            item: Schema.String,
            // @ts-expect-error A value is not a reference.
            items: first,
            input: (item) => Effect.succeed(item),
          })
          return w.input
        }),
      ),
    ).toThrow(foreign('inner.each'))
    expect(
      build((first) =>
        workflow({ ...text, name: 'inner' }, function* (w) {
          yield* w.branch('choice', {
            // @ts-expect-error A value is not a reference.
            select: first,
            cases: (p) => ({ only: p.task(Echo, { input: w.input }) }),
          })
          return w.input
        }),
      ),
    ).toThrow(foreign('inner.choice'))
  })

  it.effect.each([
    {
      name: 'a parallel member',
      message:
        'Reference [late.second] is produced after [late.both.one] and cannot be read there',
      build: () =>
        workflow({ ...text, name: 'late' }, function* (w) {
          // Built before `second` exists, so only a run can tell.
          yield* w.parallel('both', {
            members: (p) => ({
              one: p.activity({ ...echo, from: Effect.suspend(() => second) }),
            }),
          })
          const second = yield* w.task('second', Echo, { input: w.input })
          return second
        }),
    },
    {
      name: 'a map item input',
      message:
        'Reference [late.second] is produced after [late.each] and cannot be read there',
      build: () =>
        workflow({ ...text, name: 'late' }, function* (w) {
          yield* w.mapTask('each', Echo, {
            item: Schema.String,
            items: Effect.map(w.input, (value) => [value]),
            // A bare reference, but returned by a callback only a run calls.
            input: () => second,
          })
          const second = yield* w.task('second', Echo, { input: w.input })
          return second
        }),
    },
  ])('fails the run when $name reads a later step', ({ build, message }) =>
    Effect.gen(function* () {
      const Flow = build()

      const records = yield* serve(Flow.programs).run(Flow, 'x')

      expect(records.run).toMatchObject({
        status: 'failed',
        error: { message },
      })
    }),
  )
})
