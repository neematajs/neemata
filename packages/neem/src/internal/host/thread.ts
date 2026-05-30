import type { MessagePort as NodeMessagePort } from 'node:worker_threads'
import { MessageChannel, Worker } from 'node:worker_threads'

import type { MaybePromise } from '@nmtjs/common'
import type { Logger } from '@nmtjs/core'
import { createFuture } from '@nmtjs/common'

import type { NeemResolvedArtifact } from '../../public/artifact.ts'
import type {
  NeemManagedWorkerHealth,
  NeemRuntimeThreadHandle,
  NeemRuntimeUpstream,
  NeemStartedRuntimeThreadHealth,
  NeemWorkerState,
} from '../../public/runtime.ts'
import type { RuntimeSnapshot } from '../manifest/snapshot.ts'
import type { HostHooks } from '../plugins/hooks.ts'
import type {
  ErrorMessage,
  RuntimeWorkerData,
  WorkerMessage,
} from '../worker/protocol.ts'
import { callHostHook } from '../plugins/hooks.ts'
import { childLogger, runtimeLabel } from '../shared/logger.ts'
import { normalizeError, wait } from '../shared/utils.ts'

export type ThreadPlan = {
  name: string
  artifact: NeemResolvedArtifact
  data?: unknown
}

export type ThreadControllerOptions = {
  snapshot: RuntimeSnapshot
  runtimeName: string
  plan: ThreadPlan
  index: number
  hooks: HostHooks
  onFailure?: (error: Error, thread: ThreadController) => MaybePromise<void>
}

const STARTUP_TIMEOUT_MS = 30_000
const STOP_TIMEOUT_MS = 5_000

export class ThreadController {
  readonly id: string
  readonly runtimeName: string
  readonly name: string
  readonly artifactId: string
  readonly artifact: NeemResolvedArtifact
  readonly port: NodeMessagePort

  private worker: Worker | undefined
  private state: NeemWorkerState = 'idle'
  private failureCount = 0
  private startedAt: number | undefined
  private readyAt: number | undefined
  private stoppedAt: number | undefined
  private lastError: Error | undefined
  private upstreams: readonly NeemRuntimeUpstream[] = []
  private ready: ReturnType<typeof createFuture<void>> | undefined
  private exited: ReturnType<typeof createFuture<void>> | undefined
  private stopping = false
  private readonly logger: Logger

  constructor(private readonly options: ThreadControllerOptions) {
    const channel = new MessageChannel()
    this.port = channel.port1
    this.runtimeName = options.runtimeName
    this.name = options.plan.name
    this.artifact = options.plan.artifact
    this.artifactId = options.plan.artifact.id
    this.id = `${options.runtimeName}:${options.plan.name}:${options.index}`
    this.logger = childLogger(
      options.snapshot.logger,
      runtimeLabel(options.runtimeName, options.plan.name),
    )
    this.workerData = {
      mode: options.snapshot.mode,
      runtimeName: options.runtimeName,
      name: options.plan.name,
      data: options.plan.data,
      artifact: options.plan.artifact,
      artifacts: options.snapshot.artifacts.list(),
      outDir: options.snapshot.outDir,
      logger: options.snapshot.manifest.config.logger,
      port: channel.port2,
    }
    this.transferPort = channel.port2
  }

  private readonly workerData: RuntimeWorkerData
  private readonly transferPort: NodeMessagePort

  getHandle(): NeemRuntimeThreadHandle {
    return {
      id: this.id,
      name: this.name,
      artifactId: this.artifactId,
      port: this.port,
    }
  }

  getState(): NeemWorkerState {
    return this.state
  }

  getHealth(): NeemStartedRuntimeThreadHealth {
    return {
      ...this.getWorkerHealth(),
      runtimeName: this.runtimeName,
      artifact: this.artifact,
      upstreams: this.upstreams,
    }
  }

  getUpstreams(): readonly NeemRuntimeUpstream[] {
    return this.upstreams
  }

  async start(): Promise<void> {
    if (this.state === 'ready') return
    if (this.worker) throw new Error(`Worker [${this.name}] already started`)

    await this.callWorkerHook('worker:start')
    this.state = 'starting'
    this.stopping = false
    this.startedAt = Date.now()
    this.readyAt = undefined
    this.stoppedAt = undefined
    this.lastError = undefined
    this.logger.trace({ artifactId: this.artifactId }, 'Neem worker starting')

    const ready = createFuture<void>()
    this.ready = ready
    this.exited = createFuture<void>()
    const timer = setTimeout(() => {
      this.fail(
        new Error(
          `Worker [${this.name}] did not become ready within ${STARTUP_TIMEOUT_MS}ms`,
        ),
      )
    }, STARTUP_TIMEOUT_MS)

    this.worker = new Worker(this.options.snapshot.workerEntry, {
      workerData: this.workerData,
      transferList: [this.transferPort],
    })
    this.worker.on('message', (message) => this.handleMessage(message))
    this.worker.on('error', (error) => this.fail(error))
    this.worker.on('exit', (code) => this.handleExit(code))

    try {
      await ready.promise
      await this.callWorkerHook('worker:ready')
      this.logger.trace(
        { upstreams: this.upstreams.length },
        'Neem worker ready',
      )
    } catch (error) {
      const normalized = normalizeError(error)
      await this.callWorkerHook('worker:fail', normalized)
      await this.terminateWorker()
      throw normalized
    } finally {
      clearTimeout(timer)
      this.ready = undefined
    }
  }

  async stop(): Promise<void> {
    const worker = this.worker
    if (!worker || this.state === 'stopped') {
      this.markStopped()
      return
    }

    this.stopping = true
    this.state = 'stopping'
    this.ready?.reject(new Error(`Worker [${this.name}] stopped before ready`))
    this.logger.trace('Neem worker stopping')
    try {
      worker.postMessage({ type: 'stop' })
    } catch {}

    let exited = false
    try {
      if (this.exited) {
        await Promise.race([
          this.exited.promise.then(() => {
            exited = true
          }),
          wait(STOP_TIMEOUT_MS),
        ])
      }
    } finally {
      if (!exited) {
        this.logger.warn('Neem worker stop timed out; terminating worker')
        await this.terminateWorker()
      }
      this.worker = undefined
      this.exited = undefined
      try {
        this.port.close()
      } catch {}
      this.upstreams = []
      this.markStopped()
      await this.callWorkerHook('worker:stop')
      this.logger.trace('Neem worker stopped')
    }
  }

  private handleMessage(message: WorkerMessage): void {
    if (message.type === 'ready') {
      this.upstreams = message.data.upstreams ?? []
      this.markReady()
      return
    }

    if (message.type === 'error') {
      this.fail(deserializeWorkerError(message.data))
      return
    }

    if (message.type === 'stopped') this.markStopped()
  }

  private handleExit(code: number): void {
    this.exited?.resolve()
    if (this.stopping || this.state === 'stopped') {
      this.markStopped()
      return
    }

    if (this.state === 'failed') return
    this.fail(new Error(`Worker [${this.name}] exited with code [${code}]`))
  }

  private markReady(): void {
    if (this.state !== 'starting') return
    this.state = 'ready'
    this.readyAt = Date.now()
    this.ready?.resolve()
  }

  private markStopped(): void {
    this.state = 'stopped'
    this.stoppedAt = Date.now()
  }

  private fail(error: Error): void {
    if (this.state === 'failed' || this.state === 'stopped') return

    this.failureCount += 1
    this.lastError = error
    this.state = 'failed'
    this.logger.error({ err: error }, 'Neem worker failed')

    if (this.ready) {
      this.ready.reject(error)
      return
    }

    void this.callWorkerHook('worker:fail', error)
    void this.options.onFailure?.(error, this)
  }

  private getWorkerHealth(): NeemManagedWorkerHealth {
    return {
      id: this.id,
      name: this.name,
      artifactId: this.artifactId,
      state: this.state,
      failureCount: this.failureCount,
      startedAt: this.startedAt,
      readyAt: this.readyAt,
      stoppedAt: this.stoppedAt,
      lastError: this.lastError,
    }
  }

  private callWorkerHook(
    name: 'worker:start' | 'worker:ready' | 'worker:stop',
  ): Promise<void>
  private callWorkerHook(name: 'worker:fail', error: Error): Promise<void>
  private callWorkerHook(
    name: 'worker:start' | 'worker:ready' | 'worker:stop' | 'worker:fail',
    error?: Error,
  ): Promise<void> {
    return callHostHook(
      this.options.hooks,
      this.options.snapshot.logger,
      name,
      {
        mode: this.options.snapshot.mode,
        id: this.id,
        name: this.name,
        artifactId: this.artifactId,
        owner: this.artifact.owner,
        error,
      },
    )
  }

  private async terminateWorker(): Promise<void> {
    await this.worker?.terminate().catch(() => undefined)
  }
}

function deserializeWorkerError(data: ErrorMessage['data']): Error {
  const error = new Error(data.message)
  error.name = data.name ?? error.name
  error.stack = data.stack
  return error
}
