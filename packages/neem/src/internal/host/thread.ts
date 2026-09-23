import type { MessagePort as NodeMessagePort } from 'node:worker_threads'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { MessageChannel, Worker } from 'node:worker_threads'

import type { MaybePromise } from '@nmtjs/common'
import type { Logger } from 'pino'
import { createFuture } from '@nmtjs/common'

import type {
  NeemManagedWorkerHealth,
  NeemResolvedArtifact,
  NeemRuntimeThreadHandle,
  NeemRuntimeUpstream,
  NeemStartedRuntimeThreadHealth,
  NeemWorkerState,
} from '../../shared/types.ts'
import type { WorkerUpdate } from '../build/updates.ts'
import type { RuntimeSnapshot } from '../manifest/snapshot.ts'
import type { HostHooks } from '../plugins/hooks.ts'
import type { RpcMessage } from '../rpc.ts'
import type {
  RuntimeWorkerData,
  WorkerCommands,
  WorkerEvent,
  WorkerPatchResult,
} from '../worker/protocol.ts'
import { NeemWorkerError } from '../../shared/errors.ts'
import { childLogger, runtimeLabel } from '../logger.ts'
import { callHostHook } from '../plugins/hooks.ts'
import { isRpcEvent, RpcChannel } from '../rpc.ts'
import { deserializeError, normalizeError, raceWithTimeout } from '../utils.ts'
import { createRuntimeEnv } from './env.ts'
import {
  DEFAULT_STOP_TIMEOUT_MS,
  isOperationAborted,
  OperationScope,
  resolveLifecycle,
} from './lifecycle.ts'

export type ThreadPlan = {
  name: string
  artifact: NeemResolvedArtifact
  data?: unknown
}

export type ThreadLifecycleEvent = {
  type: 'thread-started' | 'thread-stopped'
  runtimeName: string
  threadId: string
}

export type ThreadControllerOptions = {
  onThreadEvent?: (event: ThreadLifecycleEvent) => void
  snapshot: RuntimeSnapshot
  runtimeName: string
  plan: ThreadPlan
  index: number
  hooks: HostHooks
  onFailure?: (error: Error, thread: ThreadController) => MaybePromise<void>
}

const REQUEST_TIMEOUT_MS = 30_000

export class ThreadController {
  readonly id: string
  readonly runtimeName: string
  readonly name: string
  readonly artifactId: string
  readonly artifact: NeemResolvedArtifact
  readonly port: NodeMessagePort

  patches = 0
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
  // The start in flight; stop aborts it and joins it before looking for a worker.
  private starting:
    | { scope: OperationScope; settled: Promise<void> }
    | undefined
  private readonly logger: Logger
  private readonly rpc: RpcChannel<WorkerCommands>

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
      outDir: options.snapshot.outDir,
      logger: options.snapshot.manifest.config.logger,
      port: channel.port2,
      patchClientId: this.id,
    }
    this.transferPort = channel.port2
    this.rpc = new RpcChannel({
      post: (message) => {
        if (!this.worker) {
          throw new Error(`Worker [${this.name}] is not running`)
        }
        this.worker.postMessage(message)
      },
      timeoutMs: () => REQUEST_TIMEOUT_MS,
      timeoutMessage: (type, timeoutMs) =>
        `Worker [${this.name}] ${type === 'patch-update' ? 'patch' : type} timed out after ${timeoutMs}ms`,
    })
  }

  private readonly workerData: RuntimeWorkerData
  private readonly transferPort: NodeMessagePort

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

  async applyPatch(update: WorkerUpdate): Promise<WorkerPatchResult> {
    if (this.state !== 'ready') {
      return {
        outcome: 'rejected',
        delivered: false,
        patches: this.patches,
        reason: `Worker [${this.name}] is not ready`,
      }
    }
    const url =
      update.type === 'Patch'
        ? pathToFileURL(resolve(this.artifact.outDir, update.filename)).href
        : undefined
    const result = await this.rpc.request('patch-update', { update, url })
    this.patches = result.patches
    return result
  }

  /**
   * Fails a ready worker that can no longer serve although its thread still
   * runs, exactly as if it had crashed: the runtime's recovery replaces it.
   */
  reportFailure(error: Error): void {
    this.fail(error)
  }

  /**
   * Resolves once the worker is ready. Rejects with OperationAbortedError when
   * the parent scope or stop() aborts it; stop() then owns the worker.
   */
  start(parent: OperationScope = new OperationScope()): Promise<void> {
    if (this.state === 'ready') return Promise.resolve()
    if (this.worker) {
      return Promise.reject(new Error(`Worker [${this.name}] already started`))
    }
    const scope = parent.child()
    const started = this.runStart(scope).finally(() => scope.dispose())
    this.starting = { scope, settled: started.then(noop, noop) }
    return started
  }

  private async runStart(scope: OperationScope): Promise<void> {
    await scope.wait(this.callWorkerHook('worker:start'))
    const { startTimeout } = resolveLifecycle(
      this.options.snapshot.config.lifecycle,
    )
    this.state = 'starting'
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
          `Worker [${this.name}] did not become ready within ${startTimeout}ms`,
        ),
      )
    }, startTimeout)

    this.worker = new Worker(this.options.snapshot.workerEntry, {
      workerData: this.workerData,
      transferList: [this.transferPort],
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
      await scope.wait(ready.promise)
      await scope.wait(this.callWorkerHook('worker:ready'))
      if (this.getState() === 'failed' && this.lastError) throw this.lastError
      this.logger.trace(
        { upstreams: this.upstreams.length },
        'Neem worker ready',
      )
    } catch (error) {
      // stop() owns its cleanup deadline. An aborted start must not terminate
      // the thread underneath runtime.stop() and its asynchronous finalizers.
      if (isOperationAborted(error)) throw error
      const normalized = normalizeError(error)
      // fail() reports failures after readiness itself; earlier ones only
      // rejected readiness and are reported here.
      const failed = this.getState() === 'failed'
      const reported = failed && this.readyAt !== undefined
      if (!failed) this.markFailed(normalized)
      if (!reported) await this.callWorkerFailHook(normalized)
      await this.terminateWorker()
      throw normalized
    } finally {
      clearTimeout(timer)
      this.ready = undefined
    }
  }

  /**
   * Stops the worker within the scope's deadline. A worker that misses it is
   * terminated and the stop rejects, as it does when the worker reports an
   * error while stopping.
   */
  async stop(
    scope: OperationScope = OperationScope.withTimeout(DEFAULT_STOP_TIMEOUT_MS),
  ): Promise<void> {
    const starting = this.starting
    this.starting = undefined
    starting?.scope.abort()
    // Every wait in an aborted start settles at once, so this join only
    // covers its synchronous tail and a failure cleanup already under way.
    if (starting) await raceWithTimeout(starting.settled, scope.remaining())

    const worker = this.worker
    if (!worker || this.state === 'stopped') {
      this.port.close()
      this.transferPort.close()
      this.markStopped()
      return
    }

    this.state = 'stopping'
    this.logger.trace('Neem worker stopping')
    const budget = scope.remaining()
    // The exit acknowledges the stop; the reply only races it.
    this.rpc.request('stop', {}).catch(() => undefined)

    const exit = this.exited
      ? await raceWithTimeout(this.exited.promise, budget)
      : { timedOut: false as const }
    // fail() records errors the worker reports while stopping instead of
    // treating them as a crash; they fail this stop.
    let error = this.getState() === 'failed' ? this.lastError : undefined
    if (exit.timedOut) {
      this.logger.warn('Neem worker stop timed out; terminating worker')
      await this.terminateWorker()
      error = new Error(
        `Worker [${this.name}] did not stop within ${Math.round(budget)}ms and was terminated`,
      )
    }

    this.worker = undefined
    this.rpc.settleAll(new Error(`Worker [${this.name}] stopped`))
    this.exited = undefined
    this.port.close()
    this.upstreams = []
    this.markStopped()
    await scope
      .within(
        this.callWorkerHook('worker:stop'),
        `Worker [${this.name}] hook [worker:stop]`,
      )
      .catch((hookError) => {
        error ??= normalizeError(hookError)
      })
    this.logger.trace('Neem worker stopped')
    if (error) throw error
  }

  private handleMessage(message: RpcMessage<WorkerEvent>): void {
    if (this.rpc.settle(message)) return
    if (!isRpcEvent<WorkerEvent>(message)) return
    const { event } = message
    if (event.type === 'ready') {
      this.markReady(event.data.upstreams ?? [])
      return
    }

    this.fail(
      new NeemWorkerError({
        worker: this.name,
        origin: event.data.origin,
        cause: deserializeError(event.data),
      }),
    )
  }

  private handleExit(code: number): void {
    this.rpc.settleAll(new Error(`Worker [${this.name}] exited`))
    this.exited?.resolve()
    // Only a worker that announced itself as a patch client leaves as one.
    if (this.readyAt !== undefined) {
      this.options.onThreadEvent?.({
        type: 'thread-stopped',
        runtimeName: this.runtimeName,
        threadId: this.id,
      })
    }
    if (this.state === 'stopping' || this.state === 'stopped') return
    if (this.state === 'failed') return
    this.fail(new Error(`Worker [${this.name}] exited with code [${code}]`))
  }

  private markReady(upstreams: readonly NeemRuntimeUpstream[]): void {
    // A stop may already be under way; its worker must not advertise upstreams.
    if (this.state !== 'starting') return
    this.upstreams = upstreams
    this.state = 'ready'
    this.readyAt = Date.now()
    this.ready?.resolve()
    this.options.onThreadEvent?.({
      type: 'thread-started',
      runtimeName: this.runtimeName,
      threadId: this.id,
    })
  }

  private markStopped(): void {
    this.state = 'stopped'
    this.stoppedAt = Date.now()
  }

  private fail(error: Error): void {
    if (this.state === 'failed' || this.state === 'stopped') return

    this.rpc.settleAll(error)
    const previous = this.state
    this.markFailed(error)
    // stop() owns a stopping worker; the error fails that stop instead.
    if (previous === 'stopping') return
    // Before readiness, start() reports the failure through its rejection.
    if (previous === 'starting') {
      this.ready?.reject(error)
      return
    }

    void this.callWorkerFailHook(error)
    void this.options.onFailure?.(error, this)
  }

  private markFailed(error: Error): void {
    this.failureCount += 1
    this.lastError = error
    this.state = 'failed'
    // Failed workers exit; advertising their upstreams would route traffic to a dead port.
    this.upstreams = []
    this.logger.error({ err: error }, 'Neem worker failed')
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

function noop(): void {}
