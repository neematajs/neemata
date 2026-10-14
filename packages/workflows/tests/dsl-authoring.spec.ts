import { describe, expect, it } from '@effect/vitest'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

import { task, workflow } from '../src/dsl/index.ts'
import { serializeWorkflowGraph } from '../src/graph/index.ts'
import { serve, shape } from './dsl-support.ts'
import { Billing, Payments } from './fixtures/billing.ts'

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

/** Authors billing once, logging every handler call and computed value. */
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
        select: Effect.map(w.input, (order) => {
          log.push(['select'])
          return order.mode
        }),
        cases: (p) => ({
          manual: p.workflow(Manual, {
            input: invoice,
            cancellation: 'detach',
          }),
          automatic: p.task(ChargeCard, {
            input: Effect.tap(invoice, () =>
              Effect.sync(() => log.push(['automatic input'])),
            ),
            retry: { attempts: 5 },
            timeout: '10s',
          }),
        }),
      })
      const sent = yield* w.task('notify', Notify, {
        input: Effect.all({ order: w.input, receipt }).pipe(
          Effect.map(({ order, receipt }) => ({
            to: order.id,
            paidBy: receipt.paidBy,
          })),
        ),
      })

      return Effect.gen(function* () {
        log.push(['result'])
        return { invoice: (yield* invoice).id, sent: yield* sent }
      })
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

describe('workflow authoring', () => {
  it('builds every step and both cases without calling a handler or computing a value', () => {
    const { log, Root, Manual } = author()

    expect(log).toEqual([])
    expect(serializeWorkflowGraph(Root)).toEqual({
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
    expect(serializeWorkflowGraph(Manual).nodes).toEqual([
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
    expect(Root.workflows.map(({ name }) => name)).toEqual([
      'billing',
      'billing.manual',
    ])
    expect(Root.tasks.map(({ name }) => name)).toEqual([
      'invoice.create',
      'approval.request',
      'payment.record',
      'card.charge',
      'customer.notify',
    ])
    // Everything a worker must serve, each once: the workflows, then the tasks.
    expect(Root.programs).toEqual([
      Root.program,
      Manual.program,
      ...Root.tasks.map(({ program }) => program),
    ])
    expect(log).toEqual([])
  })

  it('builds the program the engine runs, with every policy where the engine reads it', () => {
    const { Root, Manual, ChargeCard } = author()

    expect(shape(Root.program)).toEqual({
      kind: 'workflow',
      name: 'billing',
      timeout: '1h',
      steps: [
        {
          name: 'invoice',
          kind: 'task',
          task: { name: 'invoice.create' },
          input: 'function',
        },
        {
          name: 'payment',
          kind: 'branch',
          select: 'function',
          cases: {
            manual: {
              kind: 'workflow',
              workflow: { name: 'billing.manual' },
              cancellation: 'detach',
              input: 'function',
            },
            automatic: {
              kind: 'task',
              task: { name: 'card.charge' },
              retry: { attempts: 5 },
              timeout: '10s',
              input: 'function',
            },
          },
        },
        {
          name: 'notify',
          kind: 'task',
          task: { name: 'customer.notify' },
          input: 'function',
        },
      ],
      result: 'function',
    })
    expect(shape(Manual.program)).toEqual({
      kind: 'workflow',
      name: 'billing.manual',
      steps: [
        {
          name: 'approval',
          kind: 'task',
          task: { name: 'approval.request' },
          input: 'function',
        },
        {
          name: 'record',
          kind: 'task',
          task: { name: 'payment.record' },
          input: 'function',
        },
      ],
      result: 'function',
    })
    // A task's own limits are its program's; a step's replace them per run.
    expect(shape(ChargeCard.program)).toEqual({
      kind: 'task',
      name: 'card.charge',
      retry: { attempts: 3 },
      timeout: '30s',
      execute: 'function',
    })
    // What is applied when a run starts is carried as it was declared.
    expect(Root).toMatchObject({
      kind: 'workflow',
      name: 'billing',
      title: 'Billing',
      pool: 'billing',
      timeout: '1h',
    })
    expect(Root.tags?.({ id: 'o-1', mode: 'manual', cents: 1 })).toEqual({
      order: 'o-1',
    })
    expect(ChargeCard).toMatchObject({ kind: 'task', pool: 'payments' })
  })

  it.effect.each([
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
  ])('runs only the $mode case and wires its result onward', (expected) =>
    Effect.gen(function* () {
      const { log, Root } = author()

      const records = yield* serve(Root.programs).run(Root, {
        id: 'o-1',
        mode: expected.mode,
        cents: 1250,
      })

      expect(records.run).toMatchObject({
        status: 'completed',
        // Stored values are the schemas' encodings; handlers saw decoded ones.
        input: { id: 'o-1', mode: expected.mode, cents: '1250' },
        output: { invoice: 'inv-o-1', sent: expected.sent },
      })
      expect(log.map(([step]) => step)).toEqual(expected.steps)
      expect(
        records.nodes.map(({ name, status, selectedCase }) => ({
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
    }),
  )

  it.effect('computes values with ordinary Effect combinators', () =>
    Effect.gen(function* () {
      const Pair = Schema.Struct({
        left: Schema.String,
        right: Schema.NumberFromString,
      })
      const Shout = task({
        name: 'shout',
        pool: 'test',
        input: Schema.String,
        output: Schema.String,
        handler: (input) => Effect.succeed(input.toUpperCase()),
      })
      const Join = task({
        name: 'join',
        pool: 'test',
        input: Pair,
        output: Schema.String,
        handler: ({ left, right }) => Effect.succeed(`${left}${right}`),
      })
      const Flow = workflow(
        { name: 'combined', pool: 'test', input: Pair, output: Schema.String },
        function* (w) {
          const left = yield* w.task('left', Shout, {
            input: Effect.map(w.input, (pair) => pair.left),
          })
          const joined = yield* w.task('join', Join, {
            input: Effect.all({
              left,
              right: Effect.map(w.input, (pair) => pair.right * 2),
            }),
          })

          return Effect.gen(function* () {
            const pair = yield* w.input
            return `${pair.left}:${yield* joined}`
          })
        },
      )

      const records = yield* serve(Flow.programs).run(Flow, {
        left: 'a',
        right: 2,
      })

      // `map` shouts the left, `all` joins it to the doubled right, `gen` reads
      // the input again beside the last step.
      expect(records.run).toMatchObject({ status: 'completed', output: 'a:A4' })
    }),
  )

  it.effect('runs the documented billing example for both payment modes', () =>
    Effect.gen(function* () {
      const context = Context.make(Payments, {
        charge: (invoice, cents) => Effect.succeed(`card:${invoice}:${cents}`),
      })
      const outputs: unknown[] = []

      for (const mode of ['manual', 'automatic'] as const) {
        const records = yield* serve(Billing.programs, context).run(Billing, {
          id: 'o-1',
          mode,
          cents: 1250,
        })
        outputs.push(records.run.output)
      }

      expect(outputs).toEqual([
        { order: 'o-1', invoice: 'inv-o-1', paidBy: 'finance' },
        { order: 'o-1', invoice: 'inv-o-1', paidBy: 'card:inv-o-1:1250' },
      ])
    }),
  )
})

describe('step policies and failures', () => {
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
          select: Effect.succeed('only' as const),
          cases: (p) => ({ only: p.task(Step, { input: w.input, retry }) }),
        })
        return yield* w.task('after', After, { input: first })
      },
    )
    return { Flow, after }
  }

  it.effect('retries a case under the retry policy its step declares', () =>
    Effect.gen(function* () {
      const attempts = { count: 0 }
      const { Flow, after } = flow(Flaky(attempts, 2), { attempts: 3 })

      const records = yield* serve(Flow.programs).run(Flow, 'paid')

      expect(records.run).toMatchObject({ status: 'completed', output: 'PAID' })
      expect(attempts.count).toBe(3)
      expect(after.count).toBe(1)
    }),
  )

  it.effect(
    'fails the run and skips later steps once a step exhausts its attempts',
    () =>
      Effect.gen(function* () {
        const attempts = { count: 0 }
        const { Flow, after } = flow(Flaky(attempts, 1))

        const records = yield* serve(Flow.programs).run(Flow, 'paid')

        expect(records.run).toMatchObject({
          status: 'failed',
          error: { message: 'attempt 1 failed' },
        })
        expect(records.nodes.map(({ name, status }) => [name, status])).toEqual(
          [['first', 'failed']],
        )
        expect(attempts.count).toBe(1)
        expect(after.count).toBe(0)
      }),
  )

  it.effect('serves a task once however many steps use it', () =>
    Effect.gen(function* () {
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

      expect(Twice.tasks).toEqual([Echo])
      expect(Twice.programs).toEqual([Twice.program, Echo.program])
      const records = yield* serve(Twice.programs).run(Twice, 'hi')
      expect(records.run.output).toBe('hi!!')
    }),
  )
})

describe('authoring misuse', () => {
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
          select: Effect.succeed('constructor' as const),
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
          select: Effect.succeed('__proto__' as const),
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

  it('rejects a reference yielded in the body, where no run has a value for it', () => {
    expect(() =>
      // @ts-expect-error A reference is read inside an Effect, not in the body.
      workflow({ ...options, name: 'unwrapped' }, function* (w) {
        const first = yield* w.task('first', Echo, { input: w.input })
        const value = yield* first
        return Effect.succeed(value)
      }),
    ).toThrow(
      'Workflow [unwrapped] can only yield plans created by its builder',
    )
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
      '[inputless.step] needs a reference or an Effect computed from references, received undefined',
    )
    expect(() =>
      // @ts-expect-error A workflow returns its result.
      workflow({ ...options, name: 'resultless' }, function* (w) {
        yield* w.task('step', Echo, { input: w.input })
      }),
    ).toThrow(
      '[resultless result] needs a reference or an Effect computed from references, received undefined',
    )
  })

  it('rejects a branch case that was not built by the cases builder', () => {
    expect(() =>
      workflow({ ...options, name: 'rooted' }, function* (w) {
        yield* w.branch('choice', {
          select: Effect.succeed('only' as const),
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
        select: Effect.succeed('left' as const),
        cases: (p) => {
          const shared = p.task(Echo, { input: w.input })
          return { left: shared, right: shared }
        },
      })
    })

    expect(Cased.steps.map(({ name }) => name)).toEqual(['choice'])
    expect(Cased.tasks).toEqual([Echo])
  })

  it.effect.each([
    {
      name: 'a later step',
      message:
        'Reference [late.second] is produced after [late.first] and cannot be read there',
      build: () =>
        workflow({ ...options, name: 'late' }, function* (w) {
          // Built before `second` exists, so only a run can tell.
          yield* w.task('first', Echo, {
            input: Effect.suspend(() => second),
          })
          const second = yield* w.task('second', Echo, { input: w.input })
          return second
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
              input: Effect.map(first, (value) => value),
            })
          })
          return yield* w.workflow('child', Child, { input: first })
        }),
    },
  ])(
    'fails the run when a computed value reads a reference of $name',
    ({ build, message }) =>
      Effect.gen(function* () {
        const Flow = build()
        const engine = serve(Flow.programs)

        const records = yield* engine.run(Flow, 'x')

        expect(records.run).toMatchObject({
          status: 'failed',
          error: { message },
        })
      }),
  )

  it.effect.each([
    {
      name: 'a selector that sleeps',
      label: 'waiting.choice',
      build: () =>
        workflow({ ...options, name: 'waiting' }, function* (w) {
          return yield* w.branch('choice', {
            select: Effect.as(Effect.sleep('1 millis'), 'only' as const),
            cases: (p) => ({ only: p.task(Echo, { input: w.input }) }),
          })
        }),
    },
    {
      name: 'an input that awaits a promise',
      label: 'waiting.step',
      build: () =>
        workflow({ ...options, name: 'waiting' }, function* (w) {
          return yield* w.task('step', Echo, {
            input: Effect.promise(() => Promise.resolve('late')),
          })
        }),
    },
  ])('fails the run on $name: the coordinator cannot wait', (waiting) =>
    Effect.gen(function* () {
      // Nothing here is a type error: an Effect does not say whether it waits.
      const Flow = waiting.build()

      const records = yield* serve(Flow.programs).run(Flow, 'x')

      expect(records.run).toMatchObject({
        status: 'failed',
        error: {
          message: `[${waiting.label}] is computed in the coordinator and cannot wait: asynchronous work belongs in a task or an activity`,
        },
      })
    }),
  )

  it.effect('stops the computation it refused for waiting', () =>
    Effect.gen(function* () {
      let stopped = false
      const Flow = workflow({ ...options, name: 'waiting' }, function* (w) {
        return yield* w.task('step', Echo, {
          input: Effect.never.pipe(
            Effect.onInterrupt(() =>
              Effect.sync(() => {
                stopped = true
              }),
            ),
          ),
        })
      })

      const records = yield* serve(Flow.programs).run(Flow, 'x')

      expect(records.run.status).toBe('failed')
      // Left alone it would wait on, and go on, beside the run it failed.
      expect(stopped).toBe(true)
    }),
  )
})
