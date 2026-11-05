import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import { afterEach, describe, expect, it } from 'vitest'

import { serve, type Host } from '../../../src/host.ts'
import { createHostHooks } from '../../../src/internal/hooks.ts'
import { Deadline } from '../../../src/internal/lifetime.ts'
import { createTempDir } from '../../support/temp.ts'
import { createSupervisor, listenToWorkers } from './support/runtime.ts'

let workers: ReturnType<typeof listenToWorkers>
afterEach(() => workers?.close())

describe('RuntimeSupervisor', () => {
  it('releases a scoped host when its consumer fails', async () => {
    workers = listenToWorkers()
    const { snapshot } = createSupervisor({ plan: [{ id: 'scoped' }] })
    let host: Host | undefined
    const failure = new Error('consumer failed')
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          host = yield* serve(snapshot)
          expect(host.getHealth().ready).toBe(true)
          return yield* Effect.fail(failure)
        }),
      ),
    )
    expect(exit._tag).toBe('Failure')
    expect(host?.getSnapshot().state).toBe('stopped')
    expect(workers.events).toContain('scoped:stop')
  })

  it('releases late acquisitions when a scoped host is interrupted during startup', async () => {
    workers = listenToWorkers()
    const { snapshot } = createSupervisor({
      plan: [{ id: 'scoped-late', createDelayMs: 300 }],
    })
    const serving = Effect.runFork(Effect.scoped(serve(snapshot)))
    await workers.waitFor('scoped-late:create')
    await Effect.runPromise(Fiber.interrupt(serving))
    expect(workers.events).toEqual([
      'scoped-late:create',
      'scoped-late:created',
      'scoped-late:stop',
    ])
  })

  it('stops a generation whose start it interrupted, including a runtime created afterwards', async () => {
    workers = listenToWorkers()
    const { supervisor, registry } = createSupervisor({
      plan: [{ id: 'slow', createDelayMs: 300 }],
    })
    const starting = Effect.runFork(supervisor.start())
    await workers.waitFor('slow:create')
    await Effect.runPromise(Fiber.interrupt(starting))

    const errors = await Effect.runPromise(
      supervisor.stop(Deadline.after(5_000)),
    )
    expect(errors).toEqual([])
    // The factory finished after the stop began; its runtime was still stopped
    // before the thread exited, and never started.
    expect(workers.events).toEqual(['slow:create', 'slow:created', 'slow:stop'])
    expect(registry.size).toBe(0)
    expect(supervisor.getState()).toBe('stopped')
  })

  it('shares the first stop deadline and terminates a worker that misses it', async () => {
    workers = listenToWorkers()
    const { supervisor, registry } = createSupervisor({
      plan: [{ id: 'stuck', stop: 'block' }, { id: 'clean' }],
    })
    await Effect.runPromise(supervisor.start())

    const startedAt = Date.now()
    const deadline = Deadline.after(400)
    const [first, second] = await Promise.all([
      Effect.runPromise(supervisor.stop(deadline)),
      // A later stop joins the first; it cannot extend the deadline.
      Effect.runPromise(supervisor.stop(Deadline.after(10_000))),
    ])
    const elapsed = Date.now() - startedAt
    expect(elapsed).toBeGreaterThanOrEqual(350)
    expect(elapsed).toBeLessThan(2_000)
    expect(first[0]?.message).toMatch(
      /^Worker \[app:0\] did not stop within \d+ms and was terminated$/,
    )
    // The runner shuts down after the threads, with little or no budget left.
    expect(first.slice(1).map((error) => error.message)).not.toContainEqual(
      expect.stringContaining('Worker [app:1]'),
    )
    expect(second).toEqual(first)
    expect(workers.events).toContain('clean:stop')
    expect(registry.size).toBe(0)
  })

  it('has a worker report a runtime stop that outlives its exit budget', async () => {
    workers = listenToWorkers()
    const { supervisor, registry } = createSupervisor({
      plan: [{ id: 'hanging', stop: 'hang' }],
    })
    await Effect.runPromise(supervisor.start())

    const errors = await Effect.runPromise(supervisor.stop(Deadline.after(600)))
    // The worker gave up within its own budget and said why, before the host
    // had to terminate it.
    expect(errors.map((error) => error.message)).toEqual([
      'Worker [app:0] runtime error: Neem runtime stop did not finish within the stop budget',
    ])
    expect(registry.size).toBe(0)
  })

  it('fails a stop with the error a worker reports on its way out', async () => {
    workers = listenToWorkers()
    const { supervisor } = createSupervisor({
      plan: [{ id: 'broken', stop: 'throw' }],
    })
    await Effect.runPromise(supervisor.start())

    const errors = await Effect.runPromise(
      supervisor.stop(Deadline.after(5_000)),
    )
    expect(errors.map((error) => error.message)).toEqual([
      'Worker [app:0] runtime error: stop failed broken',
    ])
  })

  it('recovers once and ignores what the replaced generation reports while it stops', async () => {
    workers = listenToWorkers()
    const marker = join(await createTempDir('neem-recovery-'), 'crash')
    writeFileSync(marker, '')
    const { supervisor, failures, recovered } = createSupervisor({
      // The sibling's failing stop happens while its generation is replaced.
      plan: [
        { id: 'crashing', crashOnceFile: marker },
        { id: 'sibling', stop: 'throw' },
      ],
      recoveryAttempts: 2,
    })
    await Effect.runPromise(supervisor.start())
    workers.crash('crashing')

    const until = Date.now() + 10_000
    while (recovered() === 0 && Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(recovered()).toBe(1)
    expect(supervisor.getState()).toBe('ready')
    expect(failures).toEqual([])
    expect(
      workers.events.filter((event) => event === 'sibling:start'),
    ).toHaveLength(2)

    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(recovered()).toBe(1)
    expect(supervisor.getState()).toBe('ready')
    // The current generation's sibling still throws on stop.
    const errors = await Effect.runPromise(
      supervisor.stop(Deadline.after(5_000)),
    )
    expect(errors).toHaveLength(1)
  })

  it('reports a runtime unready while a patch is in flight, also when the patch is rejected', async () => {
    const readiness: boolean[] = []
    const { supervisor } = createSupervisor({
      plan: [{ id: 'patched' }],
      onStateChange: () => readiness.push(supervisor.getHealth().ready),
    })
    await Effect.runPromise(supervisor.start())
    expect(supervisor.getHealth().ready).toBe(true)
    readiness.length = 0

    // The fixture worker has no patch client, so the worker rejects the patch.
    const [thread] = supervisor.listThreads()
    const result = await Effect.runPromise(
      supervisor.applyPatch([
        {
          clientId: thread!.id,
          update: {
            type: 'Patch',
            filename: 'patch.js',
            seq: 1,
            changedIds: [],
          },
        },
      ]),
    )
    expect(result).toMatchObject({ outcome: 'rejected' })
    expect(readiness).toEqual([false, true])
    expect(supervisor.getState()).toBe('ready')
    expect(supervisor.getHealth().ready).toBe(true)
  })

  it('fails the runtime when preparing every recovery attempt fails', async () => {
    workers = listenToWorkers()
    const marker = join(await createTempDir('neem-recovery-'), 'crash')
    writeFileSync(marker, '')
    let prepared = 0
    const { supervisor, failures, recovered } = createSupervisor({
      plan: [{ id: 'crashing', crashOnceFile: marker }],
      recoveryAttempts: 2,
      prepareRecovery: async () => {
        prepared++
        throw new Error('output refresh failed')
      },
    })
    await Effect.runPromise(supervisor.start())
    workers.crash('crashing')

    const until = Date.now() + 10_000
    while (failures.length === 0 && Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(prepared).toBe(2)
    expect(recovered()).toBe(0)
    expect(failures.map((error) => error.message)).toEqual([
      'output refresh failed',
    ])
    expect(supervisor.getState()).toBe('failed')
    expect(
      await Effect.runPromise(supervisor.stop(Deadline.after(5_000))),
    ).toEqual([])
  })

  it('withdraws surviving routes before it stops their threads', async () => {
    workers = listenToWorkers()
    const marker = join(await createTempDir('neem-withdraw-'), 'crash')
    writeFileSync(marker, '')
    // What routing would publish at each change, and how many native workers
    // (threads and host runner) were still running then.
    const published: { routes: number; running: number }[] = []
    const harness = createSupervisor({
      plan: [
        {
          id: 'crashing',
          crashOnceFile: marker,
          upstream: 'http://127.0.0.1:1',
        },
        { id: 'sibling', upstream: 'http://127.0.0.1:2' },
      ],
      recoveryAttempts: 1,
      onUpstreamsChange: () => {
        published.push({
          routes: harness.supervisor.getUpstreams().length,
          running: harness.registry.size,
        })
      },
    })
    const { supervisor, recovered } = harness
    await Effect.runPromise(supervisor.start())
    workers.crash('crashing')

    const until = Date.now() + 10_000
    while (recovered() === 0 && Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(recovered()).toBe(1)
    // The replaced generation's sibling left routing while it still ran.
    const withdrawal = published.find(({ routes }) => routes === 0)
    expect(withdrawal?.running).toBeGreaterThan(0)

    published.length = 0
    await Effect.runPromise(supervisor.stop(Deadline.after(5_000)))
    expect(published[0]).toEqual({ routes: 0, running: 3 })
  })

  it('stops its threads although withdrawing their routes never finishes', async () => {
    workers = listenToWorkers()
    const { supervisor, registry } = createSupervisor({
      plan: [{ id: 'unrouted', upstream: 'http://127.0.0.1:1' }],
      // A native proxy mutation cannot be interrupted.
      onUpstreamsChange: () => Effect.uninterruptible(Effect.never),
    })
    await Effect.runPromise(supervisor.start())

    const errors = await Effect.runPromise(
      supervisor.stop(Deadline.after(1_000)),
    )
    expect(errors).toEqual([])
    expect(workers.events).toContain('unrouted:stop')
    expect(registry.size).toBe(0)
  })

  it('stops a recovery whose route withdrawal never finishes, and its sibling cleanly', async () => {
    workers = listenToWorkers()
    const marker = join(await createTempDir('neem-stuck-recovery-'), 'crash')
    writeFileSync(marker, '')
    let stuck = false
    const { supervisor, registry } = createSupervisor({
      plan: [
        {
          id: 'crashing',
          crashOnceFile: marker,
          upstream: 'http://127.0.0.1:1',
        },
        { id: 'sibling', upstream: 'http://127.0.0.1:2' },
      ],
      recoveryAttempts: 1,
      // Every update after the crash hangs, like a stuck native mutation.
      onUpstreamsChange: () =>
        stuck ? Effect.uninterruptible(Effect.never) : undefined,
    })
    await Effect.runPromise(supervisor.start())
    stuck = true
    workers.crash('crashing')
    const until = Date.now() + 10_000
    while (supervisor.getState() !== 'recovering' && Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }

    const errors = await Effect.runPromise(
      supervisor.stop(Deadline.after(2_000)),
    )
    expect(errors).toEqual([])
    expect(workers.events).toContain('sibling:stop')
    expect(registry.size).toBe(0)
  })

  it('recovers although a fail hook never settles', async () => {
    workers = listenToWorkers()
    const marker = join(await createTempDir('neem-fail-hook-'), 'crash')
    writeFileSync(marker, '')
    const hooks = createHostHooks()
    hooks.hook('runtime:fail', () => new Promise<void>(() => {}))
    const { supervisor, recovered } = createSupervisor({
      plan: [{ id: 'crashing', crashOnceFile: marker }],
      recoveryAttempts: 1,
      hooks,
      hookTimeout: 100,
    })
    await Effect.runPromise(supervisor.start())
    workers.crash('crashing')

    const until = Date.now() + 10_000
    while (recovered() === 0 && Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(recovered()).toBe(1)
    expect(supervisor.getState()).toBe('ready')
  })

  it('leaves threads time to stop when the runtime host stop hangs', async () => {
    workers = listenToWorkers()
    const { supervisor, registry } = createSupervisor({
      plan: [{ id: 'drained' }],
      hostStop: 'hang',
    })
    await Effect.runPromise(supervisor.start())

    const errors = await Effect.runPromise(
      supervisor.stop(Deadline.after(1_000)),
    )
    // The host spent its half of the budget; the thread still stopped itself.
    expect(errors.map((error) => error.message)).toEqual([
      expect.stringMatching(/request \[stop\] timed out after \d+ms$/),
    ])
    expect(workers.events).toContain('drained:stop')
    expect(registry.size).toBe(0)
  })
})
