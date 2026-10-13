import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vitest'

import { defineWorkflow, implementWorkflow } from '../src/effect/index.ts'
import { task, workflow } from '../src/experimental/index.ts'
import { nodeUnits, serializeWorkflowGraph } from '../src/inspector/index.ts'
import {
  createInMemoryWorkflowRuntime,
  createWorkflowRuntimeClient,
  type RunDetail,
} from '../src/runtime/index.ts'
import { Carriers, Fulfillment } from './fixtures/experimental/fulfillment.ts'
import { serve, settle, shape } from './support/experimental.ts'

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

/** Authors fulfillment once, logging every handler and deferred callback call. */
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
            from: (read) => {
              log.push(['units input'])
              return read(w.input).lines
            },
            retry: { attempts: 2 },
            timeout: '5s',
            handler: logged('units', (lines) =>
              lines.reduce((sum, line) => sum + line.quantity, 0),
            ),
          }),
          risk: p.task(Screen, {
            input: (read) => read(w.input).id,
            timeout: '10s',
          }),
        }),
      })
      const reserved = yield* w.mapTask('reserve', Reserve, {
        description: 'Reserves every line',
        item: Line,
        items: (read) => {
          log.push(['items'])
          return read(w.input).lines
        },
        input: (_read, line, index) => {
          log.push(['item input', index])
          return line
        },
        concurrency: 2,
        retry: { attempts: 2 },
        timeout: '20s',
      })
      const shipped = yield* w.mapWorkflow('ship', Ship, {
        title: 'Ship',
        item: Reserved,
        items: (read) => read(reserved).items.map(({ output }) => output),
        input: (read, { sku, bin }) => ({ order: read(w.input).id, sku, bin }),
        cancellation: 'detach',
      })
      const note = yield* w.branch('wrap', {
        select: (read) => {
          log.push(['select'])
          return read(w.input).gift ? 'gift' : 'plain'
        },
        cases: (p) => ({
          gift: p.activity({
            title: 'Gift',
            input: Schema.String,
            output: Schema.String,
            from: (read) => read(w.input).id,
            handler: logged('gift', (order) => `gift:${order}`),
          }),
          plain: p.activity({
            input: Schema.Number,
            output: Schema.String,
            from: (read) => read(checks).units,
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
        from: (read) => read(shipped).items.map(({ output }) => output),
        retry: { attempts: 3 },
        timeout: '15s',
        handler: logged('collect', (labels) =>
          labels.map((label) => label.tracking),
        ),
      })

      return (read) => ({
        order: read(w.input).id,
        units: read(checks).units,
        risk: read(checks).risk,
        tracking: read(tracking),
        note: read(note),
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

describe('experimental activities, parallel and maps', () => {
  it('builds every node without calling a handler or callback', () => {
    const { log, Root, Ship } = author()

    expect(log).toEqual([])
    expect(Root.workflows.map(({ workflow }) => workflow.name)).toEqual([
      'fulfillment',
      'parcel.ship',
    ])
    expect(Root.tasks.map(({ task }) => task.name)).toEqual([
      'order.screen',
      'stock.reserve',
    ])
    expect(serializeWorkflowGraph(Ship.contract).nodes).toEqual([
      { name: 'label', kind: 'activity', title: 'Label' },
    ])
    expect(log).toEqual([])
  })

  it('lowers to what the existing builders produce for the same graph', () => {
    const { Root, Ship, Screen, Reserve } = author()
    const contract = defineWorkflow({
      name: 'fulfillment',
      input: Order,
      output: Summary,
    })
      .parallel(
        'checks',
        (helpers) => ({
          units: helpers.activity({
            description: 'Counts the units',
            input: Lines,
            output: Schema.NumberFromString,
            retry: { attempts: 2 },
            timeout: '5s',
          }),
          risk: helpers.task(Screen.contract, { timeout: '10s' }),
        }),
        { title: 'Checks' },
      )
      .mapTask('reserve', Reserve.contract, {
        description: 'Reserves every line',
        item: Line,
        concurrency: 2,
        retry: { attempts: 2 },
        timeout: '20s',
      })
      .mapWorkflow('ship', Ship.contract, {
        title: 'Ship',
        item: Reserved,
        cancellation: 'detach',
      })
      .branch('wrap', {
        cases: (helpers) => ({
          gift: helpers.activity({
            title: 'Gift',
            input: Schema.String,
            output: Schema.String,
          }),
          plain: helpers.activity({
            input: Schema.Number,
            output: Schema.String,
            timeout: '1s',
          }),
        }),
      })
      .activity('collect', {
        title: 'Collect',
        description: 'Lists the tracking codes',
        input: Labels,
        output: Tracking,
        retry: { attempts: 3 },
        timeout: '15s',
      })
      .build()
    const implementation = implementWorkflow(contract, { pool: 'fulfillment' })
      .checks((helpers) => ({
        units: helpers.activity(() => Effect.succeed(0), {
          input: (_outputs, { lines }) => lines,
        }),
        risk: helpers.task(Screen.contract, {
          input: (_outputs, { id }) => id,
        }),
      }))
      .reserve(Reserve.contract, {
        items: (_outputs, { lines }) => lines,
        input: (_outputs, line) => line,
      })
      .ship(Ship.contract, {
        items: ({ reserve }) => reserve.items.map(({ output }) => output),
        input: (_outputs, { sku, bin }, { id }) => ({ order: id, sku, bin }),
      })
      .wrap({
        select: (_outputs, { gift }) => (gift ? 'gift' : 'plain'),
        cases: (helpers) => ({
          gift: helpers.activity((id) => Effect.succeed(id), {
            input: (_outputs, { id }) => id,
          }),
          plain: helpers.activity((units) => Effect.succeed(`${units}`), {
            input: ({ checks }) => checks.units,
          }),
        }),
      })
      .collect(() => Effect.succeed([]), { input: () => [] })
      .finish(({ checks, wrap }, { id }) =>
        Effect.succeed({ order: id, ...checks, tracking: [], note: wrap }),
      )

    expect(Root.contract).toEqual(contract)
    // The payload a frontend receives is the same for either declaration.
    expect(serializeWorkflowGraph(Root.contract)).toEqual(
      serializeWorkflowGraph(contract),
    )
    expect(serializeWorkflowGraph(Root.contract)).toEqual({
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
    expect(Root.implementation.pool).toBe(implementation.pool)
    expect(Root.implementation.nodes.map(shape)).toEqual(
      implementation.nodes.map(shape),
    )
  })

  it.each([
    { gift: false, note: 'plain:6', ran: 'plain', skipped: 'gift' },
    { gift: true, note: 'gift:o-1', ran: 'gift', skipped: 'plain' },
  ])(
    'runs every node and only the $ran activity case',
    async ({ gift, note, ran, skipped }) => {
      const { log, Root } = author()
      const runtime = createInMemoryWorkflowRuntime()
      const client = createWorkflowRuntimeClient(runtime)

      const run = await client.start(Root.contract, { ...order, gift })
      const snapshot = await settle(run.id, Root, runtime)

      expect(snapshot.run).toMatchObject({
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
        snapshot.nodes.map(({ name, status, selectedCase }) => ({
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
      // Each callback and handler ran once per unit of work, never more.
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

      // Stores hold the schemas' encodings: quantities and units as strings.
      const stored = await client.getNode(run.id, 'checks')
      expect(stored?.node.output).toEqual({ units: '6', risk: 'low' })
      const reserve = await client.getNode(run.id, 'reserve')
      expect(reserve?.node.input).toEqual([
        { sku: 'a', quantity: '2' },
        { sku: 'b', quantity: '3' },
        { sku: 'c', quantity: '1' },
      ])
    },
  )

  it('runs the documented fulfillment example with the worker services', async () => {
    const context = Context.make(Carriers, {
      book: (order, sku) => Effect.succeed(`${order}-${sku}`),
    })
    const outputs: unknown[] = []

    for (const gift of [false, true]) {
      const runtime = createInMemoryWorkflowRuntime()
      const run = await createWorkflowRuntimeClient(runtime).start(
        Fulfillment.contract,
        { ...order, gift },
      )
      const snapshot = await settle(run.id, Fulfillment, runtime, context)
      outputs.push(snapshot.run.output)
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
  })

  it('gives a frontend the whole graph and one run`s state as plain JSON', async () => {
    const graph = serializeWorkflowGraph(Fulfillment.contract)

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

    const runtime = createInMemoryWorkflowRuntime()
    const client = createWorkflowRuntimeClient(runtime)
    const context = Context.make(Carriers, {
      book: (order, sku) => Effect.succeed(`${order}-${sku}`),
    })
    const run = await client.start(Fulfillment.contract, {
      ...order,
      gift: true,
    })
    await settle(run.id, Fulfillment, runtime, context)
    const detail: RunDetail = JSON.parse(
      JSON.stringify(await client.getDetail(run.id)),
    )

    // The graph keeps both cases; the run says which one it took.
    expect(
      detail.nodes.map(({ name, status, selectedCase }) => [
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
    // A map is one node of the graph and one unit per item of the run.
    expect(
      nodeUnits(detail, 'ship').map(({ parsed, child, childRun }) => [
        parsed,
        child.status,
        childRun?.name,
      ]),
    ).toEqual([
      [{ kind: 'item', itemIndex: 0 }, 'completed', 'fulfillment.ship'],
      [{ kind: 'item', itemIndex: 1 }, 'completed', 'fulfillment.ship'],
      [{ kind: 'item', itemIndex: 2 }, 'completed', 'fulfillment.ship'],
    ])
    // Members come back by key; the graph's `cases` hold their declared order.
    expect(nodeUnits(detail, 'checks').map(({ parsed }) => parsed)).toEqual([
      { kind: 'member', memberKey: 'risk' },
      { kind: 'member', memberKey: 'units' },
    ])
    expect(nodeUnits(detail, 'wrap').map(({ parsed }) => parsed)).toEqual([
      { kind: 'case', caseKey: 'gift' },
    ])
  })
})

describe('experimental parallel settlement', () => {
  function author() {
    const calls = { card: 0, stock: 0, audit: 0, after: 0 }
    const state = { fail: true }

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

    const Flow = workflow({ ...text, name: 'flow' }, function* (w) {
      const all = yield* w.parallel('all', {
        members: (p) => ({
          card: p.activity({
            input: Schema.String,
            output: Schema.String,
            from: w.input,
            handler: (input) =>
              Effect.suspend(() => {
                calls.card++
                return state.fail
                  ? Effect.fail(new Error('card declined'))
                  : Effect.succeed(`card:${input}`)
              }),
          }),
          stock: p.task(Stock, { input: w.input }),
          audit: p.workflow(Audit, { input: w.input }),
        }),
      })

      return yield* w.task('after', After, {
        input: (read) => Object.values(read(all)).join(' '),
      })
    })

    return { calls, state, Flow }
  }

  it('settles every member before failing, then retries only the failed one', async () => {
    const { calls, state, Flow } = author()
    const runtime = createInMemoryWorkflowRuntime()
    const client = createWorkflowRuntimeClient(runtime)
    const run = await client.start(Flow.contract, 'o-1')

    const failed = await settle(run.id, Flow, runtime)

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

    state.fail = false
    await client.retry(run.id)
    const retried = await settle(run.id, Flow, runtime)

    expect(retried.run).toMatchObject({
      status: 'completed',
      output: 'card:o-1 stock:o-1 audit:o-1',
    })
    expect(calls).toEqual({ card: 2, stock: 1, audit: 1, after: 1 })
  })

  it('retries an activity under the policy its step declares', async () => {
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
    const runtime = createInMemoryWorkflowRuntime()
    const run = await createWorkflowRuntimeClient(runtime).start(
      Flow.contract,
      'paid',
    )

    const snapshot = await settle(run.id, Flow, runtime)

    expect(snapshot.run).toMatchObject({ status: 'completed', output: 'PAID' })
    expect(attempts.count).toBe(2)
  })
})

describe('experimental maps', () => {
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
    const callbacks = { items: 0, input: [] as [item: number, index: number][] }
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
          items: (read) => {
            callbacks.items++
            return read(w.input)
          },
          input: (_read, item, index) => {
            callbacks.input.push([item, index])
            return item
          },
        })

        return yield* w.activity('collect', {
          input: Schema.Array(Schema.Number),
          output: Doubled,
          from: (read) => read(doubled).items.map(({ output }) => output),
          handler: (values) => Effect.succeed({ values, runs: values.length }),
        })
      },
    )

    return { calls, callbacks, Flow }
  }

  it('completes an empty map and runs the steps after it', async () => {
    const { calls, callbacks, Flow } = author()
    const runtime = createInMemoryWorkflowRuntime()
    const client = createWorkflowRuntimeClient(runtime)
    const run = await client.start(Flow.contract, [])

    const snapshot = await settle(run.id, Flow, runtime)

    expect(snapshot.run).toMatchObject({
      status: 'completed',
      output: { values: [], runs: 0 },
    })
    expect((await client.getNode(run.id, 'each'))?.node).toMatchObject({
      status: 'completed',
      input: [],
      output: { items: [] },
    })
    expect(calls).toEqual([])
    expect(callbacks).toEqual({ items: 1, input: [] })
  })

  it('starts at most `concurrency` items at once and lists outputs by index', async () => {
    const { calls, callbacks, Flow } = author({ concurrency: 2 })
    const runtime = createInMemoryWorkflowRuntime()
    const client = createWorkflowRuntimeClient(runtime)
    const { coordinate, execute } = serve(Flow, runtime)
    const run = await client.start(Flow.contract, [5, 4, 3, 2, 1])
    const started: number[] = []

    for (let round = 0; round < 3; round++) {
      await coordinate()
      await execute()
      started.push(calls.length)
    }
    const snapshot = await settle(run.id, Flow, runtime)

    // Two per coordinator pass: an item starts only once a slot is free.
    expect(started).toEqual([2, 4, 5])
    expect(calls).toEqual([5, 4, 3, 2, 1])
    expect(callbacks).toEqual({
      items: 1,
      input: [
        [5, 0],
        [4, 1],
        [3, 2],
        [2, 3],
        [1, 4],
      ],
    })
    expect(snapshot.run.output).toEqual({
      values: [10, 8, 6, 4, 2],
      runs: 5,
    })

    const stored = (await client.getNode(run.id, 'each'))?.node
    // Items are stored encoded, each beside its index and its own run.
    expect(stored?.output).toEqual({
      items: [5, 4, 3, 2, 1].map((item, index) => ({
        item: `${item}`,
        index,
        runId: snapshot.children[index]?.childRunId,
        output: item * 2,
      })),
    })
  })

  it('keeps item order when a retried item finishes last', async () => {
    const { calls, Flow } = author({ retry: { attempts: 2 } }, [7])
    const runtime = createInMemoryWorkflowRuntime()
    const run = await createWorkflowRuntimeClient(runtime).start(
      Flow.contract,
      [7, 8, 9],
    )

    const snapshot = await settle(run.id, Flow, runtime)

    expect(calls).toEqual([7, 8, 9, 7])
    expect(snapshot.run.output).toEqual({ values: [14, 16, 18], runs: 3 })
  })

  it('settles every item before failing, then retries only the failed runs', async () => {
    const { calls, callbacks, Flow } = author({}, [2])
    const runtime = createInMemoryWorkflowRuntime()
    const client = createWorkflowRuntimeClient(runtime)
    const run = await client.start(Flow.contract, [1, 2, 3])

    const failed = await settle(run.id, Flow, runtime)

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

    await client.retry(run.id)
    const retried = await settle(run.id, Flow, runtime)

    expect(retried.run).toMatchObject({
      status: 'completed',
      output: { values: [2, 4, 6], runs: 3 },
    })
    // Only the failed item ran again, in its own run, with its stored input.
    expect(calls).toEqual([1, 2, 3, 2])
    expect(
      retried.children
        .filter(({ nodeName }) => nodeName === 'each')
        .map(({ childRunId }) => childRunId),
    ).toEqual(failed.children.map(({ childRunId }) => childRunId))
    expect(callbacks.items).toBe(1)
    expect(callbacks.input).toHaveLength(3)
  })

  it('starts one child workflow per item', async () => {
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
          input: (read, word, index) =>
            `${index + 1}/${read(w.input).length} ${word}`,
        })

        return (read) =>
          read(shouted)
            .items.map(({ output }) => output)
            .join(', ')
      },
    )
    const runtime = createInMemoryWorkflowRuntime()
    const run = await createWorkflowRuntimeClient(runtime).start(
      Flow.contract,
      ['a', 'b'],
    )

    const snapshot = await settle(run.id, Flow, runtime)

    expect(Flow.workflows).toEqual([Flow.implementation, Shout.implementation])
    expect(snapshot.run.output).toBe('1/2 A, 2/2 B')
    expect(
      runtime
        .inspect()
        .runs.filter(({ name }) => name === 'shout')
        .map(({ input, status }) => [input, status]),
    ).toEqual([
      ['1/2 a', 'completed'],
      ['2/2 b', 'completed'],
    ])
  })
})

describe('experimental node misuse', () => {
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
          items: () => [],
          input: (_read, item) => item,
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
      '[sourceless.step] needs a reference or a deferred callback, received undefined',
    )
    expect(() =>
      workflow({ ...text, name: 'idle' }, function* (w) {
        return yield* w.branch('choice', {
          select: () => 'only',
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
          input: (_read, item: string) => item,
        })
        return w.input
      }),
    ).toThrow(
      '[itemless.each] needs a reference or a deferred callback, received undefined',
    )
    expect(() =>
      workflow({ ...text, name: 'inputless' }, function* (w) {
        // @ts-expect-error A map declares each item's input.
        yield* w.mapTask('each', Echo, { item: Schema.String, items: () => [] })
        return w.input
      }),
    ).toThrow(
      '[inputless.each] needs an input callback for its items, received undefined',
    )
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
            input: (_read, item) => item,
          })
          return w.input
        }),
      ),
    ).toThrow(foreign('inner.each'))
  })

  it.each([
    {
      name: 'a parallel member',
      message:
        'Reference [late.second] is produced after [late.both.one] and cannot be read there',
      build: () =>
        workflow({ ...text, name: 'late' }, function* (w) {
          const later: { ref?: typeof w.input } = {}
          yield* w.parallel('both', {
            members: (p) => ({
              one: p.activity({
                ...echo,
                from: (read) => read(later.ref ?? w.input),
              }),
            }),
          })
          later.ref = yield* w.task('second', Echo, { input: w.input })
          return later.ref
        }),
    },
    {
      name: 'a map item input',
      message:
        'Reference [late.second] is produced after [late.each] and cannot be read there',
      build: () =>
        workflow({ ...text, name: 'late' }, function* (w) {
          const later: { ref?: typeof w.input } = {}
          yield* w.mapTask('each', Echo, {
            item: Schema.String,
            items: (read) => [read(w.input)],
            input: (read) => read(later.ref ?? w.input),
          })
          later.ref = yield* w.task('second', Echo, { input: w.input })
          return later.ref
        }),
    },
  ])(
    'fails the run when $name reads a later step',
    async ({ build, message }) => {
      const Flow = build()
      const runtime = createInMemoryWorkflowRuntime()
      const run = await createWorkflowRuntimeClient(runtime).start(
        Flow.contract,
        'x',
      )

      const snapshot = await settle(run.id, Flow, runtime)

      expect(snapshot.run).toMatchObject({
        status: 'failed',
        error: { message },
      })
    },
  )
})
