import type { WorkerOptions } from 'node:worker_threads'
import { Worker } from 'node:worker_threads'

import type {
  NeemManagedWorkerHandle,
  NeemWorkerState,
} from '../../public/runtime.ts'
import { normalizeError } from './utils.ts'

export type NeemManagedWorkerController = {
  getState: () => NeemWorkerState
  markReady: () => void
  markStopped: () => void
  fail: (error: Error) => void
}

export type NeemManagedWorkerHealth = {
  id: string
  name: string
  artifactId: string
  state: NeemWorkerState
  failureCount: number
  restartCount: number
  startedAt?: number
  readyAt?: number
  stoppedAt?: number
  lastError?: Error
}

export type NeemManagedWorkerOptions = {
  id: string
  name: string
  artifactId: string
  entry: URL
  workerData?: unknown
  workerOptions?: Omit<WorkerOptions, 'workerData'>
  startupTimeoutMs?: number
  stopTimeoutMs?: number
  stopMessage?: unknown
  onMessage?: (
    message: unknown,
    controller: NeemManagedWorkerController,
  ) => void | Promise<void>
  onFailure?: (error: Error, worker: NeemManagedWorker) => void | Promise<void>
}

export class NeemManagedWorker implements NeemManagedWorkerHandle {
  readonly id: string
  readonly name: string
  readonly artifactId: string

  private worker: Worker | undefined
  private state: NeemWorkerState = 'idle'
  private failureCount = 0
  private restartCount = 0
  private startedAt: number | undefined
  private readyAt: number | undefined
  private stoppedAt: number | undefined
  private lastError: Error | undefined
  private readyResolve: (() => void) | undefined
  private readyReject: ((error: Error) => void) | undefined
  private readyPromise: Promise<void> | undefined
  private exitResolve: (() => void) | undefined
  private exitPromise: Promise<void> | undefined
  private stopping = false

  constructor(private readonly options: NeemManagedWorkerOptions) {
    this.id = options.id
    this.name = options.name
    this.artifactId = options.artifactId
  }

  getState(): NeemWorkerState {
    return this.state
  }

  getHealth(): NeemManagedWorkerHealth {
    return {
      id: this.id,
      name: this.name,
      artifactId: this.artifactId,
      state: this.state,
      failureCount: this.failureCount,
      restartCount: this.restartCount,
      startedAt: this.startedAt,
      readyAt: this.readyAt,
      stoppedAt: this.stoppedAt,
      lastError: this.lastError,
    }
  }

  start(): Promise<void> {
    if (this.state === 'ready') return Promise.resolve()
    if (this.readyPromise) return this.readyPromise
    if (this.worker) {
      throw new Error(`Worker [${this.name}] already started`)
    }

    this.state = 'starting'
    this.stopping = false
    this.startedAt = Date.now()
    this.readyAt = undefined
    this.stoppedAt = undefined
    this.lastError = undefined
    this.worker = new Worker(this.options.entry, {
      ...(this.options.workerOptions ?? {}),
      workerData: this.options.workerData,
    })
    this.exitPromise = new Promise<void>((resolve) => {
      this.exitResolve = resolve
    })

    const startupTimeout = setTimeout(() => {
      this.fail(
        new Error(
          `Worker [${this.name}] did not become ready within ${this.startupTimeoutMs()}ms`,
        ),
      )
      void this.terminateAfterFailure()
    }, this.startupTimeoutMs())

    this.worker.on('message', (message) => {
      void this.handleMessage(message)
    })
    this.worker.on('error', (error) => {
      this.fail(error)
    })
    this.worker.on('exit', (code) => {
      this.handleExit(code)
    })

    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve
      this.readyReject = reject
    }).finally(() => {
      clearTimeout(startupTimeout)
      this.readyPromise = undefined
    })

    return this.readyPromise
  }

  async restart(): Promise<void> {
    this.restartCount += 1
    await this.stop()
    return this.start()
  }

  send(message: unknown): void {
    if (!this.worker) {
      throw new Error(`Worker [${this.name}] is not started`)
    }

    this.worker.postMessage(message)
  }

  async stop(): Promise<void> {
    if (!this.worker || this.state === 'stopped') {
      this.state = 'stopped'
      this.stoppedAt = Date.now()
      return
    }

    this.stopping = true
    this.state = 'stopping'
    this.readyReject?.(new Error(`Worker [${this.name}] stopped before ready`))
    this.clearReadyHandlers()

    try {
      this.worker.postMessage(this.options.stopMessage ?? { type: 'stop' })
    } catch {}

    try {
      await Promise.race([this.exitPromise, this.stopTimeout()])
    } finally {
      await this.terminateWorker()
      this.worker = undefined
      this.state = 'stopped'
      this.stoppedAt = Date.now()
      this.exitResolve = undefined
      this.exitPromise = undefined
    }
  }

  private get controller(): NeemManagedWorkerController {
    return {
      getState: () => this.getState(),
      markReady: () => this.markReady(),
      markStopped: () => this.markStopped(),
      fail: (error) => this.fail(error),
    }
  }

  private async handleMessage(message: unknown): Promise<void> {
    try {
      await this.options.onMessage?.(message, this.controller)
    } catch (error) {
      this.fail(normalizeError(error))
    }
  }

  private markReady(): void {
    if (this.state !== 'starting') return
    this.state = 'ready'
    this.readyAt = Date.now()
    this.readyResolve?.()
    this.clearReadyHandlers()
  }

  private markStopped(): void {
    if (this.state === 'stopping' || this.state === 'ready') {
      this.state = 'stopped'
      this.stoppedAt = Date.now()
    }
  }

  private fail(error: Error): void {
    if (this.state === 'failed' || this.state === 'stopped') return

    this.failureCount += 1
    this.lastError = error

    if (this.state === 'starting') {
      this.state = 'failed'
      this.readyReject?.(error)
      this.clearReadyHandlers()
      return
    }

    if (this.stopping || this.state === 'stopping') return

    this.state = 'failed'
    void this.options.onFailure?.(error, this)
  }

  private handleExit(code: number): void {
    this.exitResolve?.()

    if (this.stopping || this.state === 'stopped') {
      this.state = 'stopped'
      this.stoppedAt = Date.now()
      return
    }

    if (this.state === 'failed') return

    this.fail(new Error(`Worker [${this.name}] exited with code [${code}]`))
  }

  private async terminateAfterFailure(): Promise<void> {
    await this.terminateWorker()
    this.worker = undefined
    this.exitResolve = undefined
    this.exitPromise = undefined
  }

  private async terminateWorker(): Promise<void> {
    if (!this.worker) return
    await this.worker.terminate().catch(() => undefined)
  }

  private stopTimeout(): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, this.options.stopTimeoutMs ?? 5_000)
    })
  }

  private startupTimeoutMs(): number {
    return this.options.startupTimeoutMs ?? 30_000
  }

  private clearReadyHandlers(): void {
    this.readyResolve = undefined
    this.readyReject = undefined
  }
}
