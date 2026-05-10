import { describe, expect, it } from 'vitest'

import type { NeemWorkerState } from '../../../packages/neem/src/public/runtime.ts'
import { NeemWorkerPool } from '../../../packages/neem/src/internal/runtime/worker-pool.ts'

describe('NeemWorkerPool', () => {
  it('starts and stops all workers as one unit', async () => {
    const workers = [new FakeWorker('one'), new FakeWorker('two')]
    const pool = new NeemWorkerPool({ name: 'test-pool', workers })

    expect(pool.getState()).toBe('idle')
    await pool.start()

    expect(pool.getState()).toBe('ready')
    expect(pool.getHealth()).toMatchObject({
      name: 'test-pool',
      size: 2,
      ready: 2,
      failed: 0,
      state: 'ready',
    })
    expect(workers.map((worker) => worker.starts)).toEqual([1, 1])

    await pool.stop()

    expect(pool.getState()).toBe('stopped')
    expect(pool.getHealth()).toMatchObject({ stopped: 2, state: 'stopped' })
    expect(workers.map((worker) => worker.stops)).toEqual([1, 1])
  })

  it('reports degraded aggregate state when only some workers fail', async () => {
    const workers = [
      new FakeWorker('one'),
      new FakeWorker('two', { failStart: true }),
    ]
    const pool = new NeemWorkerPool({ name: 'test-pool', workers })

    await expect(pool.start()).rejects.toThrow('fixture worker start failure')

    expect(pool.getState()).toBe('degraded')
    expect(pool.getHealth()).toMatchObject({
      ready: 1,
      failed: 1,
      state: 'degraded',
    })
  })

  it('restarts the pool by stopping before starting again', async () => {
    const workers = [new FakeWorker('one'), new FakeWorker('two')]
    const pool = new NeemWorkerPool({ name: 'test-pool', workers })

    await pool.start()
    await pool.restart()

    expect(pool.getState()).toBe('ready')
    expect(workers.map((worker) => worker.starts)).toEqual([2, 2])
    expect(workers.map((worker) => worker.stops)).toEqual([1, 1])
  })
})

class FakeWorker {
  readonly id: string
  readonly name: string
  starts = 0
  stops = 0

  private state: NeemWorkerState = 'idle'

  constructor(
    id: string,
    private readonly options: { failStart?: boolean } = {},
  ) {
    this.id = id
    this.name = id
  }

  getState(): NeemWorkerState {
    return this.state
  }

  async start(): Promise<void> {
    this.starts += 1
    this.state = 'starting'
    if (this.options.failStart) {
      this.state = 'failed'
      throw new Error('fixture worker start failure')
    }
    this.state = 'ready'
  }

  async stop(): Promise<void> {
    this.stops += 1
    this.state = 'stopped'
  }
}
