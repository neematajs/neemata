import type { NeemWorkerState } from '../../public/runtime.ts'

export type NeemPoolWorker = {
  id?: string
  name?: string
  getState: () => NeemWorkerState
  start: () => Promise<void>
  stop: () => Promise<void>
}

export type NeemWorkerPoolState =
  | 'idle'
  | 'starting'
  | 'ready'
  | 'degraded'
  | 'stopping'
  | 'stopped'
  | 'failed'

export type NeemWorkerPoolHealth = {
  name: string
  state: NeemWorkerPoolState
  size: number
  ready: number
  failed: number
  stopped: number
  starting: number
}

export type NeemWorkerPoolOptions<TWorker extends NeemPoolWorker> = {
  name: string
  workers: readonly TWorker[]
}

export class NeemWorkerPool<TWorker extends NeemPoolWorker> {
  readonly name: string

  private readonly workers: readonly TWorker[]
  private startPromise: Promise<void> | undefined
  private stopPromise: Promise<void> | undefined

  constructor(options: NeemWorkerPoolOptions<TWorker>) {
    this.name = options.name
    this.workers = [...options.workers]
  }

  list(): readonly TWorker[] {
    return this.workers
  }

  getState(): NeemWorkerPoolState {
    if (this.workers.length === 0) return 'stopped'

    const states = this.workers.map((worker) => worker.getState())
    if (states.every((state) => state === 'idle')) return 'idle'
    if (states.some((state) => state === 'starting')) return 'starting'
    if (states.some((state) => state === 'stopping')) return 'stopping'
    if (states.every((state) => state === 'stopped')) return 'stopped'
    if (states.every((state) => state === 'ready')) return 'ready'
    if (states.some((state) => state === 'ready')) return 'degraded'
    if (states.some((state) => state === 'failed')) return 'failed'
    return 'idle'
  }

  getHealth(): NeemWorkerPoolHealth {
    const states = this.workers.map((worker) => worker.getState())
    return {
      name: this.name,
      state: this.getState(),
      size: this.workers.length,
      ready: states.filter((state) => state === 'ready').length,
      failed: states.filter((state) => state === 'failed').length,
      stopped: states.filter((state) => state === 'stopped').length,
      starting: states.filter((state) => state === 'starting').length,
    }
  }

  start(): Promise<void> {
    this.startPromise ??= Promise.all(
      this.workers.map((worker) => worker.start()),
    )
      .then(() => undefined)
      .finally(() => {
        this.startPromise = undefined
      })
    return this.startPromise
  }

  async restart(): Promise<void> {
    await this.stop()
    return this.start()
  }

  stop(): Promise<void> {
    this.stopPromise ??= Promise.all(
      this.workers.map((worker) => worker.stop()),
    )
      .then(() => undefined)
      .finally(() => {
        this.stopPromise = undefined
      })
    return this.stopPromise
  }
}
