import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vitest'

import { defineWorkflow, implementWorkflow } from '../src/effect/index.ts'
import { task, workflow } from '../src/experimental/index.ts'
import { serializeWorkflowGraph } from '../src/inspector/index.ts'
import {
  createInMemoryWorkflowRuntime,
  createWorkflowRuntimeClient,
} from '../src/runtime/index.ts'
import { Billing, Payments } from './fixtures/experimental/billing.ts'
import { settle, shape } from './support/experimental.ts'

const Order = Schema.Struct({
  id: Schema.String,
  mode: Schema.Literals(['manual', 'automatic']),
  cents: Schema.NumberFromString,
})
const Invoice = Schema.Struct({ id: Schema.String, cents: Schema.Number })
const Approval = Schema.Struct({ id: Schema.String, approver: Schema.String })
const Receipt = Schema.Struct({ id: Schema.String, paidBy: Schema.String })
const Notice = Schema.Struct({ to: Schema.String, paidBy: Schema.String })
const Summary = Schema.Struct({ invoice: Schema.String, sent: Schema.String })

/** Authors billing once, logging every handler and deferred callback call. */
function author() {
  const log: [step: string, input?: unknown][] = []

  function logged<Input, Output>(step: string, run: (input: Input) => Output) {
    return (input: Input) =>
      Effect.sync(() => {
        log.push([step, input])
        return run(input)
      })
  }

  const CreateInvoice = task({
    name: 'invoice.create',
    pool: 'billing',
    input: Order,
    output: Invoice,
    handler: logged('invoice', ({ id, cents }) => ({ id: `inv-${id}`, cents })),
  })
  const ChargeCard = task({
    name: 'card.charge',
    pool: 'payments',
    input: Invoice,
    output: Receipt,
    retry: { attempts: 3 },
    timeout: '30s',
    handler: logged('charge', ({ id }) => ({ id, paidBy: 'card' })),
  })
  const RequestApproval = task({
    name: 'approval.request',
    pool: 'billing',
    input: Invoice,
    output: Approval,
    handler: logged('approval', ({ id }) => ({ id, approver: 'finance' })),
  })
  const RecordPayment = task({
    name: 'payment.record',
    pool: 'billing',
    input: Approval,
    output: Receipt,
    handler: logged('record', ({ id, approver }) => ({ id, paidBy: approver })),
  })
  const Notify = task({
    name: 'customer.notify',
    pool: 'billing',
    input: Notice,
    output: Schema.String,
    handler: logged('notify', ({ to, paidBy }) => `${to}:${paidBy}`),
  })

  const Manual = workflow(
    {
      name: 'billing.manual',
      pool: 'billing',
      input: Invoice,
      output: Receipt,
    },
    function* (w) {
      const approval = yield* w.task('approval', RequestApproval, {
        input: w.input,
      })
      return yield* w.task('record', RecordPayment, { input: approval })
    },
  )

  const Root = workflow(
    {
      name: 'billing',
      title: 'Billing',
      pool: 'billing',
      input: Order,
      output: Summary,
      timeout: '1h',
      tags: (order) => ({ order: order.id }),
    },
    function* (w) {
      const invoice = yield* w.task('invoice', CreateInvoice, {
        input: w.input,
        description: 'Prices the order',
      })
      const receipt = yield* w.branch('payment', {
        title: 'Payment',
        select: (read) => {
          log.push(['select'])
          return read(w.input).mode
        },
        cases: (p) => ({
          manual: p.workflow(Manual, {
            input: invoice,
            cancellation: 'detach',
          }),
          automatic: p.task(ChargeCard, {
            input: (read) => {
              log.push(['automatic input'])
              return read(invoice)
            },
            retry: { attempts: 5 },
            timeout: '10s',
          }),
        }),
      })
      const sent = yield* w.task('notify', Notify, {
        input: (read) => ({
          to: read(w.input).id,
          paidBy: read(receipt).paidBy,
        }),
      })

      return (read) => {
        log.push(['result'])
        return { invoice: read(invoice).id, sent: read(sent) }
      }
    },
  )

  return {
    log,
    Root,
    Manual,
    CreateInvoice,
    ChargeCard,
    RequestApproval,
    RecordPayment,
    Notify,
  }
}

describe('experimental workflow authoring', () => {
  it('builds every step and both cases without calling a handler or callback', () => {
    const { log, Root, Manual } = author()

    expect(log).toEqual([])
    expect(serializeWorkflowGraph(Root.contract)).toEqual({
      name: 'billing',
      title: 'Billing',
      nodes: [
        {
          name: 'invoice',
          kind: 'task',
          description: 'Prices the order',
          target: { kind: 'task', name: 'invoice.create' },
        },
        {
          name: 'payment',
          kind: 'branch',
          title: 'Payment',
          cases: [
            {
              key: 'manual',
              kind: 'workflow',
              target: { kind: 'workflow', name: 'billing.manual' },
            },
            {
              key: 'automatic',
              kind: 'task',
              target: { kind: 'task', name: 'card.charge' },
            },
          ],
        },
        {
          name: 'notify',
          kind: 'task',
          target: { kind: 'task', name: 'customer.notify' },
        },
      ],
    })
    expect(serializeWorkflowGraph(Manual.contract).nodes).toEqual([
      {
        name: 'approval',
        kind: 'task',
        target: { kind: 'task', name: 'approval.request' },
      },
      {
        name: 'record',
        kind: 'task',
        target: { kind: 'task', name: 'payment.record' },
      },
    ])
    expect(Root.workflows.map(({ workflow }) => workflow.name)).toEqual([
      'billing',
      'billing.manual',
    ])
    expect(Root.tasks.map(({ task }) => task.name)).toEqual([
      'invoice.create',
      'approval.request',
      'payment.record',
      'card.charge',
      'customer.notify',
    ])
    expect(log).toEqual([])
  })

  it('lowers to what the existing builders produce for the same graph', () => {
    const authored = author()
    const { Root, Manual, CreateInvoice, ChargeCard, Notify } = authored

    const contract = defineWorkflow({
      name: 'billing',
      title: 'Billing',
      input: Order,
      output: Summary,
      timeout: '1h',
      tags: Root.contract.tags,
    })
      .task('invoice', CreateInvoice.contract, {
        description: 'Prices the order',
      })
      .branch('payment', {
        title: 'Payment',
        cases: (helpers) => ({
          manual: helpers.workflow(Manual.contract, { cancellation: 'detach' }),
          automatic: helpers.task(ChargeCard.contract, {
            retry: { attempts: 5 },
            timeout: '10s',
          }),
        }),
      })
      .task('notify', Notify.contract)
      .build()
    const implementation = implementWorkflow(contract, { pool: 'billing' })
      .invoice(CreateInvoice.contract)
      .payment({
        select: (_outputs, order) => order.mode,
        cases: (helpers) => ({
          manual: helpers.workflow(Manual.contract, {
            input: ({ invoice }) => invoice,
          }),
          automatic: helpers.task(ChargeCard.contract, {
            input: ({ invoice }) => invoice,
          }),
        }),
      })
      .notify(Notify.contract, {
        input: ({ payment }, order) => ({
          to: order.id,
          paidBy: payment.paidBy,
        }),
      })
      .finish(({ invoice, notify }) =>
        Effect.succeed({ invoice: invoice.id, sent: notify }),
      )

    expect(Root.contract).toEqual(contract)
    expect(Root.implementation.pool).toBe(implementation.pool)
    // The hand-written chain may omit a mapper the DSL always supplies.
    expect(Root.implementation.nodes.map(shape)).toEqual(
      implementation.nodes.map((node) =>
        node.name === 'invoice' ? { ...node, input: 'function' } : shape(node),
      ),
    )
  })

  it.each([
    {
      mode: 'automatic' as const,
      steps: [
        'invoice',
        'select',
        'automatic input',
        'charge',
        'notify',
        'result',
      ],
      sent: 'o-1:card',
    },
    {
      mode: 'manual' as const,
      steps: ['invoice', 'select', 'approval', 'record', 'notify', 'result'],
      sent: 'o-1:finance',
    },
  ])(
    'runs only the $mode case and wires its result onward',
    async (expected) => {
      const { log, Root } = author()
      const runtime = createInMemoryWorkflowRuntime()
      const client = createWorkflowRuntimeClient(runtime)

      const run = await client.start(Root.contract, {
        id: 'o-1',
        mode: expected.mode,
        cents: 1250,
      })
      const snapshot = await settle(run.id, Root, runtime)

      expect(snapshot.run).toMatchObject({
        status: 'completed',
        // Stored values are the schemas' encodings; handlers saw decoded ones.
        input: { id: 'o-1', mode: expected.mode, cents: '1250' },
        output: { invoice: 'inv-o-1', sent: expected.sent },
        tags: { order: 'o-1' },
      })
      expect(log.map(([step]) => step)).toEqual(expected.steps)
      expect(
        snapshot.nodes.map(({ name, status, selectedCase }) => ({
          name,
          status,
          selectedCase,
        })),
      ).toEqual([
        { name: 'invoice', status: 'completed', selectedCase: undefined },
        { name: 'payment', status: 'completed', selectedCase: expected.mode },
        { name: 'notify', status: 'completed', selectedCase: undefined },
      ])

      const inputs = Object.fromEntries(log)
      const invoice = { id: 'inv-o-1', cents: 1250 }
      expect(inputs.invoice).toEqual({
        id: 'o-1',
        mode: expected.mode,
        cents: 1250,
      })
      if (expected.mode === 'automatic') {
        expect(inputs.charge).toEqual(invoice)
        expect(inputs.notify).toEqual({ to: 'o-1', paidBy: 'card' })
      } else {
        // The child workflow's second step receives its first step's output.
        expect(inputs.approval).toEqual(invoice)
        expect(inputs.record).toEqual({ id: 'inv-o-1', approver: 'finance' })
        expect(inputs.notify).toEqual({ to: 'o-1', paidBy: 'finance' })
      }
    },
  )

  it('runs the documented billing example for both payment modes', async () => {
    const context = Context.make(Payments, {
      charge: (invoice, cents) => Effect.succeed(`card:${invoice}:${cents}`),
    })
    const outputs: unknown[] = []

    for (const mode of ['manual', 'automatic'] as const) {
      const runtime = createInMemoryWorkflowRuntime()
      const run = await createWorkflowRuntimeClient(runtime).start(
        Billing.contract,
        { id: 'o-1', mode, cents: 1250 },
      )
      const snapshot = await settle(run.id, Billing, runtime, context)
      outputs.push(snapshot.run.output)
    }

    expect(outputs).toEqual([
      { order: 'o-1', invoice: 'inv-o-1', paidBy: 'finance' },
      { order: 'o-1', invoice: 'inv-o-1', paidBy: 'card:inv-o-1:1250' },
    ])
  })
})

describe('experimental step policies and failures', () => {
  const Flaky = (attempts: { count: number }, failures: number) =>
    task({
      name: 'flaky',
      pool: 'test',
      input: Schema.String,
      output: Schema.String,
      handler: (input) =>
        Effect.suspend(() =>
          ++attempts.count <= failures
            ? Effect.fail(new Error(`attempt ${attempts.count} failed`))
            : Effect.succeed(input.toUpperCase()),
        ),
    })

  function flow(Step: ReturnType<typeof Flaky>, retry?: { attempts: number }) {
    const after = { count: 0 }
    const After = task({
      name: 'after',
      pool: 'test',
      input: Schema.String,
      output: Schema.String,
      handler: (input) =>
        Effect.sync(() => {
          after.count++
          return input
        }),
    })
    const Flow = workflow(
      {
        name: 'flow',
        pool: 'test',
        input: Schema.String,
        output: Schema.String,
      },
      function* (w) {
        const first = yield* w.branch('first', {
          select: () => 'only',
          cases: (p) => ({ only: p.task(Step, { input: w.input, retry }) }),
        })
        return yield* w.task('after', After, { input: first })
      },
    )
    return { Flow, after }
  }

  it('retries a case under the retry policy its step declares', async () => {
    const attempts = { count: 0 }
    const { Flow, after } = flow(Flaky(attempts, 2), { attempts: 3 })
    const runtime = createInMemoryWorkflowRuntime()
    const run = await createWorkflowRuntimeClient(runtime).start(
      Flow.contract,
      'paid',
    )

    const snapshot = await settle(run.id, Flow, runtime)

    expect(snapshot.run).toMatchObject({ status: 'completed', output: 'PAID' })
    expect(attempts.count).toBe(3)
    expect(after.count).toBe(1)
  })

  it('fails the run and skips later steps once a step exhausts its attempts', async () => {
    const attempts = { count: 0 }
    const { Flow, after } = flow(Flaky(attempts, 1))
    const runtime = createInMemoryWorkflowRuntime()
    const run = await createWorkflowRuntimeClient(runtime).start(
      Flow.contract,
      'paid',
    )

    const snapshot = await settle(run.id, Flow, runtime)

    expect(snapshot.run.status).toBe('failed')
    expect(snapshot.nodes.map(({ name, status }) => [name, status])).toEqual([
      ['first', 'failed'],
    ])
    expect(attempts.count).toBe(1)
    expect(after.count).toBe(0)
  })

  it('serves a task once however many steps use it', async () => {
    const Echo = task({
      name: 'echo',
      pool: 'test',
      input: Schema.String,
      output: Schema.String,
      handler: (input) => Effect.succeed(`${input}!`),
    })
    const Twice = workflow(
      {
        name: 'twice',
        pool: 'test',
        input: Schema.String,
        output: Schema.String,
      },
      function* (w) {
        const once = yield* w.task('once', Echo, { input: w.input })
        return yield* w.task('again', Echo, { input: once })
      },
    )
    const runtime = createInMemoryWorkflowRuntime()
    const run = await createWorkflowRuntimeClient(runtime).start(
      Twice.contract,
      'hi',
    )

    expect(Twice.tasks).toEqual([Echo.implementation])
    expect((await settle(run.id, Twice, runtime)).run.output).toBe('hi!!')
  })
})

describe('experimental authoring misuse', () => {
  const Echo = task({
    name: 'echo',
    pool: 'test',
    input: Schema.String,
    output: Schema.String,
    handler: (input) => Effect.succeed(input),
  })
  const options = {
    pool: 'test',
    input: Schema.String,
    output: Schema.String,
  }

  it('rejects a step name the workflow already uses', () => {
    expect(() =>
      workflow({ ...options, name: 'duplicate' }, function* (w) {
        yield* w.task('step', Echo, { input: w.input })
        return yield* w.task('step', Echo, { input: w.input })
      }),
    ).toThrow('Duplicate workflow node name: step')
  })

  it('rejects step names and case keys the engine reserves', () => {
    expect(() =>
      workflow({ ...options, name: 'reserved' }, function* (w) {
        return yield* w.task('input', Echo, { input: w.input })
      }),
    ).toThrow('Workflow node name cannot be "input"')
    expect(() =>
      workflow({ ...options, name: 'reserved' }, function* (w) {
        return yield* w.branch('choice', {
          select: () => 'constructor',
          cases: (p) => ({ constructor: p.task(Echo, { input: w.input }) }),
        })
      }),
    ).toThrow('Workflow branch case key cannot be "constructor": choice')
  })

  it('rejects a computed `__proto__` case key without calling its handler', () => {
    let calls = 0

    // Only a computed key makes `__proto__` an own property of the literal.
    expect(() =>
      workflow({ ...options, name: 'reserved' }, function* (w) {
        return yield* w.branch('choice', {
          select: () => '__proto__',
          cases: (p) => ({
            ['__proto__']: p.activity({
              input: Schema.String,
              output: Schema.String,
              from: w.input,
              handler: (input) => Effect.sync(() => `${input}:${++calls}`),
            }),
          }),
        })
      }),
    ).toThrow('Workflow branch case key cannot be "__proto__": choice')
    expect(calls).toBe(0)
  })

  it('rejects a plan yielded twice', () => {
    expect(() =>
      workflow({ ...options, name: 'reused' }, function* (w) {
        const plan = w.task('step', Echo, { input: w.input })
        yield* plan
        return yield* plan
      }),
    ).toThrow('Plan [reused.step] was already yielded')
  })

  it('rejects a plan that was created and never yielded', () => {
    expect(() =>
      workflow({ ...options, name: 'dropped' }, function* (w) {
        w.task('forgotten', Echo, { input: w.input })
        return yield* w.task('step', Echo, { input: w.input })
      }),
    ).toThrow('Workflow [dropped] never yielded its plans: forgotten')
  })

  it('rejects a plan yielded without delegation, which returns no reference', () => {
    expect(() =>
      workflow({ ...options, name: 'bare' }, function* (w) {
        yield w.task('step', Echo, { input: w.input })
        return w.input
      }),
    ).toThrow('Plan [bare.step] must be yielded with yield*')
  })

  it('rejects anything yielded that is not one of its plans', () => {
    expect(() =>
      // @ts-expect-error Only plans can be yielded.
      workflow({ ...options, name: 'foreign' }, function* (w) {
        yield Effect.succeed(1)
        return w.input
      }),
    ).toThrow('Workflow [foreign] can only yield plans created by its builder')
  })

  it('rejects plans and references that belong to another workflow', () => {
    expect(() =>
      workflow({ ...options, name: 'outer' }, function* (outer) {
        const first = yield* outer.task('first', Echo, { input: outer.input })
        workflow({ ...options, name: 'inner' }, function* (inner) {
          return yield* inner.task('step', Echo, { input: first })
        })
        return first
      }),
    ).toThrow(
      'Reference [outer.first] belongs to another workflow and cannot be read in [inner.step]',
    )
    expect(() =>
      workflow({ ...options, name: 'outer' }, function* (outer) {
        const step = outer.task('step', Echo, { input: outer.input })
        workflow({ ...options, name: 'inner' }, function* (inner) {
          yield* step
          return inner.input
        })
        return yield* step
      }),
    ).toThrow(
      'Plan [outer.step] belongs to another workflow and cannot be yielded in [inner]',
    )
    expect(() =>
      workflow({ ...options, name: 'outer' }, function* (outer) {
        const first = yield* outer.task('first', Echo, { input: outer.input })
        workflow({ ...options, name: 'inner' }, function* (inner) {
          yield* inner.task('step', Echo, { input: inner.input })
          return first
        })
        return first
      }),
    ).toThrow(
      'Reference [outer.first] belongs to another workflow and cannot be read in [inner result]',
    )
  })

  it('rejects a step without an input and a workflow without a result', () => {
    expect(() =>
      workflow({ ...options, name: 'inputless' }, function* (w) {
        // @ts-expect-error Every step declares its input.
        return yield* w.task('step', Echo, {})
      }),
    ).toThrow(
      '[inputless.step] needs a reference or a deferred callback, received undefined',
    )
    expect(() =>
      // @ts-expect-error A workflow returns its result.
      workflow({ ...options, name: 'resultless' }, function* (w) {
        yield* w.task('step', Echo, { input: w.input })
      }),
    ).toThrow(
      '[resultless result] needs a reference or a deferred callback, received undefined',
    )
  })

  it('rejects a branch case that was not built by the cases builder', () => {
    expect(() =>
      workflow({ ...options, name: 'rooted' }, function* (w) {
        yield* w.branch('choice', {
          select: () => 'only',
          // @ts-expect-error A step plan is not a case plan.
          cases: () => ({ only: w.task('step', Echo, { input: w.input }) }),
        })
        return w.input
      }),
    ).toThrow(
      'Branch case [rooted.choice.only] must be built with the cases builder',
    )
  })

  it('keeps case plans out of the sequence unless a branch holds them', () => {
    const Cased = workflow({ ...options, name: 'cased' }, function* (w) {
      return yield* w.branch('choice', {
        select: () => 'left',
        cases: (p) => {
          const shared = p.task(Echo, { input: w.input })
          return { left: shared, right: shared }
        },
      })
    })

    expect(Cased.contract.nodes.map(({ name }) => name)).toEqual(['choice'])
    expect(Cased.tasks).toEqual([Echo.implementation])
  })

  it.each([
    {
      name: 'a later step',
      message:
        'Reference [late.second] is produced after [late.first] and cannot be read there',
      build: () =>
        workflow({ ...options, name: 'late' }, function* (w) {
          const later: { ref?: typeof w.input } = {}
          yield* w.task('first', Echo, {
            input: (read) => read(later.ref ?? w.input),
          })
          later.ref = yield* w.task('second', Echo, { input: w.input })
          return later.ref
        }),
    },
    {
      name: 'another workflow',
      message:
        'Reference [parent.first] belongs to another workflow and cannot be read in [child.step]',
      build: () =>
        workflow({ ...options, name: 'parent' }, function* (w) {
          const first = yield* w.task('first', Echo, { input: w.input })
          const Child = workflow({ ...options, name: 'child' }, function* (c) {
            return yield* c.task('step', Echo, {
              input: (read) => read(first),
            })
          })
          return yield* w.workflow('child', Child, { input: first })
        }),
    },
  ])(
    'fails the run when a deferred callback reads a reference of $name',
    async ({ build, message }) => {
      const Flow = build()
      const runtime = createInMemoryWorkflowRuntime()
      const run = await createWorkflowRuntimeClient(runtime).start(
        Flow.contract,
        'x',
      )

      const snapshot = await settle(run.id, Flow, runtime)

      expect(snapshot.run.status).toBe('failed')
      const failed = runtime
        .inspect()
        .runs.find(({ error }) => error?.message === message)
      expect(failed?.error?.message).toBe(message)
    },
  )
})
