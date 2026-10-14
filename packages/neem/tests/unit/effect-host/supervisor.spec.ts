import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import { afterEach, describe, expect, it } from 'vitest'

import { serve, type Host } from '../../../src/host.ts'
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
})
