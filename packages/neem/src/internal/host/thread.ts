import type { MessagePort as NodeMessagePort } from 'node:worker_threads'
import { MessageChannel, Worker } from 'node:worker_threads'

import type { Future, MaybePromise } from '@nmtjs/common'
import type { Logger } from '@nmtjs/core'
import { createFuture } from '@nmtjs/common'

import type {
  NeemManagedWorkerHealth,
  NeemResolvedArtifact,
  NeemRuntimeThreadHandle,
  NeemRuntimeUpstream,
  NeemStartedRuntimeThreadHealth,
  NeemWorkerState,
} from '../../shared/types.ts'
import type { RuntimeSnapshot } from '../manifest/snapshot.ts'
import type { HostHooks } from '../plugins/hooks.ts'
import type { RuntimeWorkerData, WorkerMessage } from '../worker/protocol.ts'
import { NeemWorkerError } from '../../shared/errors.ts'
import { childLogger, runtimeLabel } from '../logger.ts'
import { callHostHook } from '../plugins/hooks.ts'
import { STOP_TIMEOUT_MS } from '../threads.ts'
import { deserializeError, normalizeError, raceWithTimeout } from '../utils.ts'
import { createRuntimeEnv } from './env.ts'

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

export class ThreadController {
  readonly id: string
  readonly runtimeName: string
  readonly name: string
  readonly artifact: NeemResolvedArtifact
  readonly port: NodeMessagePort

  private readonly workerData: RuntimeWorkerData
  private readonly logger: Logger
  private worker: Worker | undefined
  private state: NeemWorkerState = 'idle'
  private failureCount = 0
  private startedAt: number | undefined
  private readyAt: number | undefined
  private stoppedAt: number | undefined
  private lastError: Error | undefined
  private upstreams: readonly NeemRuntimeUpstream[] = []
  // Held only while startup can still be settled; fail() uses its presence to
  // decide between rejecting start() and reporting a post-ready failure.
  private startup: Future<void> | undefined
  private exited: Future<void> | undefined

  constructor(private readonly options: ThreadControllerOptions) {
    const channel = new MessageChannel()
    this.port = channel.port1
    this.runtimeName = options.runtimeName
    this.name = options.plan.name
    this.artifact = options.plan.artifact
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
      outDir: options.snapshot.outDir,
      logger: options.snapshot.manifest.config.logger,
      port: channel.port2,
    }
  }

  getHandle(): NeemRuntimeThreadHandle {
    return { name: this.name, port: this.port }
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

  // Single use: stop() closes port1 and port2 is transferred on the first
  // spawn, so a stopped controller can never be started again.
  async start(): Promise<void> {
    if (this.state !== 'idle') {
      throw new Error(`Worker [${this.name}] already started`)
    }

    await this.callWorkerHook('worker:start')
    // stop() may run while a startup hook is still pending.
    if (this.state !== 'idle') return
    this.state = 'starting'
    this.startedAt = Date.now()
    this.logger.trace({ artifactId: this.artifact.id }, 'Neem worker starting')

    const startup = createFuture<void>()
    this.startup = startup
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
      transferList: [this.workerData.port],
      env: createRuntimeEnv({
        manifest: this.options.snapshot.manifest,
        runtimeName: this.runtimeName,
        overrideEnv: this.options.snapshot.env,
      }),
    })
    this.worker.on('message', (message) => this.handleMessage(message))
    this.worker.on('error', (error) => this.fail(error))
    this.worker.on('exit', (code) => this.handleExit(code))

    try {
      await startup.promise
      await this.callWorkerHook('worker:ready')
      // Read through getState(): the worker event handlers move the state
      // while start() awaits, which narrowing here cannot see.
      if (this.getState() === 'failed' && this.lastError) throw this.lastError
      this.logger.trace(
        { upstreams: this.upstreams.length },
        'Neem worker ready',
      )
    } catch (error) {
      const normalized = normalizeError(error)
      const failed = this.getState() === 'failed'
      // fail() already reported a failure that arrived after worker:ready.
      const reported = failed && this.readyAt !== undefined
      if (!failed) this.markFailed(normalized)
      if (!reported) await this.callWorkerFailHook(normalized)
      await this.terminateWorker()
      throw normalized
    } finally {
      clearTimeout(timer)
    }
  }

  async stop(): Promise<void> {
    const worker = this.worker
    const done = !worker || this.state === 'stopped'
    this.state = 'stopping'
    if (done) {
      this.markStopped()
      return
    }

    const startup = this.startup
    this.startup = undefined
    startup?.reject(new Error(`Worker [${this.name}] stopped before ready`))
    this.logger.trace('Neem worker stopping')
    try {
      worker.postMessage({ type: 'stop' })
    } catch {
      // The worker may already be gone; the exit race below settles either way.
    }

    let exited = false
    try {
      if (this.exited) {
        const result = await raceWithTimeout(
          this.exited.promise,
          STOP_TIMEOUT_MS,
        )
        exited = !result.timedOut
      }
    } finally {
      if (!exited) {
        this.logger.warn('Neem worker stop timed out; terminating worker')
        await this.terminateWorker()
      }
      this.worker = undefined
      this.exited = undefined
      this.port.close()
      this.upstreams = []
      this.markStopped()
      await this.callWorkerHook('worker:stop')
      this.logger.trace('Neem worker stopped')
    }
  }

  private handleMessage(message: WorkerMessage): void {
    if (message.type === 'ready') {
      this.upstreams = message.data.upstreams
      this.markReady()
      return
    }

    if (message.type === 'error') {
      this.fail(
        new NeemWorkerError({
          worker: this.name,
          origin: message.data.origin,
          cause: deserializeError(message.data),
        }),
      )
      return
    }

    if (message.type === 'stopped') this.markStopped()
  }

  private handleExit(code: number): void {
    this.exited?.resolve()
    if (this.state === 'stopping' || this.state === 'stopped') {
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
    const startup = this.startup
    this.startup = undefined
    startup?.resolve()
  }

  private markStopped(): void {
    this.state = 'stopped'
    this.stoppedAt = Date.now()
  }

  private fail(error: Error): void {
    if (this.state === 'failed' || this.state === 'stopped') return

    this.markFailed(error)

    const startup = this.startup
    if (startup) {
      this.startup = undefined
      startup.reject(error)
      return
    }

    void this.callWorkerFailHook(error)
    void this.options.onFailure?.(error, this)
  }

  private markFailed(error: Error): void {
    this.failureCount += 1
    this.lastError = error
    this.state = 'failed'
    this.logger.error({ err: error }, 'Neem worker failed')
  }

  private getWorkerHealth(): NeemManagedWorkerHealth {
    return {
      id: this.id,
      name: this.name,
      artifactId: this.artifact.id,
      state: this.state,
      failureCount: this.failureCount,
      startedAt: this.startedAt,
      readyAt: this.readyAt,
      stoppedAt: this.stoppedAt,
      lastError: this.lastError,
    }
  }

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
        artifactId: this.artifact.id,
        owner: this.artifact.owner,
        error,
      },
    )
  }

  private async callWorkerFailHook(error: Error): Promise<void> {
    await this.callWorkerHook('worker:fail', error).catch((hookError) => {
      this.logger.warn(
        new Error('Neem worker fail hook failed', {
          cause: normalizeError(hookError),
        }),
      )
    })
  }

  private async terminateWorker(): Promise<void> {
    await this.worker?.terminate().catch(() => undefined)
  }
}
