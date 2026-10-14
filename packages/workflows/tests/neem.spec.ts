import { MessageChannel } from 'node:worker_threads'

import { describe, expect, it } from '@effect/vitest'
import * as Cause from 'effect/Cause'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import { onTestFinished, vi } from 'vitest'

import type { WorkerData, WorkflowsPlan } from '../src/neem/index.ts'
import type { WorkerContext } from '../src/neem/worker.ts'
import {
  CleanupTimeout,
  Client,
  InMemory,
  schedule,
  Store,
  task,
  workflow,
} from '../src/index.ts'
import { defineWorkflowsPlanner } from '../src/neem/index.ts'
import { defineWorkflowsWorker } from '../src/neem/worker.ts'
import {
  Billing,
  ChargeCard,
  CreateInvoice,
  ManualBilling,
  Payments,
  RecordPayment,
  RequestApproval,
} from './fixtures/billing.ts'

const billing = {
  workflows: [Billing, ManualBilling],
  tasks: [CreateInvoice, ChargeCard, RequestApproval, RecordPayment],
}
const payments = Layer.succeed(Payments, {
  charge: (invoice, cents) => Effect.succeed(`card for ${invoice}: ${cents}`),
})

const io = { pool: 'io', input: Schema.String, output: Schema.String }
// Workers wait on a real clock here, as they do in a thread.
const fast = { pollMs: 5 }

const levels = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const
function logger() {
  const calls = Object.fromEntries(levels.map((level) => [level, vi.fn()]))
  return {
    calls,
    logger: calls as unknown as WorkerContext['logger'],
  }
}

const plan = async (layout: WorkflowsPlan) => {
  const planned = await defineWorkflowsPlanner(() => layout)({
    mode: 'production',
    name: 'workflows',
    logger: logger().logger,
  })
  return planned.workers as Record<
    'coordinator' | 'execution',
    readonly WorkerData[]
  >
}

/** One worker thread's runtime, as Neem would create it from its data. */
async function thread(
  worker: ReturnType<typeof defineWorkflowsWorker>,
  data: WorkerData,
  log = logger().logger,
) {
  const { port1, port2 } = new MessageChannel()
  const runtime = await worker.createRuntime({
    mode: 'production',
    name: `workflows:${data.role}:0`,
    data,
    logger: log,
    definition: undefined,
    port: port1,
  })
  const finished = Promise.resolve(runtime.finished)
  // Neem observes it only once the worker is ready.
  void finished.catch(() => {})
  const thread = {
    finished,
    start: async () => await runtime.start(),
    stop: async () => await runtime.stop(),
  }
  onTestFinished(async () => {
    await thread.stop().catch(() => {})
    port1.close()
    port2.close()
  })
  return thread
}

/** A store every runtime of a test shares, as threads share a database. */
function shared() {
  const memory = InMemory.makeInMemoryStore()
  const acquired = vi.fn()
  const released = vi.fn()
  const store = () =>
    Layer.effect(
      Store,
      Effect.acquireRelease(
        Effect.sync(() => {
          acquired()
          return memory.store
        }),
        () => Effect.sync(released),
      ),
    )
  const run = <A, E>(effect: Effect.Effect<A, E, Store>) =>
    Effect.runPromise(Effect.provideService(effect, Store, memory.store))
  return { inspect: memory.inspect, store, acquired, released, run }
}

async function eventually<A>(
  read: () => A | undefined | Promise<A | undefined>,
) {
  return await vi.waitFor(
    async () => {
      const value = await read()
      if (value === undefined) throw new Error('Not yet')
      return value
    },
    { timeout: 5_000, interval: 5 },
  )
}

const coordinator: WorkerData = {
  role: 'coordinator',
  options: fast,
  pools: ['io'],
}
const execution: WorkerData = {
  role: 'execution',
  pool: 'io',
  options: fast,
  pools: ['io'],
}

describe('the workflows planner', () => {
  it('plans the coordinator and pool threads with their options', async () => {
    const pools = ['io', 'pdf']
    const pdf = {
      role: 'execution',
      pool: 'pdf',
      options: { concurrency: 1, cleanupTimeoutMs: 1_000 },
      pools,
    }
    const coordinator = {
      role: 'coordinator',
      options: {
        concurrency: 3,
        reaping: false,
        runTimeouts: { everyMs: 5_000 },
      },
      pools,
    }

    expect(
      await plan({
        coordinator: {
          threads: 2,
          concurrency: 3,
          reaping: false,
          runTimeouts: { everyMs: 5_000 },
        },
        pools: {
          io: {},
          pdf: { threads: 2, concurrency: 1, cleanupTimeoutMs: 1_000 },
        },
      }),
    ).toStrictEqual({
      coordinator: [coordinator, coordinator],
      execution: [
        { role: 'execution', pool: 'io', options: {}, pools },
        pdf,
        pdf,
      ],
    })
  })

  it('plans one coordinator when none is described', async () => {
    expect((await plan({ pools: { io: {} } })).coordinator).toStrictEqual([
      { role: 'coordinator', options: {}, pools: ['io'] },
    ])
  })

  it('requires the execution pools to be declared', async () => {
    await expect(plan({ pools: {} })).rejects.toThrow(
      'Workflows planner must declare at least one execution pool',
    )
    await expect(plan({ pools: { '': {} } })).rejects.toThrow(
      'Workflows execution pool requires a name',
    )
  })

  it('plans data that Neem can copy to its threads', async () => {
    const coordinator = {
      scheduling: { everyMs: 500, batchSize: 10 },
      retention: { olderThan: '30d', statuses: ['completed'] },
    } as const
    const planned = await plan({ coordinator, pools: { io: {} } })

    expect(structuredClone(planned)).toStrictEqual(planned)
    expect(planned.coordinator).toStrictEqual([
      { role: 'coordinator', options: coordinator, pools: ['io'] },
    ])
  })

  it('takes no schedules: they are declarations, and the worker`s', async () => {
    const Tick = task({ ...io, name: 'neem.tick', handler: Effect.succeed })
    const schedules = [
      schedule({ name: 'tick', runnable: Tick, input: 'a', every: '1h' }),
    ]
    await expect(
      plan({
        // @ts-expect-error A plan is data; a schedule holds schemas.
        coordinator: { schedules },
        pools: { io: {} },
      }),
    ).rejects.toThrow(
      'Workflows planner takes no schedules: register them with defineWorkflowsWorker({ schedules })',
    )
  })

  it('rejects thread counts that are not positive integers', async () => {
    await expect(
      plan({ coordinator: { threads: 0 }, pools: { io: {} } }),
    ).rejects.toThrow(
      'Invalid workflows worker thread count for coordinator: expected positive integer, received 0',
    )
    await expect(plan({ pools: { pdf: { threads: 1.5 } } })).rejects.toThrow(
      'Invalid workflows worker thread count for execution pool [pdf]: expected positive integer, received 1.5',
    )
  })
})

describe('a workflows worker', () => {
  it('runs a workflow across the planned coordinator and pool threads', async () => {
    const { store, acquired, released, run } = shared()
    const provided = vi.fn()
    const withdrawn = vi.fn()
    const worker = defineWorkflowsWorker({
      ...billing,
      store,
      layer: () =>
        Layer.merge(
          payments,
          // Built on the store, which is there before it and after it.
          Layer.effectDiscard(
            Effect.acquireRelease(
              Effect.map(Effect.service(Store), provided),
              () => Effect.map(Effect.service(Store), withdrawn),
            ),
          ),
        ),
    })
    const workers = await plan({
      coordinator: fast,
      pools: { billing: fast, payments: fast },
    })
    const runtimes = await Promise.all(
      [...workers.coordinator, ...workers.execution].map((data) =>
        thread(worker, data),
      ),
    )
    await Promise.all(runtimes.map((runtime) => runtime.start()))

    const started = await run(
      Client.start(Billing, { id: 'o-2', mode: 'automatic', cents: 900 }),
    )
    const done = await eventually(async () => {
      const records = await run(Client.get(started.id))
      return records?.run.status === 'completed' ? records.run : undefined
    })
    // ChargeCard ran on the `payments` thread, with the layer's Payments.
    expect(done.output).toStrictEqual({
      order: 'o-2',
      invoice: 'inv-o-2',
      paidBy: 'card for inv-o-2: 900',
    })

    await Promise.all(runtimes.map((runtime) => runtime.stop()))
    for (const { finished } of runtimes) {
      await expect(finished).resolves.toBeUndefined()
    }
    expect(acquired).toHaveBeenCalledTimes(3)
    expect(released).toHaveBeenCalledTimes(3)
    // A coordinator runs no handler, so it builds none of their services.
    expect(provided).toHaveBeenCalledTimes(2)
    expect(withdrawn).toHaveBeenCalledTimes(2)
  })

  it('runs in a pool`s thread only what is declared for that pool', async () => {
    const { store, run, inspect } = shared()
    const worker = defineWorkflowsWorker({
      ...billing,
      store,
      layer: () => payments,
    })
    const pools = ['billing', 'payments']
    for (const data of [
      { ...coordinator, pools },
      { ...execution, pool: 'billing', pools },
    ]) {
      await (await thread(worker, data)).start()
    }

    const started = await run(
      Client.start(Billing, { id: 'o-3', mode: 'automatic', cents: 100 }),
    )
    const charge = () =>
      inspect.queue().find(({ command }) => command.kind === 'runTask')
    await eventually(charge)

    // ChargeCard is of `payments`: no thread here takes it, however long.
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(charge()).toMatchObject({
      command: { name: 'billing.charge' },
      deliveries: 0,
    })
    expect(charge()!.claim).toBeUndefined()
    expect((await run(Client.get(started.id)))!.run.status).toBe('waiting')
  })

  it('reconciles and fires the schedules it is given, in its coordinator', async () => {
    const { store, run } = shared()
    const Tick = task({
      ...io,
      name: 'neem.tick',
      handler: (text) => Effect.succeed(`${text}!`),
    })
    const worker = defineWorkflowsWorker({
      tasks: [Tick],
      schedules: [
        schedule({
          name: 'tick',
          runnable: Tick,
          input: 'tock',
          every: '1h',
          immediately: true,
        }),
      ],
      store,
    })
    // As Neem hands a plan to its threads: copied.
    const workers = structuredClone(
      await plan({
        coordinator: { ...fast, scheduling: { everyMs: 5 } },
        pools: { io: fast },
      }),
    )
    for (const data of [...workers.coordinator, ...workers.execution]) {
      await (await thread(worker, data)).start()
    }

    expect(await run(Client.schedules.list())).toMatchObject([
      { name: 'tick', runnable: { kind: 'task', name: 'neem.tick' } },
    ])
    const fired = await eventually(async () => {
      const { runs } = await run(Client.list({ tags: { schedule: 'tick' } }))
      return runs[0]?.status === 'completed' ? runs : undefined
    })
    expect(fired).toMatchObject([{ input: 'tock', output: 'tock!' }])
  })

  it('refuses a pool the planner did not declare, before acquiring anything', async () => {
    const { store, acquired } = shared()
    const worker = defineWorkflowsWorker({
      ...billing,
      store,
      layer: () => payments,
    })
    const [data] = (await plan({ pools: { billing: {}, paymnets: {} } }))
      .execution

    await expect((await thread(worker, data!)).start()).rejects.toThrow(
      'Execution pools [payments] named by declarations are not declared',
    )
    expect(acquired).not.toHaveBeenCalled()
  })

  it('refuses a schedule of what none of its threads serves', async () => {
    const { store, acquired } = shared()
    const worker = defineWorkflowsWorker({
      workflows: [ManualBilling],
      tasks: [RequestApproval, RecordPayment],
      schedules: [
        schedule({
          name: 'invoices',
          runnable: CreateInvoice,
          input: { id: 'o-1', mode: 'manual', cents: 500 },
          every: '1d',
        }),
      ],
      store,
    })

    // It would fire, and queue a run that no route can claim.
    for (const data of [coordinator, execution]) {
      await expect(
        (await thread(worker, { ...data, pools: ['billing'] })).start(),
      ).rejects.toThrow(
        'Tasks [billing.invoice] referenced by schedules are not registered',
      )
    }
    expect(acquired).not.toHaveBeenCalled()
  })

  it('refuses a registry that lacks what its workflows start', async () => {
    const { store, acquired } = shared()
    const worker = defineWorkflowsWorker({
      workflows: [ManualBilling],
      tasks: [RequestApproval],
      store,
    })

    for (const data of [coordinator, execution]) {
      await expect(
        (await thread(worker, { ...data, pools: ['billing'] })).start(),
      ).rejects.toThrow(
        'Tasks [billing.record] referenced by registered workflows are not registered',
      )
    }
    expect(acquired).not.toHaveBeenCalled()
  })

  it('takes a declaration listed twice once, and refuses a copy of it', async () => {
    const { store } = shared()
    const echo = () =>
      task({
        ...io,
        name: 'neem.echo',
        handler: (text) => Effect.succeed(text),
      })
    const Echo = echo()

    const listedTwice = await thread(
      defineWorkflowsWorker({ tasks: [Echo, Echo], store }),
      execution,
    )
    await expect(listedTwice.start()).resolves.toStrictEqual([])

    const copied = await thread(
      defineWorkflowsWorker({ tasks: [Echo, echo()], store }),
      execution,
    )
    await expect(copied.start()).rejects.toThrow(
      'Declarations [task:neem.echo] are registered more than once',
    )
  })

  it('rejects invalid options before acquiring anything', async () => {
    const { store, acquired } = shared()
    const worker = defineWorkflowsWorker({ store })

    await expect(
      (
        await thread(worker, { ...coordinator, options: { concurrency: 0 } })
      ).start(),
    ).rejects.toThrow('Worker concurrency must be a positive integer')
    await expect(
      (
        await thread(worker, {
          ...coordinator,
          options: { reaping: { everyMs: 0 } },
        })
      ).start(),
    ).rejects.toThrow('Worker reaping everyMs must be positive')
    await expect(
      (
        await thread(worker, {
          ...execution,
          options: { cleanupTimeoutMs: -1 },
        })
      ).start(),
    ).rejects.toThrow(
      'Worker cleanupTimeoutMs must be a finite non-negative number',
    )
    expect(acquired).not.toHaveBeenCalled()
  })

  it('refuses to run without the data of its planner', async () => {
    const { store, acquired } = shared()
    const worker = defineWorkflowsWorker({ store })

    // What the Effect preset's own planner gives every worker.
    await expect(
      (await thread(worker, {} as WorkerData)).start(),
    ).rejects.toThrow('needs a planner made with defineWorkflowsPlanner')
    expect(acquired).not.toHaveBeenCalled()
  })

  it('stops by interrupting its handlers and giving their commands back', async () => {
    const { store, released, run, inspect } = shared()
    const events: string[] = []
    const Wait = task({
      ...io,
      name: 'neem.wait',
      handler: () =>
        Effect.sync(() => events.push('started')).pipe(
          Effect.andThen(Effect.never),
          Effect.onInterrupt(() =>
            Effect.sync(() => events.push('interrupted')),
          ),
        ),
    })
    released.mockImplementation(() => events.push('released'))
    const runtime = await thread(
      defineWorkflowsWorker({ tasks: [Wait], store }),
      execution,
    )
    await runtime.start()
    const started = await run(Client.start(Wait, 'a'))
    await eventually(() => (events.includes('started') ? true : undefined))

    await runtime.stop()

    await expect(runtime.finished).resolves.toBeUndefined()
    // The store outlives the handlers: the command is given back through it.
    expect(events).toStrictEqual(['started', 'interrupted', 'released'])
    // Uncounted and unclaimed: another worker takes it at once.
    expect(inspect.queue()).toMatchObject([
      { command: { kind: 'runTask', runId: started.id }, deliveries: 0 },
    ])
    expect(inspect.queue()[0]!.claim).toBeUndefined()
    expect((await run(Client.get(started.id)))!.run.status).toBe('running')
  })

  it('fails when a handler outlives its cleanup, keeping the services it may still use', async () => {
    const { store, released, run } = shared()
    const withdrawn = vi.fn()
    const Stuck = task({
      ...io,
      name: 'neem.stuck',
      timeout: '20ms',
      handler: () => Effect.uninterruptible(Effect.never),
    })
    const runtime = await thread(
      defineWorkflowsWorker({
        tasks: [Stuck],
        store,
        layer: () =>
          Layer.effectDiscard(
            Effect.addFinalizer(() => Effect.sync(withdrawn)),
          ),
      }),
      { ...execution, options: { ...fast, cleanupTimeoutMs: 20 } },
    )
    await runtime.start()
    await run(Client.start(Stuck, 'a'))

    // Before any stop: Neem replaces a thread whose `finished` rejects.
    await expect(runtime.finished).rejects.toStrictEqual(
      new CleanupTimeout({ timeoutMs: 20 }),
    )
    expect(released).not.toHaveBeenCalled()
    expect(withdrawn).not.toHaveBeenCalled()
  })

  it('keeps its services when it is stopped over a handler that outlives its cleanup', async () => {
    const { store, released, run } = shared()
    const withdrawn = vi.fn()
    let started = false
    const Stuck = task({
      ...io,
      name: 'neem.stuck',
      handler: () =>
        Effect.uninterruptible(
          Effect.andThen(
            Effect.sync(() => (started = true)),
            Effect.never,
          ),
        ),
    })
    const runtime = await thread(
      defineWorkflowsWorker({
        tasks: [Stuck],
        store,
        layer: () =>
          Layer.effectDiscard(
            Effect.addFinalizer(() => Effect.sync(withdrawn)),
          ),
      }),
      { ...execution, options: { ...fast, cleanupTimeoutMs: 20 } },
    )
    await runtime.start()
    await run(Client.start(Stuck, 'a'))
    await eventually(() => started || undefined)

    // The stop is over, and was not a clean one: the handler is still
    // there, and so is everything it may use.
    await runtime.stop().catch(() => {})
    await expect(runtime.finished).rejects.toBeDefined()
    expect(released).not.toHaveBeenCalled()
    expect(withdrawn).not.toHaveBeenCalled()
  })

  it('fails with what its store failed it with, and releases its services', async () => {
    const { store, released } = shared()
    const failure = new Error('claim failed')
    let broken = false
    const runtime = await thread(
      defineWorkflowsWorker({
        store: () =>
          Layer.effect(
            Store,
            Effect.map(Effect.service(Store), (inner) =>
              Store.of({
                ...inner,
                claim: (options) =>
                  broken ? Effect.die(failure) : inner.claim(options),
              }),
            ),
          ).pipe(Layer.provide(store())),
      }),
      coordinator,
    )
    await runtime.start()
    broken = true

    await expect(runtime.finished).rejects.toBe(failure)
    expect(released).toHaveBeenCalledOnce()
  })

  it('releases what a start that is stopped had acquired', async () => {
    const { store, acquired, released } = shared()
    const runtime = await thread(
      defineWorkflowsWorker({
        // Never built: the thread is stopped while it starts.
        store: () => Layer.merge(store(), Layer.effectDiscard(Effect.never)),
      }),
      coordinator,
    )
    const starting = runtime.start()
    await eventually(() => (acquired.mock.calls.length > 0 ? true : undefined))

    await runtime.stop()

    await expect(starting).rejects.toThrow('stopped before readiness')
    await expect(runtime.finished).resolves.toBeUndefined()
    expect(released).toHaveBeenCalledOnce()
  })

  it('sends what Effect logs through the worker`s logger', async () => {
    const { store, run } = shared()
    const { calls, logger: log } = logger()
    const failure = new Error('disk full')
    const Report = task({
      ...io,
      name: 'neem.report',
      handler: (text) =>
        Effect.gen(function* () {
          yield* Effect.logWarning('low', { free: 3 }).pipe(
            Effect.annotateLogs({ volume: text }),
          )
          yield* Effect.logError('write failed', Cause.fail(failure))
          yield* Effect.logDebug('below the minimum level')
          return text
        }),
    })
    const runtime = await thread(
      defineWorkflowsWorker({ tasks: [Report], store }),
      execution,
      log,
    )
    await runtime.start()
    const started = await run(Client.start(Report, 'a'))
    await eventually(async () =>
      (await run(Client.get(started.id)))?.run.status === 'completed'
        ? true
        : undefined,
    )

    expect(calls.warn.mock.calls).toStrictEqual([
      [{ volume: 'a' }, 'low {"free":3}'],
    ])
    expect(calls.error.mock.calls).toStrictEqual([
      [{ err: failure }, 'write failed'],
    ])
    expect(calls.debug).not.toHaveBeenCalled()
  })
})

describe('what a worker definition must provide', () => {
  class Mailer extends Context.Service<
    Mailer,
    { readonly send: (to: string) => Effect.Effect<string> }
  >()('neem/Mailer') {}
  const mailer = Layer.succeed(Mailer, { send: (to) => Effect.succeed(to) })
  const store = () => InMemory.layer()

  const Plain = task({
    ...io,
    name: 'neem.plain',
    handler: (text) => Effect.succeed(text),
  })
  // Starting a run from a handler takes the store the worker already has.
  const Chained = task({
    ...io,
    name: 'neem.chained',
    handler: (text) => Effect.as(Client.start(Plain, text), text),
  })
  const Mailed = workflow(
    { ...io, name: 'neem.mailed', pool: 'mail' },
    function* (w) {
      return yield* w.activity('send', {
        input: Schema.String,
        output: Schema.String,
        from: w.input,
        handler: (to) => Effect.flatMap(Mailer, (mailer) => mailer.send(to)),
      })
    },
  )

  it('is the services of every handler it serves, an activity`s among them', () => {
    defineWorkflowsWorker({ tasks: [Plain, Chained], store })
    defineWorkflowsWorker({ ...billing, store, layer: () => payments })
    defineWorkflowsWorker({
      ...billing,
      workflows: [...billing.workflows, Mailed],
      store,
      layer: () => Layer.merge(payments, mailer),
    })
    // A layer may be built on the store, as a handler may use it.
    defineWorkflowsWorker({
      workflows: [Mailed],
      store,
      layer: () =>
        Layer.effect(
          Mailer,
          Effect.map(Effect.service(Store), () => ({
            send: (to) => Effect.succeed(to),
          })),
        ),
    })

    // @ts-expect-error ChargeCard requires Payments, so a layer is required.
    defineWorkflowsWorker({ ...billing, store })
    defineWorkflowsWorker({
      workflows: [Mailed],
      store,
      // @ts-expect-error Payments is not what Mailed's activity requires.
      layer: () => payments,
    })
    defineWorkflowsWorker({
      ...billing,
      workflows: [...billing.workflows, Mailed],
      store,
      // @ts-expect-error Mailed's activity requires Mailer as well.
      layer: () => payments,
    })
    const billed = Layer.effect(
      Mailer,
      Effect.as(Effect.service(Payments), {
        send: (to: string) => Effect.succeed(to),
      }),
    )
    defineWorkflowsWorker({
      workflows: [Mailed],
      store,
      // @ts-expect-error The layer may require the store and nothing else.
      layer: () => billed,
    })
    // @ts-expect-error A worker is nothing without a store.
    defineWorkflowsWorker({ tasks: [Plain] })

    // A handler's scope is its attempt's, which the worker gives it: a
    // handler that acquires a resource asks no layer for one.
    const Scoped = task({
      ...io,
      name: 'neem.scoped',
      handler: (text) =>
        Effect.acquireRelease(Effect.succeed(text), () => Effect.void),
    })
    defineWorkflowsWorker({ tasks: [Scoped], store })
  })
})
